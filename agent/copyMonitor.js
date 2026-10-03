'use strict';

/**
 * Photocopy detection
 * ---------------------------------------------------------------
 * A photocopy never goes through the Windows print spooler, but it does turn
 * the printer's own page counter (Printer MIB prtMarkerLifeCount, over SNMP).
 * So this module watches that counter every minute and accounts for every
 * page it goes up by:
 *
 *   counter growth  = pages from spooled print jobs  +  walk-up output
 *
 * Every spooled job becomes a CREDIT (its pages x copies, or sheets when the
 * printer counts sheets) that is valid from shortly before it was submitted
 * until a while after the spooler finished it, since printers buffer and
 * physical output lags the spooler. Every rise of the counter becomes a
 * DEBIT for that poll interval. Debits are paid from overlapping credits,
 * oldest first. Anything left unpaid after a grace period (the spooled job
 * that explains it may still be on its way), and while no job is still
 * spooling to that printer, is walk-up output: photocopies.
 *
 * Unpaid pages from consecutive polls are joined into one copy run, and each
 * run gets a confidence:
 *   high    the printer said "printing" while no spooled job was owed, or the
 *           run went on across several polls, or a vendor copy counter
 *           (config "copyCounterOids") reported it directly
 *   medium  a short, single-interval rise
 *   low     a single page (often a status / fax report page), or spooled
 *           pages went missing nearby (likely a print job that came out late)
 *
 * Jobs with an unknown page count can't be paid exactly, so they absorb all
 * growth while they print instead of producing false copies. A counter that
 * goes backwards (printer replaced or reset) or jumps absurdly re-baselines.
 * Several Windows printers pointing at the same device (PCL + PS drivers)
 * share one ledger, keyed by the printer's address.
 */

const crypto = require('crypto');
const fs = require('fs');
const { readCounters, readColorants } = require('./snmp');

const DEFAULTS = {
  pollMs: 60 * 1000,
  graceMs: 5 * 60 * 1000,        // counter growth waits this long for a spooled job to explain it
  creditLeadMs: 2 * 60 * 1000,   // clock skew between the spooler stamp and the printer
  creditTtlMs: 15 * 60 * 1000,   // after the spooler is done, the printer has this long to print it
  wildcardTtlMs: 3 * 60 * 1000,  // job with an unknown page count: absorbs growth only this long
  inFlightMaxMs: 60 * 60 * 1000, // a job stuck "spooling" stops holding detection back after this
  eventGapMs: 3 * 60 * 1000,     // pauses shorter than this belong to the same copy run
  missedWindowMs: 30 * 60 * 1000,
  maxJumpPerPoll: 3000
};

const COLOURS = new Set(['cyan', 'magenta', 'yellow', 'red', 'green', 'blue', 'light cyan', 'light magenta']);

function pad(n) { return String(Math.floor(Math.abs(n))).padStart(2, '0'); }

