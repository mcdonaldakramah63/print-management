const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { requireAgent } = require('../middleware/agentAuth');
const analysis = require('../lib/printAnalysis');
const { ingestCopyEvents } = require('../lib/copies');

const router = express.Router();

function buildDedupeKey(agentId, printerName, externalJobId, submittedAt) {
  const day = String(submittedAt || '').slice(0, 10) || 'unknown-date';
  return `${agentId}:${printerName}:${externalJobId}:${day}`;
}

function normalizeColorMode(value) {
  if (value === true || value === 'color' || value === 'Color') return 'color';
  if (value === false || value === 'mono' || value === 'Mono' || value === 'monochrome' || value === 'Monochrome') return 'mono';
  return 'unknown';
}

// submitted_at is the agent's local timestamp with its UTC offset
// (e.g. "2026-09-19T23:30:00.0000000+02:00"). SQLite's date() would convert
// that to a UTC date, putting late-evening jobs on the next/previous day, so
// filter and group on the wall-clock date the job was printed instead.
const JOB_DAY = 'substr(pj.submitted_at, 1, 10)';

function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const parsed = ids.map(Number);
  return parsed.every(Number.isInteger) ? parsed : null;
}

function normalizeDuplex(value) {
  if (value === true || value === 'duplex' || value === 'Duplex') return 'duplex';
  if (value === false || value === 'simplex' || value === 'Simplex') return 'simplex';
  return 'unknown';
}

