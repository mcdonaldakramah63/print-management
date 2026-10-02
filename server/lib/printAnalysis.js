// ---------------------------------------------------------------
// Print job analysis
//
// Turns raw spooler reports into answers a print shop cares about:
//
//   1. How much was physically printed?   impressions = pages x copies,
//      sheets = impressions, halved (rounded up) for duplex jobs.
//   2. How long is the document, and was all of it printed?
//      Estimated from (a) a page count the agent measured from the source
//      file, if that option is on, else (b) this client's print history for
//      the same document, else unknown. Each job is then classed as
//      full / partial / split (the document printed in several parts) /
//      unknown, and identical repeats are flagged as reprints.
//   3. Is one client running several jobs at once?
//      Jobs are clustered per client (agent + client PC + Windows user) into
//      sessions using an adaptive time gap. Each session reports bursts
//      (several jobs submitted within a minute) and true concurrency (jobs
//      whose submit-to-finish windows overlap).
// ---------------------------------------------------------------
const db = require('../db');

// Loaded lazily: insights/traffic requires this module's dependencies too.
let trafficModule = null;
function isOffHours(date) {
  if (!trafficModule) trafficModule = require('./insights/traffic');
  try { return trafficModule.isOffHours(date); } catch (_) { return false; }
}

const GAP = { defaultSec: 180, minSec: 90, maxSec: 600, factor: 3 };
const BURST = { jobs: 3, windowSec: 60 };
const HISTORY_DAYS = 30;

// Names apps give documents that say nothing about which file it is.
const GENERIC_NAMES = new Set(['', 'document', 'untitled', 'print', 'printing', 'test page', 'new tab', 'blank', 'about:blank', 'microsoft word', 'image']);

// DEVMODE dmPaperSize codes for the sizes a print shop sells.
const PAPER_SIZES = { 1: 'Letter', 5: 'Legal', 8: 'A3', 9: 'A4', 11: 'A5' };

function paperLabel(code) {
  if (code === null || code === undefined || code === '') return '';
  const n = Number(code);
  if (Number.isInteger(n)) return PAPER_SIZES[n] || '';
  return String(code).slice(0, 20);
}

/**
 * Normalise a spooler document name so the same file matches across jobs:
 * "Microsoft Word - Report (1).docx" and "C:\\Users\\x\\Report.docx" both
 * become "report".
 */
function normalizeDocKey(name) {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/^microsoft [a-z ]+? - /, '');
  s = s.split(/[\\/]/).pop();
  s = s.replace(/\s+-\s+(adobe acrobat.*|acrobat reader.*|microsoft edge|google chrome|mozilla firefox|notepad|paint|wordpad|photos)$/, '');
  s = s.replace(/\.(pdf|docx?|pptx?|xlsx?|txt|rtf|odt|odp|jpe?g|png|gif|bmp|tiff?|webp)$/, '');
  s = s.replace(/\s*\(\d+\)$/, '');
  s = s.replace(/[_\s]+/g, ' ').trim();
  return GENERIC_NAMES.has(s) || s.length < 3 ? '' : s;
}

function normalizeMachine(m) {
  return String(m || '').replace(/^\\+/, '').trim();
}

function clientKey(job) {
  return [job.agent_id, normalizeMachine(job.client_machine).toLowerCase(), String(job.submitted_by || '').toLowerCase()].join('|');
}

// Timestamps arrive as ISO-8601 with an offset from the agent, or as
// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) for server-side fallbacks.
function ts(value) {
  if (!value) return NaN;
  const s = String(value);
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function median(nums) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * How long a pause still counts as "the same visit". Clients who fire jobs
 * every few seconds get a tight window; slow, steady printing gets a wider
 * one, within sane bounds.
 */
function sessionGapMs(submitTimes) {
  const sorted = [...submitTimes].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 1000);
  if (gaps.length < 2) return GAP.defaultSec * 1000;
  const sec = Math.min(GAP.maxSec, Math.max(GAP.minSec, median(gaps) * GAP.factor));
  return sec * 1000;
}