/** ISO-8601 in this PC's local time with offset, like the print jobs carry. */
function localIso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const local = new Date(ms + off * 60000).toISOString().slice(0, 23);
  return `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

/** What a spooled job should add to the counter, in both units. */
function jobUnits(job) {
  const pages = Number(job.pages);
  if (!Number.isFinite(pages) || pages <= 0) return null;
  const copies = Number.isInteger(job.copies) && job.copies > 0 ? job.copies : 1;
  const perCopySheets = job.duplex === 'duplex' ? Math.ceil(pages / 2) : pages;
  return { impressions: pages * copies, sheets: perCopySheets * copies };
}

class CopyDetector {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.devices = new Map();
  }

  device(key) {
    if (!this.devices.has(key)) {
      this.devices.set(key, {
        key, last: null, lastAt: null, unit: 'impressions', color: 'unknown',
        credits: [], debits: [], inFlight: new Map(), missed: [], open: null,
        copyLast: null, colorCopyLast: null
      });
    }
    return this.devices.get(key);
  }

  /** The spooler has a new job for this device (not printed yet). */
  jobSpooling(key, jobId, nowMs) {
    this.device(key).inFlight.set(String(jobId), nowMs);
  }

  /** The spooler finished a job: its pages are now owed by the counter. */
  jobPrinted(key, job, nowMs) {
    const d = this.device(key);
    d.inFlight.delete(String(job.external_job_id));
    const submitted = Date.parse(job.submitted_at);
    const completed = Date.parse(job.completed_at);
    const units = jobUnits(job);
    const end = Math.max(Number.isFinite(completed) ? completed : nowMs, nowMs);
    d.credits.push({
      from: (Number.isFinite(submitted) ? Math.min(submitted, end) : end) - this.o.creditLeadMs,
      until: end + (units ? this.o.creditTtlMs : this.o.wildcardTtlMs),
      units,
      wildcard: !units,
      remaining: null,
      name: String(job.document_name || '')
    });
  }

  /**
   * One counter reading. reading: { count, unit?, status?, copyCount?, colorCopyCount? }
   * Returns the copy runs that closed with this reading.
   */
  observe(key, reading, nowMs) {
    const d = this.device(key);
    if (reading.unit) d.unit = reading.unit;
    const closed = [];

    if (Number.isFinite(reading.copyCount)) {
      this.observeCopyCounter(d, reading, nowMs, closed);
    } else if (Number.isFinite(reading.count)) {
      const stale = d.lastAt !== null && nowMs - d.lastAt > this.o.creditTtlMs;
      const delta = d.last === null ? 0 : reading.count - d.last;
      if (d.last === null || stale || delta < 0 || delta > this.o.maxJumpPerPoll) {
        // First reading, a long outage, a reset or a bogus jump: start over.
        d.debits = [];
      } else if (delta > 0) {
        d.debits.push({ from: d.lastAt, at: nowMs, units: delta, remaining: delta, busy: false });
      }
      d.last = reading.count;
      d.lastAt = nowMs;
      this.match(d);
      // "Printing" with nothing spooled still owed: the device is copying.
      if (reading.status === 'printing' && !this.owed(d, nowMs)) {
        const latest = d.debits[d.debits.length - 1];
        if (latest && latest.at === nowMs && latest.remaining > 0) latest.busy = true;
      }
      this.settle(d, nowMs, closed);
    }

    if (d.open && nowMs - d.open.lastAt > this.o.graceMs + this.o.eventGapMs &&
        d.debits.every((x) => x.remaining <= 0) && !this.holding(d, nowMs)) {
      closed.push(this.close(d));
    }
    return closed;
  }

  /** Vendor copy counters: the device itself says how many copies it made. */
  observeCopyCounter(d, reading, nowMs, closed) {
    const prev = d.copyLast;
    const prevColor = d.colorCopyLast;
    const prevAt = d.lastAt;
    d.copyLast = reading.copyCount;
    d.colorCopyLast = Number.isFinite(reading.colorCopyCount) ? reading.colorCopyCount : null;
    d.lastAt = nowMs;
    if (prev === null) return;
    const delta = reading.copyCount - prev;
    if (delta <= 0 || delta > this.o.maxJumpPerPoll) return;
    let color = 0;
    if (d.colorCopyLast !== null && prevColor !== null) color = Math.max(0, Math.min(delta, d.colorCopyLast - prevColor));
    const known = d.colorCopyLast !== null || d.color === 'mono';
    this.accumulate(d, { from: prevAt, at: nowMs, remaining: delta, busy: true }, 'copy_counter',
      { color, mono: known ? delta - color : 0, unknown: known ? 0 : delta }, closed);
  }

  /** Pay debits from overlapping credits, oldest first. */
  match(d) {
    const field = d.unit === 'sheets' ? 'sheets' : 'impressions';
    for (const debit of d.debits) {
      for (const c of d.credits) {
        if (debit.remaining <= 0) break;
        if (c.remaining === null) c.remaining = c.wildcard ? Infinity : c.units[field];
        if (c.remaining <= 0 || c.from > debit.at || c.until < debit.from) continue;
        const take = Math.min(c.remaining, debit.remaining);
        c.remaining -= take;
        debit.remaining -= take;
      }
    }
  }

  /** Spooled pages the printer still has to produce right now. */
  owed(d, nowMs) {
    return d.inFlight.size > 0 || d.credits.some((c) => (c.remaining === null || c.remaining > 0) && c.from <= nowMs && c.until >= nowMs);
  }

  holding(d, nowMs) {
    for (const [id, t] of d.inFlight) if (nowMs - t >= this.o.inFlightMaxMs) d.inFlight.delete(id);
    return d.inFlight.size > 0;
  }

  settle(d, nowMs, closed) {
    const holding = this.holding(d, nowMs);
    const unpaid = [];
    d.debits = d.debits.filter((debit) => {
      if (debit.remaining <= 0) return false;
      if (holding || nowMs - debit.at < this.o.graceMs) return true;
      unpaid.push(debit);
      return false;
    });
    // Credits that ran out of time unpaid: spooled pages the counter never showed.
    d.credits = d.credits.filter((c) => {
      if (c.until >= nowMs) return true;
      const left = c.remaining ?? (c.units ? c.units[d.unit === 'sheets' ? 'sheets' : 'impressions'] : 0);
      if (!c.wildcard && left > 0) d.missed.push({ at: c.until, units: left });
      return false;
    });
    d.missed = d.missed.filter((m) => nowMs - m.at < 2 * this.o.missedWindowMs);
    const split = (n) => (d.color === 'mono' ? { color: 0, mono: n, unknown: 0 } : { color: 0, mono: 0, unknown: n });
    for (const debit of unpaid) this.accumulate(d, debit, 'counter_gap', split(debit.remaining), closed);
  }

  accumulate(d, debit, source, parts, closed) {
    const from = debit.from ?? debit.at - this.o.pollMs;
    if (d.open && d.open.source === source && from - d.open.lastAt <= this.o.eventGapMs) {
      const o = d.open;
      o.units += debit.remaining; o.lastAt = debit.at; o.polls++;
      o.color += parts.color; o.mono += parts.mono; o.unknown += parts.unknown;
      if (debit.busy) o.busy++;
      return;
    }
    if (d.open) closed.push(this.close(d));
    d.open = { source, startAt: from, lastAt: debit.at, units: debit.remaining, polls: 1, busy: debit.busy ? 1 : 0, ...parts };
  }

  close(d) {
    const o = d.open;
    d.open = null;
    const evidence = [];
    const busy = o.busy > 0;
    if (o.source === 'copy_counter') evidence.push('copy_counter');
    if (busy && o.source !== 'copy_counter') evidence.push('printing_without_job');
    if (o.polls >= 2) evidence.push('sustained');
    const missed = d.missed.filter((m) => m.at >= o.startAt - this.o.missedWindowMs && m.at <= o.lastAt + this.o.missedWindowMs)
      .reduce((n, m) => n + m.units, 0);
    if (missed > 0) evidence.push('spooled_pages_missing_nearby');
    if (o.units === 1) evidence.push('single_page');

    let confidence = 'medium';
    if (o.source === 'copy_counter' || busy || o.polls >= 2) confidence = 'high';
    if (o.source !== 'copy_counter' && (o.units === 1 || missed >= o.units * 0.5)) confidence = 'low';

    return {
      event_key: crypto.createHash('sha1').update(`${d.key}|${o.source}|${o.startAt}`).digest('hex').slice(0, 20),
      device: d.key,
      started_at: localIso(o.startAt),
      ended_at: localIso(o.lastAt),
      pages: o.units,
      color_pages: o.color,
      mono_pages: o.mono,
      unknown_pages: o.unknown,
      unit: d.unit,
      source: o.source,
      confidence,
      evidence
    };
  }
}

// ---------------------------------------------------------------
// Polling, address mapping and reporting
// ---------------------------------------------------------------
function createCopyMonitor({ config, postJson, log, queuePath, discover }) {
  const {
    printers = [],
    printerAddresses = {},
    snmpCommunity = 'public',
    snmpPort = 161,
    detectCopies = true,
    copyPollSeconds = 60,
    copyCounterOids = {},
    printerColorOverride = {}
  } = config;
  const pollMs = Math.max(15, copyPollSeconds) * 1000;
  const detector = new CopyDetector({ pollMs, ...(config.copyDetectorOptions || {}) });

  let targets = {};          // printer name -> { host, community, port }
  const nameToKey = new Map();
  const devices = new Map(); // key -> { host, community, port, names: Set, colorKnown }
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch { queue = []; }
  const failures = new Map();

  const keyFor = (t) => `${t.host}:${t.port || snmpPort}`;

  async function refreshTargets() {
    const discovered = discover ? await discover() : {};
    const next = { ...discovered };
    for (const [name, value] of Object.entries(printerAddresses)) {
      next[name] = typeof value === 'string' ? { host: value, community: null } : value;
    }
    targets = {};
    nameToKey.clear();
    for (const [name, t] of Object.entries(next)) {
      if (printers.length > 0 && !printers.includes(name)) continue;
      targets[name] = t;
      const key = keyFor(t);
      nameToKey.set(name, key);
      if (!devices.has(key)) devices.set(key, { host: t.host, port: t.port || snmpPort, community: t.community || snmpCommunity, names: new Set(), colorKnown: false });
      devices.get(key).names.add(name);
    }
  }

  function jobSpooling(job) {
    const key = nameToKey.get(job.printer_name);
    if (key) detector.jobSpooling(key, job.external_job_id, Date.now());
  }

  function jobPrinted(job) {
    const key = nameToKey.get(job.printer_name);
    if (key) detector.jobPrinted(key, job, Date.now());
  }

  function oidsFor(dev) {
    for (const name of dev.names) {
      const c = copyCounterOids[name];
      if (c && (c.total || typeof c === 'string')) return { total: c.total || c, color: c.color || null };
    }
    return null;
  }

  async function learnColour(key, dev) {
    dev.colorKnown = true;
    const d = detector.device(key);
    for (const name of dev.names) {
      if (printerColorOverride[name] === 'mono') { d.color = 'mono'; return; }
    }
    try {
      const colorants = await readColorants(dev.host, { community: dev.community, port: dev.port, timeoutMs: 1500, retries: 1 });
      // A device with only black toner can only make black-and-white copies.
      if (colorants.length > 0 && !colorants.some((c) => COLOURS.has(c))) d.color = 'mono';
    } catch { /* stays unknown */ }
  }

  function enqueue(events) {
    if (events.length === 0) return;
    queue.push(...events);
    try { fs.writeFileSync(queuePath, JSON.stringify(queue)); } catch { /* best effort */ }
  }

  let flushing = false;
  async function flush() {
    if (flushing || queue.length === 0) return;
    flushing = true;
    try {
      const batch = queue.slice(0, 50);
      const res = await postJson('/api/print-jobs/copies', { events: batch });
      if (res.ok) {
        queue = queue.slice(batch.length);
        try { fs.writeFileSync(queuePath, JSON.stringify(queue)); } catch { /* best effort */ }
      } else {
        log(`Photocopy report rejected (HTTP ${res.status}).`);
      }
    } catch (err) {
      log(`Photocopy report failed: ${err.message} — will retry.`);
    } finally {
      flushing = false;
    }
  }

  let polling = false;
  async function pollOnce(nowMs = Date.now()) {
    if (polling) return [];
    polling = true;
    const found = [];
    try {
      for (const [key, dev] of devices) {
        if (!dev.colorKnown) await learnColour(key, dev);
        const oids = oidsFor(dev);
        let reading;
        try {
          const r = await readCounters(dev.host, { community: dev.community, port: dev.port, timeoutMs: 1500, retries: 1 },
            oids ? [oids.total, oids.color].filter(Boolean) : []);
          reading = { count: r.life_count, unit: r.unit, status: r.status };
          if (oids && Number.isFinite(r.extra[oids.total])) {
            reading.copyCount = r.extra[oids.total];
            if (oids.color && Number.isFinite(r.extra[oids.color])) reading.colorCopyCount = r.extra[oids.color];
          }
          failures.delete(key);
        } catch (err) {
          if (Date.now() - (failures.get(key) || 0) > 3600 * 1000) {
            log(`Photocopy detection can't read the page counter of ${[...dev.names].join(' / ')} (${dev.host}): ${err.message}`);
            failures.set(key, Date.now());
          }
          continue;
        }
        const printerName = [...dev.names][0];
        for (const e of detector.observe(key, reading, nowMs)) {
          const event = { ...e, printer_name: printerName, address: dev.host };
          delete event.device;
          found.push(event);
          log(`Photocopies detected on ${printerName}: ${e.pages} ${e.unit === 'sheets' ? 'sheet' : 'page'}(s), ${e.started_at.slice(11, 16)}–${e.ended_at.slice(11, 16)} (${e.confidence} confidence).`);
        }
      }
    } finally {
      polling = false;
    }
    enqueue(found);
    await flush();
    return found;
  }

  async function start() {
    if (!detectCopies) return;
    await refreshTargets().catch(() => {});
    if (devices.size === 0) {
      log('Photocopy detection: no network printers found (USB printers have no page counter to read).');
    }
    const run = () => pollOnce().catch((err) => log(`Photocopy polling failed: ${err.message}`));
    run();
    setInterval(run, pollMs);
    setInterval(() => refreshTargets().catch(() => {}), 30 * 60 * 1000);
  }

  return { start, pollOnce, refreshTargets, jobSpooling, jobPrinted, detector, flush, get queue() { return queue; } };
}

module.exports = { CopyDetector, createCopyMonitor, jobUnits, localIso, DEFAULTS };
