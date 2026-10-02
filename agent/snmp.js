'use strict';

/**
 * Minimal SNMP v1/v2c client (GET / GETNEXT walk) over UDP, no dependencies.
 * Used to read toner/ink levels and the page counter from network printers
 * via the standard Printer MIB (RFC 3805).
 */

const dgram = require('dgram');

// ---------------------------------------------------------------
// BER encoding
// ---------------------------------------------------------------
function encLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, value) {
  return Buffer.concat([Buffer.from([tag]), encLength(value.length), value]);
}

function encInt(n) {
  const bytes = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v >>= 8; } while (v !== 0 && v !== -1);
  // Keep the sign bit right.
  if (n >= 0 && bytes[0] & 0x80) bytes.unshift(0);
  if (n < 0 && !(bytes[0] & 0x80)) bytes.unshift(0xff);
  return tlv(0x02, Buffer.from(bytes));
}

function encOid(oid) {
  const parts = oid.split('.').filter(Boolean).map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >>> 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function buildRequest({ version, community, pduType, requestId, oid }) {
  const varbind = tlv(0x30, Buffer.concat([encOid(oid), Buffer.from([0x05, 0x00])]));
  const pdu = tlv(pduType, Buffer.concat([encInt(requestId), encInt(0), encInt(0), tlv(0x30, varbind)]));
  return tlv(0x30, Buffer.concat([encInt(version), tlv(0x04, Buffer.from(community, 'latin1')), pdu]));
}

// ---------------------------------------------------------------
// BER decoding
// ---------------------------------------------------------------
function readTlv(buf, pos) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let off = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[off + i];
    off += n;
  }
  if (off + len > buf.length) throw new Error('Truncated SNMP packet');
  return { tag, start: off, end: off + len, next: off + len };
}

function decInt(buf, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) n = n * 256 + buf[i];
  if (end > start && buf[start] & 0x80) n -= 2 ** (8 * (end - start)); // two's complement
  return n;
}

function decUnsigned(buf, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) n = n * 256 + buf[i];
  return n;
}