// ---------------------------------------------------------------
// Agent-facing: ingest one or more detected print jobs.
// Auth: X-Agent-Key header (see middleware/agentAuth.js), not a user session.
// This is a pure detection log — nothing here creates a sale. It exists so
// an admin can see what was actually printed each day and compare that
// against what was rung up at the register themselves.
// ---------------------------------------------------------------
router.post('/ingest', requireAgent, (req, res) => {
  const jobs = Array.isArray(req.body.jobs) ? req.body.jobs : (req.body.job ? [req.body.job] : []);

  if (jobs.length === 0) {
    // Empty batch is a valid heartbeat — requireAgent already touched last_seen_at.
    return res.json({ received: 0, inserted: 0, duplicates: 0 });
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO print_jobs (
      agent_id, dedupe_key, printer_name, document_name,
      submitted_by, pages, size_bytes, color_mode, duplex, submitted_at,
      copies, collated, paper_size, client_machine, completed_at, settings_source,
      document_pages, document_pages_source, doc_key, impressions, sheets
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
  let inserted = 0;
  const errors = [];
  const insertedIds = [];

  const run = db.transaction((list) => {
    for (const job of list) {
      if (!job || typeof job !== 'object' ||
          !job.printer_name || !job.external_job_id || !job.submitted_at) {
        errors.push({ job, error: 'printer_name, external_job_id and submitted_at are required' });
        continue;
      }
      const dedupeKey = buildDedupeKey(req.agent.id, job.printer_name, job.external_job_id, job.submitted_at);
      const pages = Number.isFinite(job.pages) && job.pages >= 0 ? Math.round(job.pages) : null;
      const copies = posInt(job.copies);
      const duplex = normalizeDuplex(job.duplex);
      const documentName = String(job.document_name || '').slice(0, 500);
      const { impressions, sheets } = analysis.physicalCounts({ pages, copies, duplex });
      const completedAt = job.completed_at && !Number.isNaN(Date.parse(job.completed_at)) ? String(job.completed_at) : new Date().toISOString();
      const info = insert.run(
        req.agent.id,
        dedupeKey,
        String(job.printer_name),
        documentName,
        String(job.submitted_by || '').slice(0, 200),
        pages,
        Number.isFinite(job.size_bytes) ? job.size_bytes : null,
        normalizeColorMode(job.color_mode),
        duplex,
        String(job.submitted_at),
        copies,
        job.collate === true ? 1 : job.collate === false ? 0 : null,
        analysis.paperLabel(job.paper_size),
        analysis.normalizeMachine(job.client_machine).slice(0, 100),
        completedAt,
        job.settings_source === 'devmode' ? 'devmode' : '',
        posInt(job.document_pages),
        posInt(job.document_pages) ? String(job.document_pages_source || '').slice(0, 20) : '',
        analysis.normalizeDocKey(documentName),
        impressions,
        sheets
      );
      if (info.changes > 0) {
        inserted += 1;
        insertedIds.push(info.lastInsertRowid);
      }
    }
  });
  run(jobs);

  // Analyse after the insert commits, oldest first, so a failure in the
  // analysis can never lose a reported job.
  for (const id of insertedIds) {
    try {
      analysis.analyzeJob(id);
    } catch (err) {
      console.error(`Print analysis failed for job ${id}:`, err.message);
    }
  }

  res.json({ received: jobs.length, inserted, duplicates: jobs.length - inserted - errors.length, errors });
});

// ---------------------------------------------------------------
// Agent-facing: toner / ink levels and the device page counter (SNMP).
// ---------------------------------------------------------------
router.post('/supplies', requireAgent, (req, res) => {
  const readings = Array.isArray(req.body.readings) ? req.body.readings.slice(0, 50) : [];
  const insertSupply = db.prepare(`
    INSERT INTO supply_readings (agent_id, printer_name, supply_index, description, colorant, kind, receptacle, percent, some_remaining, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCounter = db.prepare(`
    INSERT INTO device_counters (agent_id, printer_name, model, address, life_count, read_at) VALUES (?, ?, ?, ?, ?, ?)
  `);
  let stored = 0;
  db.transaction(() => {
    for (const r of readings) {
      if (!r || !r.printer_name) continue;
      const readAt = r.read_at && !Number.isNaN(Date.parse(r.read_at)) ? new Date(r.read_at).toISOString() : new Date().toISOString();
      const printer = String(r.printer_name).slice(0, 200);
      insertCounter.run(req.agent.id, printer, String(r.model || '').slice(0, 120), String(r.address || '').slice(0, 100),
        Number.isFinite(r.life_count) ? Math.round(r.life_count) : null, readAt);
      for (const s of Array.isArray(r.supplies) ? r.supplies.slice(0, 40) : []) {
        const pct = Number.isFinite(s.percent) ? Math.max(0, Math.min(100, s.percent)) : null;
        insertSupply.run(req.agent.id, printer, String(s.index || '').slice(0, 40), String(s.description || '').slice(0, 120),
          String(s.colorant || '').slice(0, 40), String(s.kind || 'other').slice(0, 30), s.receptacle ? 1 : 0, pct, s.some_remaining ? 1 : 0, readAt);
        stored++;
      }
    }
    // Keep 180 days of readings.
    db.prepare("DELETE FROM supply_readings WHERE read_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days')").run();
    db.prepare("DELETE FROM device_counters WHERE read_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days')").run();
  })();
  res.json({ ok: true, stored });
});

// Photocopy runs the agent found on a printer's page counter.
router.post('/copies', requireAgent, (req, res) => {
  res.json({ ok: true, ...ingestCopyEvents(req.agent.id, req.body.events) });
});

// ---------------------------------------------------------------
// Admin-facing: the log itself
// ---------------------------------------------------------------
router.get('/', requireAdmin, (req, res) => {
  const { status, agent_id, printer, from, to } = req.query;

  let sql = `
    SELECT pj.*, a.label AS agent_label, u.full_name AS reviewed_by_name
    FROM print_jobs pj
    JOIN agents a ON a.id = pj.agent_id
    LEFT JOIN users u ON u.id = pj.reviewed_by
    WHERE 1=1
  `;
  const params = [];

  if (status) { sql += ' AND pj.status = ?'; params.push(status); }
  if (agent_id) { sql += ' AND pj.agent_id = ?'; params.push(Number(agent_id)); }
  if (printer) { sql += ' AND pj.printer_name LIKE ?'; params.push(`%${printer}%`); }
  if (from) { sql += ` AND ${JOB_DAY} >= ?`; params.push(from); }
  if (to) { sql += ` AND ${JOB_DAY} <= ?`; params.push(to); }

  sql += ' ORDER BY pj.submitted_at DESC LIMIT 500';

  const jobs = db.prepare(sql).all(...params);
  res.json({ jobs });
});

// Daily summary: total jobs, color/mono/duplex/simplex breakdown, total
// pages — the "how much was printed today" view for reconciling against
// the till. Defaults to today; pass ?date=YYYY-MM-DD for any other day.
router.get('/summary', requireAdmin, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : localToday();

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS job_count,
      COALESCE(SUM(COALESCE(impressions, pages)), 0) AS total_pages,
      COALESCE(SUM(COALESCE(sheets, pages)), 0) AS total_sheets,
      COALESCE(SUM(CASE WHEN color_mode = 'color' THEN 1 ELSE 0 END), 0) AS color_jobs,
      COALESCE(SUM(CASE WHEN color_mode = 'mono' THEN 1 ELSE 0 END), 0) AS mono_jobs,
      COALESCE(SUM(CASE WHEN color_mode = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_color_jobs,
      COALESCE(SUM(CASE WHEN duplex = 'duplex' THEN 1 ELSE 0 END), 0) AS duplex_jobs,
      COALESCE(SUM(CASE WHEN duplex = 'simplex' THEN 1 ELSE 0 END), 0) AS simplex_jobs,
      COALESCE(SUM(CASE WHEN color_mode = 'color' THEN COALESCE(impressions, pages) ELSE 0 END), 0) AS color_pages,
      COALESCE(SUM(CASE WHEN color_mode = 'mono' THEN COALESCE(impressions, pages) ELSE 0 END), 0) AS mono_pages,
      COALESCE(SUM(CASE WHEN coverage IN ('partial') THEN 1 ELSE 0 END), 0) AS partial_jobs,
      COALESCE(SUM(CASE WHEN copies > 1 THEN 1 ELSE 0 END), 0) AS multi_copy_jobs,
      COUNT(DISTINCT session_id) AS sessions
    FROM print_jobs pj
    WHERE ${JOB_DAY} = ?
  `).get(date);

  const byPrinter = db.prepare(`
    SELECT printer_name, COUNT(*) AS job_count, COALESCE(SUM(COALESCE(impressions, pages)), 0) AS total_pages
    FROM print_jobs pj
    WHERE ${JOB_DAY} = ?
    GROUP BY printer_name
    ORDER BY job_count DESC
  `).all(date);

  res.json({ date, totals, byPrinter });
});

// Mark a job reviewed — an admin has looked at it and it checks out
// (matches something rung up, or is otherwise accounted for).
router.patch('/:id/review', requireAdmin, (req, res) => {
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Print job not found' });

  db.prepare(`
    UPDATE print_jobs SET status = 'approved', note = '', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(req.session.user.id, job.id);

  res.json({ ok: true });
});

// Flag a job — an admin has spotted something that doesn't add up (no
// matching sale, unexpected volume, etc.) and wants it on record.
router.patch('/:id/flag', requireAdmin, (req, res) => {
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Print job not found' });

  db.prepare(`
    UPDATE print_jobs SET status = 'rejected', note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(String(req.body.note || '').slice(0, 500), req.session.user.id, job.id);

  res.json({ ok: true });
});

router.patch('/bulk-review', requireAdmin, (req, res) => {
  const ids = parseIds(req.body.ids);
  if (!ids) {
    return res.status(400).json({ error: 'ids must be a non-empty array of job ids' });
  }
  const update = db.prepare(`
    UPDATE print_jobs SET status = 'approved', note = '', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?
  `);
  let updated = 0;
  const run = db.transaction((list) => { for (const id of list) updated += update.run(req.session.user.id, id).changes; });
  run(ids);
  res.json({ ok: true, updated });
});

router.patch('/bulk-flag', requireAdmin, (req, res) => {
  const ids = parseIds(req.body.ids);
  const note = String(req.body.note || '');
  if (!ids) {
    return res.status(400).json({ error: 'ids must be a non-empty array of job ids' });
  }
  const update = db.prepare(`
    UPDATE print_jobs SET status = 'rejected', note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?
  `);
  let updated = 0;
  const run = db.transaction((list) => { for (const id of list) updated += update.run(note.slice(0, 500), req.session.user.id, id).changes; });
  run(ids);
  res.json({ ok: true, updated });
});

module.exports = router;
