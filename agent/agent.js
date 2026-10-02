#!/usr/bin/env node
'use strict';

/**
 * Print Monitor Agent
 * ---------------------------------------------------------------
 * Spawns watch-print-jobs.ps1, which emits one JSON line per detected
 * print job. This wrapper batches those jobs, POSTs them to the receipt
 * system backend, and keeps a local on-disk queue so nothing is lost if
 * the backend or network is temporarily unreachable.
 *
 * Usage:
 *   1. cp config.example.json config.json   (then edit it)
 *   2. node agent.js
 */

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.AGENT_CONFIG || path.join(__dirname, 'config.json');
const QUEUE_PATH = path.join(__dirname, 'queue.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config file not found at ${CONFIG_PATH}.`);
  console.error('Copy config.example.json to config.json and fill in backendUrl + agentApiKey.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const {
  backendUrl,
  agentApiKey,
  printers = [],
  heartbeatIntervalMs = 60000,
  flushIntervalMs = 5000,
  scriptPath = path.join(__dirname, 'watch-print-jobs.ps1'),
  printerColorOverride = {},
  printerDuplexAssumption = {}
} = config;

// Some printers' drivers don't report Win32_PrintJob.Color accurately (a
// known limitation — see agent/README.md). If you KNOW a printer is
// mono-only hardware (or always color), force it here rather than trusting
// the driver, e.g. { "HP LaserJet 500 MFP M525": "mono" }. Keys must match
// the printer name exactly as Windows shows it.
function applyColorOverride(job) {
  const forced = printerColorOverride[job.printer_name];
  if (forced === 'color' || forced === 'mono') {
    if (job.color_mode !== forced) {
      log(`Overriding detected color_mode "${job.color_mode}" -> "${forced}" for printer "${job.printer_name}" (per config).`);
    }
    job.color_mode = forced;
  }
  return job;
}

// Windows doesn't expose a per-job duplex property at all (confirmed against
// Microsoft's documented Win32_PrintJob members — this isn't a driver gap).
// watch-print-jobs.ps1 makes a best-effort attempt by reading the PRINTER's
// current default duplex setting (Win32_PrinterConfiguration.Duplex) at the
// moment the job finishes — a real signal, but not a guarantee it matches
// what that specific job actually used, and some drivers don't expose it at
// all (falls back to "unknown"). If you know how a printer is *normally*
// used, you can set an ASSUMPTION here to override whatever was detected —
// this is a manual guess, not a detection, and applies to every job from
// that printer regardless of what actually happened, e.g.
// { "HP LaserJet 500 MFP M525": "simplex" }.
function applyDuplexAssumption(job) {
  const assumed = printerDuplexAssumption[job.printer_name];
  if (assumed === 'duplex' || assumed === 'simplex') {
    job.duplex = assumed;
  }
  return job;
}

if (!backendUrl || !agentApiKey) {
  console.error('config.json must set both "backendUrl" and "agentApiKey".');
  process.exit(1);
}

// ---------------------------------------------------------------
// Local retry queue (survives restarts and backend outages)
// ---------------------------------------------------------------
function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  } catch {
    log('queue.json was unreadable — starting with an empty queue.');
    return [];
  }
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue));
}

let queue = loadQueue();
let backoffMs = 2000;
const MAX_BACKOFF_MS = 60000;

function enqueue(job) {
  queue.push(job);
  saveQueue(queue);
  log(`Detected: "${job.document_name || '(untitled)'}" on ${job.printer_name} (queue: ${queue.length})`);
}

async function flushQueue() {
  if (queue.length === 0) return;
  const batch = queue.slice(0, 100);

  try {
    const result = await postJson('/api/print-jobs/ingest', { jobs: batch });
    if (result.ok) {
      queue = queue.slice(batch.length);
      saveQueue(queue);
      backoffMs = 2000; // reset backoff on success
      if (result.body) {
        log(`Sent ${batch.length} job(s) — ${result.body.inserted} new, ${result.body.duplicates} duplicate.`);
      }
    } else {
      log(`Ingest rejected (HTTP ${result.status}): ${JSON.stringify(result.body)}`);
      if (result.status === 401) {
        log('Agent key looks invalid or revoked — check config.json and the Print Monitoring admin page.');
      }
    }
  } catch (err) {
    log(`Ingest failed: ${err.message} — will retry (queue: ${queue.length}).`);
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

async function heartbeat() {
  try {
    await postJson('/api/print-jobs/ingest', { jobs: [] });
  } catch (err) {
    log(`Heartbeat failed: ${err.message}`);
  }
}

async function postJson(urlPath, body) {
  const res = await fetch(new URL(urlPath, backendUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': agentApiKey },
    body: JSON.stringify(body)
  });
  let parsedBody = null;
  try { parsedBody = await res.json(); } catch { /* no body */ }
  return { ok: res.ok, status: res.status, body: parsedBody };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------
// Watcher process management
// ---------------------------------------------------------------
function startWatcher() {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  if (printers.length > 0) args.push('-Printers', printers.join(','));

  log(`Starting watcher: powershell.exe ${args.join(' ')}`);
  const ps = spawn('powershell.exe', args, { windowsHide: true });

  const rl = readline.createInterface({ input: ps.stdout });
  rl.on('line', (rawLine) => {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) return; // skip Write-Host status lines
    try {
      enqueue(applyDuplexAssumption(applyColorOverride(JSON.parse(line))));
    } catch {
      log(`Could not parse watcher output as JSON: ${line}`);
    }
  });

  ps.stderr.on('data', (data) => log(`[watcher stderr] ${data.toString().trim()}`));

  ps.on('error', (err) => {
    log(`Could not start powershell.exe: ${err.message}. Is this running on Windows with PowerShell available?`);
  });

  ps.on('exit', (code) => {
    log(`Watcher process exited (code ${code}). Restarting in 5s...`);
    setTimeout(startWatcher, 5000);
  });

  return ps;
}

process.on('SIGINT', () => { log('Shutting down.'); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down.'); process.exit(0); });

startWatcher();
setInterval(flushQueue, flushIntervalMs);
setInterval(heartbeat, heartbeatIntervalMs);
log(`Print monitor agent started. Reporting to ${backendUrl}`);
