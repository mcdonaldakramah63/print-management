'use strict';

/**
 * Reads toner / ink levels and the device page counter from this PC's
 * network printers over SNMP (Printer MIB) and reports them to the server.
 *
 * Printer → IP address comes from Windows (Standard TCP/IP ports), with
 * "printerAddresses" in config.json for printers Windows can't map (WSD
 * ports, shared printers). USB printers don't speak SNMP; for those the
 * server keeps estimating toner from pages printed.
 */

const { execFile } = require('child_process');
const { readPrinter } = require('./snmp');

function asArray(x) { return Array.isArray(x) ? x : x ? [x] : []; }

/** Map printer name -> { host, community } using Windows' printer ports. */
function discoverPrinterAddresses() {
  if (process.platform !== 'win32') return Promise.resolve({});
  const script = [
    "$printers = @(Get-CimInstance Win32_Printer | Select-Object Name, PortName)",
    "$ports = @(Get-CimInstance Win32_TCPIPPrinterPort | Select-Object Name, HostAddress, SNMPEnabled, SNMPCommunity)",
    "@{ printers = $printers; ports = $ports } | ConvertTo-Json -Compress -Depth 3"
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) return resolve({});
      try {
        const data = JSON.parse(stdout);
        const ports = new Map(asArray(data.ports).map((p) => [p.Name, p]));
        const map = {};
        for (const pr of asArray(data.printers)) {
          const port = ports.get(pr.PortName);
          // Standard TCP/IP port, or a port simply named after its IP ("IP_192.168.1.50").
          const ipInName = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(pr.PortName || '');
          const host = (port && port.HostAddress) || (ipInName && ipInName[1]);
          if (host) map[pr.Name] = { host, community: (port && port.SNMPCommunity) || null };
        }
        resolve(map);
      } catch {
        resolve({});
      }
    });
  });
}

function createSupplyPoller({ config, postJson, log }) {
  const {
    printers = [],
    printerAddresses = {},
    snmpCommunity = 'public',
    snmpPort = 161,
    supplyPollMinutes = 15,
    readSupplies = true
  } = config;
  const failures = new Map(); // printer -> last logged failure time

  async function pollOnce() {
    const discovered = await discoverPrinterAddresses();
    const targets = { ...discovered };
    for (const [name, value] of Object.entries(printerAddresses)) {
      targets[name] = typeof value === 'string' ? { host: value, community: null } : value;
    }
    const names = Object.keys(targets).filter((n) => printers.length === 0 || printers.includes(n));
    const readings = [];
    for (const name of names) {
      const t = targets[name];
      try {
        const r = await readPrinter(t.host, { community: t.community || snmpCommunity, port: t.port || snmpPort });
        readings.push({ printer_name: name, address: t.host, read_at: new Date().toISOString(), ...r });
        failures.delete(name);
      } catch (err) {
        const last = failures.get(name) || 0;
        if (Date.now() - last > 3600 * 1000) {
          log(`Could not read supplies from "${name}" (${t.host}): ${err.message}. Is SNMP enabled on the printer?`);
          failures.set(name, Date.now());
        }
      }
    }
    if (readings.length === 0) return 0;
    const res = await postJson('/api/print-jobs/supplies', { readings });
    if (!res.ok) log(`Supply report rejected (HTTP ${res.status}).`);
    else log(`Reported supply levels for ${readings.length} printer(s).`);
    return readings.length;
  }

  function start() {
    if (!readSupplies) return;
    const run = () => pollOnce().catch((err) => log(`Supply polling failed: ${err.message}`));
    setTimeout(run, 20 * 1000);
    setInterval(run, Math.max(5, supplyPollMinutes) * 60 * 1000);
  }

  return { start, pollOnce };
}

module.exports = { createSupplyPoller, discoverPrinterAddresses };
