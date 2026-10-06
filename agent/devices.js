'use strict';

/**
 * Every printer on this PC, traced to the device whose page counter and
 * supplies can be read:
 *   network  (Standard TCP/IP, WSD, IPP/HTTP and shared printers) over SNMP
 *   usb      the USB device itself, asked in PJL through the cable
 * Windows does the tracing (printer-control.ps1, action "devices"); config
 * "printerAddresses" overrides or fills in any printer's network address.
 */

const os = require('os');

const CACHE_MS = 10 * 60 * 1000;

function createDeviceMap({ host, config = {}, now = () => Date.now() }) {
  const { printers = [], printerAddresses = {} } = config;
  let cache = null;
  let cachedAt = 0;
  let pending = null;

  async function load(fresh) {
    let list = [];
    if (host && (process.platform === 'win32' || host.alwaysAvailable)) {
      list = await host.request('devices', null, { fresh: !!fresh }, 180000);
    }
    const byName = new Map(list.map((d) => [d.name, { ...d }]));
    // Addresses from config.json win: a printer Windows can't trace, or a fix.
    for (const [name, value] of Object.entries(printerAddresses)) {
      const t = typeof value === 'string' ? { host: value } : value || {};
      const d = byName.get(name) || { name, port: '', kind: 'configured' };
      byName.set(name, { ...d, host: t.host, community: t.community || d.community || null, snmp_port: t.port || null, configured: true });
    }
    return [...byName.values()].filter((d) => printers.length === 0 || printers.includes(d.name));
  }

  /** The device list, refreshed every 10 minutes (or now, with fresh). */
  async function list(fresh = false) {
    if (!fresh && cache && now() - cachedAt < CACHE_MS) return cache;
    if (!pending) {
      pending = load(fresh).then((l) => { cache = l; cachedAt = now(); return l; }).finally(() => { pending = null; });
    }
    try {
      return await pending;
    } catch (err) {
      if (cache) return cache; // keep the last good map through a hiccup
      throw err;
    }
  }

  /** printer name -> { host, community, port } for every network device (toner, panel). */
  async function addresses() {
    const map = {};
    for (const d of await list()) {
      if (d.host) map[d.name] = { host: d.host, community: d.community || null, ...(d.snmp_port ? { port: d.snmp_port } : {}) };
    }
    return map;
  }

  return { list, addresses };
}

/**
 * A PJL reply to "INFO PAGECOUNT" + "INFO STATUS":
 *   @PJL INFO PAGECOUNT\r\n12345\r\n\f@PJL INFO STATUS\r\nCODE=10023\r\nDISPLAY="Printing"\r\nONLINE=TRUE\r\n\f
 * Printers answer the count as "12345" or "PAGECOUNT=12345".
 */
function parsePjl(text) {
  const out = { count: null, status: 'unknown', code: null, display: '' };
  const s = String(text || '').replace(/\r/g, '');
  const pc = /@PJL INFO PAGECOUNT\s*\n([^\f]*)/i.exec(s);
  if (pc) {
    const m = /(?:PAGECOUNT\s*=\s*)?(\d+)/i.exec(pc[1]);
    if (m) out.count = Number(m[1]);
  }
  const st = /@PJL INFO STATUS\s*\n([^\f]*)/i.exec(s);
  if (st) {
    const code = /CODE\s*=\s*(\d+)/i.exec(st[1]);
    const display = /DISPLAY\s*=\s*"?([^"\n]*)"?/i.exec(st[1]);
    if (code) out.code = Number(code[1]);
    if (display) out.display = display[1].trim();
    // 10023 printing (some devices use 10024-10025 while warming up / copying);
    // 10001/10002 ready; 10003 warming up; 10005 power save.
    if (out.code === 10023 || (!out.code && /^(printing|copying)\b/i.test(out.display))) out.status = 'printing';
    else if ([10001, 10002, 10003, 10005, 10006].includes(out.code)) out.status = 'idle';
    else if (out.code && out.code >= 30000) out.status = 'error';
  }
  return out;
}

/** "MFG:HP;MDL:LaserJet M1132 MFP;CMD:PJL,..." -> { MFG, MDL, CMD, SN } */
function parseDeviceId(id) {
  const out = {};
  for (const part of String(id || '').split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().toUpperCase();
    const v = part.slice(i + 1).trim();
    const key = { MANUFACTURER: 'MFG', MODEL: 'MDL', 'COMMAND SET': 'CMD', SERIALNUMBER: 'SN', SERN: 'SN' }[k] || k;
    if (!(key in out)) out[key] = v;
  }
  return out;
}

/**
 * Read a USB printer's page counter through the PowerShell host.
 * Returns { busy:true } when a job is waiting on it, { pjl:false } when the
 * device doesn't speak PJL, else { count, status, deviceId }.
 */
async function readUsbCounter(host, device, deviceId) {
  const r = await host.request('usb_counter', null, { path: device.usb_path, port: device.port, device_id: deviceId || '' }, 15000);
  if (r.busy) return { busy: true };
  const id = parseDeviceId(r.device_id);
  if (!r.pjl) return { pjl: false, deviceId: r.device_id, model: [id.MFG, id.MDL].filter(Boolean).join(' ') };
  const p = parsePjl(r.reply);
  if (p.count === null) throw new Error('the printer answered without a page count');
  return { count: p.count, status: p.status, deviceId: r.device_id, model: [id.MFG, id.MDL].filter(Boolean).join(' '), serial: id.SN || '' };
}

/** A stable address for a USB device, unique across the shop's PCs. */
function usbAddress(device, serial) {
  return `usb:${os.hostname()}:${serial || device.port || device.usb_path}`.slice(0, 100);
}

module.exports = { createDeviceMap, parsePjl, parseDeviceId, readUsbCounter, usbAddress };