// ---------------------------------------------------------------
// Per-job physical counts (computed at ingest)
// ---------------------------------------------------------------
function physicalCounts({ pages, copies, duplex }) {
  if (!Number.isFinite(pages) || pages < 0) return { impressions: null, sheets: null };
  const c = Number.isInteger(copies) && copies > 0 ? copies : 1;
  const perCopySheets = duplex === 'duplex' ? Math.ceil(pages / 2) : pages;
  return { impressions: pages * c, sheets: perCopySheets * c };
}

// ---------------------------------------------------------------
// Document length estimate for one job
// ---------------------------------------------------------------
const measuredHistory = db.prepare(`
  SELECT MAX(document_pages) AS pages FROM print_jobs
  WHERE agent_id = ? AND doc_key = ? AND document_pages > 0
    AND received_at >= datetime('now', ?)
`);
const clientHistory = db.prepare(`
  SELECT MAX(pages) AS pages FROM print_jobs
  WHERE agent_id = ? AND doc_key = ? AND pages > 0
    AND lower(client_machine) = lower(?) AND lower(submitted_by) = lower(?)
    AND received_at >= datetime('now', ?)
`);

function estimateDocument(job) {
  if (job.document_pages > 0) return { pages: job.document_pages, source: 'measured' };
  if (job.doc_key) {
    const window = `-${HISTORY_DAYS} days`;
    const measured = measuredHistory.get(job.agent_id, job.doc_key, window).pages;
    if (measured > 0) return { pages: measured, source: 'measured' };
    const seen = clientHistory.get(job.agent_id, job.doc_key, job.client_machine || '', job.submitted_by || '', window).pages;
    if (seen > (job.pages || 0)) return { pages: seen, source: 'history' };
  }
  return { pages: job.pages ?? null, source: job.pages != null ? 'job' : '' };
}

