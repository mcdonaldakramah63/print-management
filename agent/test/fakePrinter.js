'use strict';
// A fake SNMP printer for tests: answers GET/GETNEXT from a static Printer MIB table.
const dgram = require('dgram');
const { tlv, encInt, encOid, parseResponse } = require('../snmp');

function encValue(v) {
  if (typeof v === 'number') return encInt(v);
  if (v && v.counter !== undefined) {
    const bytes = []; let n = v.counter; do { bytes.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
    if (bytes[0] & 0x80) bytes.unshift(0);
    return tlv(0x41, Buffer.from(bytes));
  }
  return tlv(0x04, Buffer.from(String(v), 'latin1'));
}

function cmpOid(a, b) {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

function startFakePrinter(table, port = 0) {
  const oids = Object.keys(table).sort(cmpOid);
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    // Parse the request with the client's own parser (same layout as a response).
    const req = parseResponse(msg);
    // PDU tag sits after the outer SEQUENCE header, version and community TLVs.
    const skip = (pos) => { let len = msg[pos + 1]; let off = pos + 2; if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | msg[off + i]; off += n; } return off + len; };
    const outerLen = msg[1] & 0x80 ? 2 + (msg[1] & 0x7f) : 2;
    const pduTag = msg[skip(skip(outerLen))];
    const isNext = pduTag === 0xa1;
    let oid = req.oid;
    if (isNext) oid = oids.find((o) => cmpOid(o, req.oid) > 0);
    const valueBuf = oid === undefined ? Buffer.from([0x82, 0x00]) : table[oid] === undefined ? Buffer.from([0x80, 0x00]) : encValue(table[oid]);
    const vb = tlv(0x30, Buffer.concat([encOid(oid || req.oid), valueBuf]));
    const pdu = tlv(0xa2, Buffer.concat([encInt(req.requestId), encInt(0), encInt(0), tlv(0x30, vb)]));
    const out = tlv(0x30, Buffer.concat([encInt(1), tlv(0x04, Buffer.from('public')), pdu]));
    sock.send(out, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(port, '127.0.0.1', () => resolve({ port: sock.address().port, close: () => sock.close(), table })));
}

module.exports = { startFakePrinter };
