'use strict';

/**
 * Remote printer control
 * ---------------------------------------------------------------
 * Lets the web app show each printer's "front panel" (status, screen text,
 * trays, covers, alerts, queue, default settings) and act on it (cancel /
 * pause / restart jobs, pause / resume the printer, bring it online, print
 * a test page, clear the queue, change defaults) without anyone walking to
 * the printer.
 *
 * The server can't reach into the shop's PCs, so the agent syncs with it:
 *   POST /api/printers/agent-sync  { snapshot, results }  ->  { commands, acked, watch }
 * Every sync carries a fresh snapshot and the results of commands run since
 * the last one. While someone has the Printers page open (watch = true) the
 * agent syncs every few seconds; otherwise every 30 s.
 *
 * Commands are run at most once: each command id is recorded in a journal on
 * disk before its result is reported, so a command delivered again (its
 * lease ran out because the network dropped the reply) is answered from the
 * journal instead of being run twice. Results are re-sent until the server
 * acknowledges them. Commands carry a time-to-live and are skipped if they
 * arrive too late (a "cancel" from five minutes ago is no longer what anyone
 * wants).
 *
 * Windows actions go to a long-running PowerShell host (printer-control.ps1)
 * that answers one JSON line per request; it is restarted if it dies or
 * stops answering.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { readDeviceStatus, readDeviceInfo } = require('./snmp');

const ACTIONS = new Set(['cancel_job', 'pause_job', 'resume_job', 'restart_job', 'pause_printer', 'resume_printer',
  'set_online', 'test_page', 'clear_queue', 'set_defaults', 'printer_info']);

// ---------------------------------------------------------------
// PowerShell host: one process, JSON lines in and out
// ---------------------------------------------------------------
class PowerShellHost {
  constructor({ scriptPath, printers = [], log, spawnFn = spawn }) {
    Object.assign(this, { scriptPath, printers, log, spawnFn });
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.restartAt = 0;
  }

  ensure() {
    if (this.proc) return true;
    if (Date.now() < this.restartAt) return false;
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath];
    if (this.printers.length) args.push('-Printers', this.printers.join(','));
    let proc;
    try {
      proc = this.spawnFn('powershell.exe', args, { windowsHide: true });
    } catch (err) {
      this.restartAt = Date.now() + 30000;
      throw err;
    }
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.startsWith('{')) return;
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      clearTimeout(p.timer);
      if (reply.ok) p.resolve(reply.data); else p.reject(new Error(reply.error || 'Failed'));
    });
    proc.stderr.on('data', (d) => this.log(`[printer control] ${d.toString().trim()}`));
    const down = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.restartAt = Date.now() + 5000;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
      this.pending.clear();
    };
    proc.on('error', (err) => down(`Printer control isn't available: ${err.message}`));
    proc.on('exit', (code) => down(`Printer control host stopped (code ${code})`));
    return true;
  }

  request(action, printer, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      try {
        if (!this.ensure()) return reject(new Error('Printer control is restarting; try again in a moment.'));
      } catch (err) {
        return reject(err);
      }
      const id = `r${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Windows did not answer in time.'));
        // A wedged host would block every later request: start a new one.
        try { this.proc && this.proc.kill(); } catch { /* already gone */ }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, action, printer, params: params || {} })}\n`);
    });
  }

  stop() {
    if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch { /* gone */ } }
    this.proc = null;
  }
}

// ---------------------------------------------------------------
// Journal: commands already run (survives restarts)
// ---------------------------------------------------------------
function createJournal(file, limit = 300) {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { entries = []; }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(entries.slice(-limit))); } catch { /* best effort */ } };
  return {
    get: (id) => entries.find((e) => e.id === id),
    put(entry) { entries = entries.filter((e) => e.id !== entry.id).concat(entry).slice(-limit); save(); },
    unacked: () => entries.filter((e) => !e.acked),
    ack(ids) {
      let changed = false;
      for (const e of entries) if (ids.includes(e.id) && !e.acked) { e.acked = true; changed = true; }
      if (changed) save();
    }
  };
}

// ---------------------------------------------------------------
// The controller
// ---------------------------------------------------------------
function createPrinterControl({ config, postJson, log, executor, journalPath, readDevice = readDeviceStatus, readInfo = readDeviceInfo, now = () => Date.now() }) {
  const {
    remoteControl = true,
    printerAddresses = {},
    snmpCommunity = 'public',
    snmpPort = 161,
    controlWatchIntervalMs = 3000,
    controlIdleIntervalMs = 30000
  } = config;
  const journal = createJournal(journalPath);
  const deviceCache = new Map(); // host -> { at, data, failures }
  let watching = false;
  let failures = 0;
  let timer = null;
  let running = false;

  function hostFor(printer) {
    const override = printerAddresses[printer.name];
    if (override) return typeof override === 'string' ? { host: override } : override;
    return printer.host && /^[\w.-]+$/.test(printer.host) ? { host: printer.host } : null;
  }

  // SNMP is slower than the spooler: re-read each device at most every 10 s
  // while watched (60 s otherwise), and back off from one that doesn't answer.
  async function deviceStatus(target) {
    const cached = deviceCache.get(target.host);
    const maxAge = watching ? 10000 : 60000;
    const backoff = cached && cached.failures ? Math.min(300000, 15000 * 2 ** (cached.failures - 1)) : 0;
    if (cached && now() - cached.at < Math.max(maxAge, backoff)) return cached.data;
    try {
      const data = await readDevice(target.host, { community: target.community || snmpCommunity, port: target.port || snmpPort });
      deviceCache.set(target.host, { at: now(), data, failures: 0 });
      return data;
    } catch (err) {
      const f = (cached ? cached.failures : 0) + 1;
      const data = { reachable: false, error: err.message };
      deviceCache.set(target.host, { at: now(), data, failures: f });
      return data;
    }
  }

  // A printer's full feature set: the driver's capabilities from Windows and,
  // for network printers, the device's own identity and features over SNMP.
  async function printerInfo(printerName) {
    const windows = await executor.request('capabilities', printerName, {}, 45000);
    let device = null;
    const known = lastPrinters.find((p) => p.name === printerName);
    const target = known ? hostFor(known) : hostFor({ name: printerName });
    if (target) {
      try {
        device = await readInfo(target.host, { community: target.community || snmpCommunity, port: target.port || snmpPort });
      } catch (err) {
        device = { error: err.message };
      }
    }
    return { windows, device, read_at: new Date(now()).toISOString() };
  }

  let lastPrinters = [];
  async function snapshot() {
    let printers;
    try {
      printers = await executor.request('snapshot', null, {}, 45000);
    } catch (err) {
      return { taken_at: new Date(now()).toISOString(), error: err.message, printers: [] };
    }
    printers = Array.isArray(printers) ? printers : printers ? [printers] : [];
    lastPrinters = printers;
    for (const p of printers) {
      p.jobs = Array.isArray(p.jobs) ? p.jobs : p.jobs ? [p.jobs] : [];
      const target = hostFor(p);
      if (target) { p.host = target.host; p.device = await deviceStatus(target); }
    }
    return { taken_at: new Date(now()).toISOString(), printers };
  }

  async function runCommand(cmd, receivedAt) {
    const done = journal.get(cmd.id);
    if (done) return done; // delivered again: answer, don't run twice
    let entry;
    if (!ACTIONS.has(cmd.action)) {
      entry = { id: cmd.id, ok: false, error: `Unknown action ${cmd.action}` };
    } else if (Number.isFinite(cmd.expires_in_ms) && now() - receivedAt > cmd.expires_in_ms) {
      entry = { id: cmd.id, ok: false, error: 'Arrived too late; not run.', expired: true };
    } else {
      try {
        const data = cmd.action === 'printer_info'
          ? await printerInfo(cmd.printer)
          : await executor.request(cmd.action, cmd.printer, cmd.params, 30000);
        entry = { id: cmd.id, ok: true, data: data || null };
        log(`Printer control: ${cmd.action} on "${cmd.printer}" done.`);
      } catch (err) {
        entry = { id: cmd.id, ok: false, error: err.message };
        log(`Printer control: ${cmd.action} on "${cmd.printer}" failed: ${err.message}`);
      }
    }
    entry.at = new Date(now()).toISOString();
    journal.put(entry);
    return entry;
  }

  /** One round: send snapshot + unacknowledged results, run what comes back. */
  async function syncOnce() {
    const snap = await snapshot();
    const results = journal.unacked().map(({ id, ok, error, data, expired }) => ({ id, ok, error, data, expired }));
    const res = await postJson('/api/printers/agent-sync', { snapshot: snap, results });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = res.body || {};
    journal.ack(Array.isArray(body.acked) ? body.acked : []);
    watching = !!body.watch;
    const commands = Array.isArray(body.commands) ? body.commands : [];
    const receivedAt = now();
    for (const cmd of commands) await runCommand(cmd, receivedAt);
    return commands.length;
  }

  async function loop() {
    if (running) return;
    running = true;
    let delay;
    try {
      let ran = await syncOnce();
      // Report results (and the printer's new state) straight away.
      for (let i = 0; ran > 0 && i < 3; i++) ran = await syncOnce();
      failures = 0;
      delay = watching ? controlWatchIntervalMs : controlIdleIntervalMs;
    } catch (err) {
      failures++;
      if (failures === 1 || failures % 20 === 0) log(`Printer control sync failed: ${err.message}`);
      delay = Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
    } finally {
      running = false;
    }
    timer = setTimeout(loop, delay);
  }

  function start() {
    if (!remoteControl) return;
    timer = setTimeout(loop, 3000);
  }

  function stop() { clearTimeout(timer); executor.stop && executor.stop(); }

  return { start, stop, syncOnce, snapshot, runCommand, get watching() { return watching; } };
}

module.exports = { createPrinterControl, PowerShellHost, createJournal, ACTIONS };