// ---------------------------------------------------------------
// Session assignment
// ---------------------------------------------------------------
const openSessionsForClient = db.prepare(`
  SELECT * FROM print_sessions WHERE client_key = ? AND sale_id IS NULL ORDER BY ended_at DESC LIMIT 10
`);
const sessionSubmitTimes = db.prepare('SELECT submitted_at FROM print_jobs WHERE session_id = ?');
const insertSession = db.prepare(`
  INSERT INTO print_sessions (agent_id, client_key, owner, machine, started_at, ended_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function assignSession(job) {
  const key = clientKey(job);
  const t = ts(job.submitted_at);
  let best = null;
  let bestDistance = Infinity;
  for (const s of openSessionsForClient.all(key)) {
    const gap = sessionGapMs(sessionSubmitTimes.all(s.id).map((r) => ts(r.submitted_at)));
    const start = ts(s.started_at);
    const end = ts(s.ended_at);
    if (t >= start - gap && t <= end + gap) {
      const distance = t < start ? start - t : t > end ? t - end : 0;
      if (distance < bestDistance) { best = s; bestDistance = distance; }
    }
  }
  if (best) return best.id;
  const when = Number.isFinite(t) ? iso(t) : iso(Date.now());
  return insertSession.run(job.agent_id, key, job.submitted_by || '', normalizeMachine(job.client_machine), when, when).lastInsertRowid;
}

// ---------------------------------------------------------------
// Session analysis: coverage, reprints, bursts, concurrency, totals
// ---------------------------------------------------------------
function intervalOf(job) {
  const start = ts(job.submitted_at);
  let end = ts(job.completed_at);
  if (!Number.isFinite(end) || end < start) end = start + 1000;
  return [start, end];
}

function maxBurst(times) {
  const sorted = [...times].filter(Number.isFinite).sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > BURST.windowSec * 1000) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

/** Largest number of jobs printing at the same moment (sweep line). */
function maxConcurrency(intervals) {
  const events = [];
  for (const [s, e] of intervals) { events.push([s, 1]); events.push([e, -1]); }
  // At equal times process ends first, so back-to-back jobs don't count as overlapping.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let best = 0;
  for (const [, d] of events) { cur += d; best = Math.max(best, cur); }
  return Math.max(best, intervals.length ? 1 : 0);
}

const updateJobAnalysis = db.prepare(`
  UPDATE print_jobs SET est_document_pages = ?, est_source = ?, coverage = ?, flags = ? WHERE id = ?
`);
const updateSession = db.prepare(`
  UPDATE print_sessions SET started_at = ?, ended_at = ?, job_count = ?, document_count = ?,
    color_pages = ?, mono_pages = ?, unknown_pages = ?, sheets = ?, max_concurrent = ?, flags = ?
  WHERE id = ?
`);

function recomputeSession(sessionId) {
  const jobs = db.prepare('SELECT * FROM print_jobs WHERE session_id = ? ORDER BY submitted_at, id').all(sessionId);
  if (jobs.length === 0) {
    db.prepare('DELETE FROM print_sessions WHERE id = ? AND sale_id IS NULL').run(sessionId);
    return;
  }

  const intervals = jobs.map(intervalOf);
  const jobFlags = jobs.map(() => new Set());

  // Concurrency per job: does its window overlap any other job's?
  for (let i = 0; i < jobs.length; i++) {
    for (let j = i + 1; j < jobs.length; j++) {
      if (intervals[i][0] < intervals[j][1] && intervals[j][0] < intervals[i][1]) {
        jobFlags[i].add('concurrent');
        jobFlags[j].add('concurrent');
      }
    }
  }

  // Group jobs of the same document (unnamed documents stand alone).
  const groups = new Map();
  jobs.forEach((job, idx) => {
    const k = job.doc_key || `#${job.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(idx);
  });

  const coverage = new Array(jobs.length).fill('unknown');
  const estimates = jobs.map(estimateDocument);

  for (const idxs of groups.values()) {
    // Best estimate for the whole group: a measured count wins, else the largest seen.
    const rank = { measured: 3, history: 2, job: 1, '': 0 };
    let est = { pages: null, source: '' };
    for (const i of idxs) {
      const e = estimates[i];
      if (rank[e.source] > rank[est.source] || (e.source === est.source && (e.pages || 0) > (est.pages || 0))) est = e;
    }
    for (const i of idxs) estimates[i] = est;

    const knowsLength = est.source === 'measured' || est.source === 'history';
    const partials = idxs.filter((i) => jobs[i].pages != null && est.pages && jobs[i].pages < est.pages);
    const hasFull = idxs.some((i) => jobs[i].pages != null && est.pages && jobs[i].pages >= est.pages);
    const partialSum = partials.reduce((sum, i) => sum + jobs[i].pages, 0);

    const seen = new Set();
    for (const i of idxs) {
      const job = jobs[i];
      if (job.pages == null) { coverage[i] = 'unknown'; continue; }
      if (!knowsLength) coverage[i] = 'unknown';
      else if (job.pages >= est.pages) coverage[i] = 'full';
      else coverage[i] = !hasFull && partialSum >= est.pages ? 'split' : 'partial';

      // Same document with the same pages per copy earlier in this session:
      // a reprint (whatever the copy count — extra copies are a reprint too).
      const sig = String(job.pages);
      if (seen.has(sig) || (coverage[i] === 'full' && seen.has('full'))) jobFlags[i].add('reprint');
      seen.add(sig);
      if (coverage[i] === 'full') seen.add('full');
    }
  }

  jobs.forEach((job, i) => {
    if (coverage[i] === 'partial') jobFlags[i].add('partial');
    if (coverage[i] === 'split') jobFlags[i].add('split');
    if (job.copies > 1) jobFlags[i].add('copies');
    if (job.color_mode !== 'color' && job.color_mode !== 'mono') jobFlags[i].add('mode_unknown');
    // Printed when the shop is normally closed (opening hours learned from sales).
    const submitted = new Date(ts(job.submitted_at));
    if (!Number.isNaN(submitted.getTime()) && isOffHours(submitted)) jobFlags[i].add('off_hours');
    updateJobAnalysis.run(estimates[i].pages, estimates[i].source, coverage[i], JSON.stringify([...jobFlags[i]]), job.id);
  });

  // Session totals and flags
  const impressions = (j) => (j.impressions ?? j.pages ?? 0);
  const sum = (pred) => jobs.filter(pred).reduce((s, j) => s + impressions(j), 0);
  const burst = maxBurst(jobs.map((j) => ts(j.submitted_at)));
  const concurrent = maxConcurrency(intervals);
  const count = (flag) => jobFlags.filter((f) => f.has(flag)).length;

  const flags = [];
  if (burst >= BURST.jobs) flags.push({ type: 'burst', jobs: burst, seconds: BURST.windowSec });
  if (concurrent >= 2) flags.push({ type: 'concurrent', jobs: concurrent });
  for (const f of ['off_hours', 'partial', 'split', 'reprint', 'copies', 'mode_unknown']) {
    const n = count(f);
    if (n) flags.push({ type: f, jobs: n });
  }

  const starts = intervals.map((iv) => iv[0]).filter(Number.isFinite);
  const ends = intervals.map((iv) => iv[1]).filter(Number.isFinite);
  updateSession.run(
    starts.length ? iso(Math.min(...starts)) : iso(Date.now()),
    ends.length ? iso(Math.max(...ends)) : iso(Date.now()),
    jobs.length,
    groups.size,
    sum((j) => j.color_mode === 'color'),
    sum((j) => j.color_mode === 'mono'),
    sum((j) => j.color_mode !== 'color' && j.color_mode !== 'mono'),
    jobs.reduce((s, j) => s + (j.sheets ?? j.pages ?? 0), 0),
    concurrent,
    JSON.stringify(flags),
    sessionId
  );
}