function decOid(buf, start, end) {
  const first = buf[start];
  const parts = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = start + 1; i < end; i++) {
    v = v * 128 + (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join('.');
}

function decValue(buf, t) {
  switch (t.tag) {
    case 0x02: return decInt(buf, t.start, t.end);
    case 0x04: return buf.toString('latin1', t.start, t.end).replace(/\0+$/, '');
    case 0x06: return decOid(buf, t.start, t.end);
    case 0x41: case 0x42: case 0x43: case 0x46: return decUnsigned(buf, t.start, t.end);
    case 0x40: return Array.from(buf.subarray(t.start, t.end)).join('.');
    case 0x05: return null;
    case 0x80: case 0x81: case 0x82: return undefined; // noSuchObject / noSuchInstance / endOfMibView
    default: return null;
  }
}

function parseResponse(buf) {
  const msg = readTlv(buf, 0);
  const ver = readTlv(buf, msg.start);
  const comm = readTlv(buf, ver.next);
  const pdu = readTlv(buf, comm.next);
  const reqId = readTlv(buf, pdu.start);
  const errStatus = readTlv(buf, reqId.next);
  const errIndex = readTlv(buf, errStatus.next);
  const vbList = readTlv(buf, errIndex.next);
  const vb = readTlv(buf, vbList.start);
  const oidT = readTlv(buf, vb.start);
  const valT = readTlv(buf, oidT.next);
  return {
    requestId: decInt(buf, reqId.start, reqId.end),
    error: decInt(buf, errStatus.start, errStatus.end),
    oid: decOid(buf, oidT.start, oidT.end),
    value: decValue(buf, valT),
    endOfView: valT.tag === 0x82 || valT.tag === 0x80 || valT.tag === 0x81
  };
}

// ---------------------------------------------------------------
// Session
// ---------------------------------------------------------------
let nextId = Math.floor(Math.random() * 0x7fff0000);

class SnmpSession {
  constructor(host, { port = 161, community = 'public', version = 1, timeoutMs = 2000, retries = 1 } = {}) {
    Object.assign(this, { host, port, community, version, timeoutMs, retries });
    this.socket = dgram.createSocket('udp4');
    this.pending = new Map();
    this.socket.on('message', (msg) => {
      let res;
      try { res = parseResponse(msg); } catch { return; }
      const p = this.pending.get(res.requestId);
      if (p) { this.pending.delete(res.requestId); clearTimeout(p.timer); p.resolve(res); }
    });
    this.socket.on('error', () => {});
  }

  request(pduType, oid) {
    return new Promise((resolve, reject) => {
      const requestId = (nextId = (nextId + 1) % 0x7fffffff);
      const packet = buildRequest({ version: this.version, community: this.community, pduType, requestId, oid });
      let attempts = 0;
      const send = () => {
        attempts++;
        this.socket.send(packet, this.port, this.host);
        const timer = setTimeout(() => {
          if (!this.pending.has(requestId)) return;
          if (attempts > this.retries) { this.pending.delete(requestId); reject(new Error(`SNMP timeout from ${this.host}`)); } else send();
        }, this.timeoutMs);
        this.pending.set(requestId, { resolve, timer });
      };
      send();
    });
  }

  async get(oid) {
    const r = await this.request(0xa0, oid);
    return r.error || r.endOfView ? undefined : r.value;
  }

  /** Walk a subtree with GETNEXT; returns [{ oid, value }]. */
  async walk(root, maxRows = 2000) {
    const rows = [];
    let oid = root;
    for (let i = 0; i < maxRows; i++) {
      const r = await this.request(0xa1, oid);
      if (r.error || r.endOfView || !r.oid.startsWith(`${root}.`) || r.oid === oid) break;
      rows.push({ oid: r.oid, value: r.value });
      oid = r.oid;
    }
    return rows;
  }

  close() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------
// Printer MIB
// ---------------------------------------------------------------
const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  deviceDescr: '1.3.6.1.2.1.25.3.2.1.3.1',
  supplies: '1.3.6.1.2.1.43.11.1.1',      // prtMarkerSuppliesEntry
  colorants: '1.3.6.1.2.1.43.12.1.1.4',   // prtMarkerColorantValue
  lifeCount: '1.3.6.1.2.1.43.10.2.1.4'    // prtMarkerLifeCount (pages)
};

// prtMarkerSuppliesType values (RFC 3805)
const SUPPLY_TYPES = { 3: 'toner', 4: 'waste_toner', 5: 'ink', 6: 'ink', 7: 'waste_ink', 9: 'drum', 10: 'developer', 15: 'fuser', 20: 'transfer_unit', 21: 'toner', 32: 'staples' };

/** Turn MIB level/max into a percentage; null when the printer won't say. */
function supplyPercent(level, max) {
  if (!Number.isFinite(level) || level < 0) return null; // -2 unknown, -3 "some remaining"
  if (Number.isFinite(max) && max > 0) return Math.max(0, Math.min(100, Math.round((level / max) * 1000) / 10));
  return level <= 100 ? level : null;
}

/** Read supplies, colorants, model and page counter from one printer. */
async function readPrinter(host, options = {}) {
  const tryVersion = async (version) => {
    const s = new SnmpSession(host, { ...options, version });
    try {
      const rows = await s.walk(OID.supplies);
      if (rows.length === 0) return null;
      const colorantRows = await s.walk(OID.colorants).catch(() => []);
      const lifeRows = await s.walk(OID.lifeCount).catch(() => []);
      const model = (await s.get(OID.deviceDescr).catch(() => undefined)) || (await s.get(OID.sysDescr).catch(() => undefined)) || '';
      return { rows, colorantRows, lifeRows, model };
    } finally {
      s.close();
    }
  };
  // Most printers speak v2c; some old ones only v1.
  let data = null;
  try { data = await tryVersion(1); } catch { /* fall through */ }
  if (!data) data = await tryVersion(0);
  if (!data) throw new Error(`No Printer MIB data from ${host}`);

  const colorants = new Map();
  for (const r of data.colorantRows) colorants.set(r.oid.split('.').slice(-1)[0], String(r.value || '').toLowerCase());

  const byIndex = new Map();
  for (const r of data.rows) {
    const parts = r.oid.slice(OID.supplies.length + 1).split('.');
    const column = Number(parts[0]);
    const index = parts.slice(1).join('.');
    if (!byIndex.has(index)) byIndex.set(index, { index });
    byIndex.get(index)[column] = r.value;
  }
  const supplies = [...byIndex.values()].map((s) => {
    const level = Number(s[9]);
    const max = Number(s[8]);
    const colorant = s[3] ? colorants.get(String(s[3])) || '' : '';
    return {
      index: s.index,
      description: String(s[6] || '').trim().slice(0, 120),
      colorant,
      kind: SUPPLY_TYPES[Number(s[5])] || 'other',
      receptacle: Number(s[4]) === 4,   // fills up (waste) rather than running out
      level: Number.isFinite(level) ? level : null,
      max: Number.isFinite(max) ? max : null,
      percent: supplyPercent(level, max),
      some_remaining: level === -3
    };
  });
  const lifeCount = data.lifeRows.length ? Math.max(...data.lifeRows.map((r) => Number(r.value) || 0)) : null;
  return { model: String(data.model).slice(0, 120), supplies, life_count: lifeCount };
}

module.exports = { SnmpSession, readPrinter, supplyPercent, buildRequest, parseResponse, encOid, decOid, OID, tlv, encInt };
