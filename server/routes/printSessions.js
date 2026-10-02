const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { suggestLines } = require('../lib/printAnalysis');
const { isDateString, localDateString } = require('../lib/dates');

const router = express.Router();

const parseJson = (s) => { try { return JSON.parse(s); } catch (_) { return []; } };

function withJobs(sessions) {
  if (sessions.length === 0) return sessions;
  const jobs = db.prepare(`
    SELECT id, session_id, document_name, printer_name, pages, copies, impressions, sheets, color_mode, duplex,
           paper_size, submitted_at, completed_at, document_pages, document_pages_source, est_document_pages,
           est_source, coverage, flags, status, note, settings_source
    FROM print_jobs WHERE session_id IN (${sessions.map(() => '?').join(',')})
    ORDER BY submitted_at, id
  `).all(...sessions.map((s) => s.id));
  const bySession = new Map(sessions.map((s) => [s.id, []]));
  for (const j of jobs) bySession.get(j.session_id).push({ ...j, flags: parseJson(j.flags) });
  return sessions.map((s) => ({ ...s, flags: parseJson(s.flags), jobs: bySession.get(s.id) }));
}

const SESSION_SELECT = `
  SELECT ps.*, a.label AS agent_label, s.receipt_no,
    (SELECT COUNT(*) FROM print_jobs j WHERE j.session_id = ps.id AND j.status = 'draft') AS unreviewed
  FROM print_sessions ps
  JOIN agents a ON a.id = ps.agent_id
  LEFT JOIN sales s ON s.id = ps.sale_id
`;

// Admin: every client session that had a job on a given day.
router.get('/', requireAdmin, (req, res) => {
  const date = isDateString(req.query.date) ? req.query.date : localDateString();
  let sql = `${SESSION_SELECT} WHERE ps.id IN (SELECT session_id FROM print_jobs WHERE substr(submitted_at, 1, 10) = ?)`;
  if (req.query.billing === 'unbilled') sql += ' AND ps.sale_id IS NULL';
  if (req.query.billing === 'billed') sql += ' AND ps.sale_id IS NOT NULL';
  if (req.query.flagged === '1') sql += " AND ps.flags != '[]'";
  sql += ' ORDER BY ps.ended_at DESC LIMIT 300';
  res.json({ date, sessions: withJobs(db.prepare(sql).all(date)) });
});

// Checkout: recent unbilled sessions, each with suggested cart lines.
router.get('/open', requireAuth, (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 12, 1), 72);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const sessions = withJobs(db.prepare(`${SESSION_SELECT} WHERE ps.sale_id IS NULL AND ps.ended_at >= ? ORDER BY ps.ended_at DESC LIMIT 30`).all(since));
  res.json({ sessions: sessions.map((s) => ({ ...s, suggestion: suggestLines(s.id) })) });
});

function setStatus(sessionId, status, note, userId) {
  return db.prepare(`
    UPDATE print_jobs SET status = ?, note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE session_id = ?
  `).run(status, note, userId, sessionId).changes;
}

router.patch('/:id/review', requireAdmin, (req, res) => {
  const updated = setStatus(Number(req.params.id), 'approved', '', req.session.user.id);
  if (!updated) return res.status(404).json({ error: 'Print session not found' });
  res.json({ ok: true, updated });
});

router.patch('/:id/flag', requireAdmin, (req, res) => {
  const updated = setStatus(Number(req.params.id), 'rejected', String(req.body.note || '').slice(0, 500), req.session.user.id);
  if (!updated) return res.status(404).json({ error: 'Print session not found' });
  res.json({ ok: true, updated });
});

// Confirm that an unbilled session was paid for by an existing sale (e.g. the
// cashier rang it up by hand). Links them so it counts as billed.
router.patch('/:id/link', requireAdmin, (req, res) => {
  const saleId = Number(req.body.sale_id);
  const sale = db.prepare('SELECT id, voided FROM sales WHERE id = ?').get(saleId);
  if (!sale || sale.voided) return res.status(400).json({ error: 'Choose a valid, non-voided sale' });
  if (db.prepare('SELECT 1 FROM print_sessions WHERE sale_id = ?').get(saleId)) {
    return res.status(409).json({ error: 'That sale already bills another print session' });
  }
  const info = db.prepare(`UPDATE print_sessions SET sale_id = ?, billed_at = datetime('now') WHERE id = ? AND sale_id IS NULL`).run(saleId, Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Print session not found or already billed' });
  res.json({ ok: true });
});

module.exports = router;