/** Analyse one freshly inserted job: place it in a session and re-score that session. */
function analyzeJob(jobId) {
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
  if (!job) return;
  const sessionId = job.session_id || assignSession(job);
  if (!job.session_id) db.prepare('UPDATE print_jobs SET session_id = ? WHERE id = ?').run(sessionId, job.id);
  recomputeSession(sessionId);
}

/** Bring jobs recorded before this analysis existed up to date (runs at startup). */
function backfill() {
  const pending = db.prepare('SELECT * FROM print_jobs WHERE session_id IS NULL ORDER BY submitted_at, id').all();
  if (pending.length === 0) return 0;
  const fill = db.prepare('UPDATE print_jobs SET doc_key = ?, impressions = COALESCE(impressions, ?), sheets = COALESCE(sheets, ?) WHERE id = ?');
  db.transaction(() => {
    for (const job of pending) {
      const { impressions, sheets } = physicalCounts({ pages: job.pages, copies: job.copies, duplex: job.duplex });
      fill.run(normalizeDocKey(job.document_name), impressions, sheets, job.id);
      analyzeJob(job.id);
    }
  })();
  return pending.length;
}

// ---------------------------------------------------------------
// Billing suggestion for a session: one cart line per colour mode and
// paper size, priced from the products marked as print services.
// ---------------------------------------------------------------
function suggestLines(sessionId) {
  const rows = db.prepare(`
    SELECT color_mode, paper_size, SUM(COALESCE(impressions, pages, 0)) AS pages
    FROM print_jobs WHERE session_id = ? GROUP BY color_mode, paper_size
  `).all(sessionId);
  const services = db.prepare(`
    SELECT id, name, price, print_color_mode FROM products
    WHERE active = 1 AND print_color_mode IS NOT NULL ORDER BY price ASC, id ASC
  `).all();

  const lines = new Map();
  const unmatched = [];
  for (const r of rows) {
    if (!r.pages) continue;
    if (r.color_mode !== 'color' && r.color_mode !== 'mono') { unmatched.push({ reason: 'mode_unknown', pages: r.pages }); continue; }
    const candidates = services.filter((p) => p.print_color_mode === r.color_mode);
    // Prefer a product whose name mentions the paper size (e.g. "B&W print A3").
    const size = paperLabel(r.paper_size);
    const product = (size && candidates.find((p) => new RegExp(`\\b${size}\\b`, 'i').test(p.name))) ||
      candidates.find((p) => !/\b(A3|A5|Letter|Legal)\b/i.test(p.name)) || candidates[0];
    if (!product) { unmatched.push({ reason: 'no_product', color_mode: r.color_mode, pages: r.pages }); continue; }
    const line = lines.get(product.id) || { product_id: product.id, name: product.name, unit_price: product.price, qty: 0 };
    line.qty += r.pages;
    lines.set(product.id, line);
  }
  return { lines: [...lines.values()], unmatched };
}

module.exports = {
  normalizeDocKey, normalizeMachine, physicalCounts, paperLabel, analyzeJob, recomputeSession,
  backfill, suggestLines, sessionGapMs, maxBurst, maxConcurrency, BURST, GAP
};
