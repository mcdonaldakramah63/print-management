const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireAgent } = require('../middleware/agentAuth');
const { createSale, round2 } = require('../lib/saleCreator');

const router = express.Router();

function buildDedupeKey(agentId, printerName, externalJobId, submittedAt) {
  const day = (submittedAt || '').slice(0, 10) || 'unknown-date';
  return `${agentId}:${printerName}:${externalJobId}:${day}`;
}

function normalizeColorMode(value) {
  if (value === true || value === 'color' || value === 'Color') return 'color';
  if (value === false || value === 'mono' || value === 'Mono' || value === 'monochrome') return 'mono';
  return 'unknown';
}

/**
 * Attempt to automatically bill a freshly-ingested print job.
 * Only bills when there's exactly one active print-service product for the
 * detected color mode and a usable page count — anything less certain is
 * left as a draft for a human to resolve, rather than risking a wrong charge.
 */
function tryAutoBill(printJobId) {
  const settings = db.prepare('SELECT require_manual_print_review FROM settings WHERE id = 1').get();
  if (settings && settings.require_manual_print_review) return; // admin wants every job reviewed by hand

  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(printJobId);
  if (!job || job.status !== 'draft') return;
  if (!job.pages || job.pages <= 0) return;
  if (job.color_mode !== 'color' && job.color_mode !== 'mono') return;

  const candidates = db.prepare(`
    SELECT * FROM products WHERE active = 1 AND print_color_mode = ?
  `).all(job.color_mode);

  if (candidates.length !== 1) {
    // No matching print-service product configured, or more than one —
    // either way an admin needs to pick, so just leave it as a draft.
    return;
  }

  const product = candidates[0];
  const sale = createSale({
    userId: db.systemUserId,
    customerName: `Print job: ${job.submitted_by || 'unknown user'}`,
    items: [{ name: product.name, qty: job.pages, unit_price: product.price, product_id: product.id }],
    discountType: 'amount',
    discountValue: 0
  });

  db.prepare(`
    UPDATE print_jobs
    SET status = 'approved', matched_product_id = ?, sale_id = ?, auto_billed = 1,
        reviewed_at = datetime('now')
    WHERE id = ?
  `).run(product.id, sale.id, printJobId);
}

// ---------------------------------------------------------------
// Agent-facing: ingest one or more detected print jobs.
// Auth: X-Agent-Key header (see middleware/agentAuth.js), not a user session.
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
      submitted_by, pages, size_bytes, color_mode, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const errors = [];
  const insertedIds = [];

  const run = db.transaction((list) => {
    for (const job of list) {
      if (!job.printer_name || !job.external_job_id || !job.submitted_at) {
        errors.push({ job, error: 'printer_name, external_job_id and submitted_at are required' });
        continue;
      }
      const dedupeKey = buildDedupeKey(req.agent.id, job.printer_name, job.external_job_id, job.submitted_at);
      const info = insert.run(
        req.agent.id,
        dedupeKey,
        job.printer_name,
        (job.document_name || '').slice(0, 500),
        (job.submitted_by || '').slice(0, 200),
        Number.isFinite(job.pages) ? job.pages : null,
        Number.isFinite(job.size_bytes) ? job.size_bytes : null,
        normalizeColorMode(job.color_mode),
        job.submitted_at
      );
      if (info.changes > 0) {
        inserted += 1;
        insertedIds.push(info.lastInsertRowid);
      }
    }
  });
  run(jobs);

  // Auto-bill outside the ingest transaction so a billing hiccup on one job
  // can't roll back the whole ingest batch.
  for (const id of insertedIds) {
    try { tryAutoBill(id); } catch (err) { console.error(`Auto-bill failed for print job ${id}:`, err.message); }
  }

  res.json({ received: jobs.length, inserted, duplicates: jobs.length - inserted - errors.length, errors });
});

// ---------------------------------------------------------------
// Admin-facing: review queue
// ---------------------------------------------------------------
router.get('/', requireAuth, (req, res) => {
  const { status, agent_id, printer, from, to } = req.query;

  let sql = `
    SELECT pj.*, a.label AS agent_label, u.full_name AS reviewed_by_name,
           p.name AS matched_product_name, p.price AS matched_product_price
    FROM print_jobs pj
    JOIN agents a ON a.id = pj.agent_id
    LEFT JOIN users u ON u.id = pj.reviewed_by
    LEFT JOIN products p ON p.id = pj.matched_product_id
    WHERE 1=1
  `;
  const params = [];

  if (status) { sql += ' AND pj.status = ?'; params.push(status); }
  if (agent_id) { sql += ' AND pj.agent_id = ?'; params.push(Number(agent_id)); }
  if (printer) { sql += ' AND pj.printer_name LIKE ?'; params.push(`%${printer}%`); }
  if (from) { sql += ' AND date(pj.submitted_at) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(pj.submitted_at) <= date(?)'; params.push(to); }

  sql += ' ORDER BY pj.submitted_at DESC LIMIT 500';

  const jobs = db.prepare(sql).all(...params);
  res.json({ jobs });
});

// Manually approve a draft job: pick (or confirm) the print product it bills
// against, create the sale, and mark it billed. Used whenever auto-billing
// couldn't resolve a single confident match (see tryAutoBill above).
router.patch('/:id/approve', requireAdmin, (req, res) => {
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Print job not found' });
  if (job.status !== 'draft') return res.status(400).json({ error: 'Only pending jobs can be approved' });

  const productId = Number(req.body.product_id);
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return res.status(400).json({ error: 'Choose a valid, active product to bill this job against' });

  const pages = Number(req.body.pages) > 0 ? Number(req.body.pages) : job.pages;
  if (!pages || pages <= 0) {
    return res.status(400).json({ error: 'This job has no usable page count — enter one to approve it' });
  }

  let sale;
  try {
    sale = createSale({
      userId: req.session.user.id,
      customerName: `Print job: ${job.submitted_by || 'unknown user'}`,
      items: [{ name: product.name, qty: pages, unit_price: product.price, product_id: product.id }],
      discountType: 'amount',
      discountValue: 0
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  db.prepare(`
    UPDATE print_jobs
    SET status = 'approved', matched_product_id = ?, sale_id = ?, auto_billed = 0,
        pages = ?, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(product.id, sale.id, pages, req.session.user.id, job.id);

  res.json({ ok: true, sale_id: sale.id, receipt_no: sale.receipt_no });
});

// Reject a draft job — it stays in the log (never deleted) with an optional
// note explaining why, so there's still a record even when nothing is billed.
router.patch('/:id/reject', requireAdmin, (req, res) => {
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Print job not found' });
  if (job.status !== 'draft') return res.status(400).json({ error: 'Only pending jobs can be rejected' });

  db.prepare(`
    UPDATE print_jobs
    SET status = 'rejected', note = ?, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run((req.body.note || '').slice(0, 500), req.session.user.id, job.id);

  res.json({ ok: true });
});

router.patch('/bulk-reject', requireAdmin, (req, res) => {
  const { ids, note } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }

  const update = db.prepare(`
    UPDATE print_jobs
    SET status = 'rejected', note = ?, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ? AND status = 'draft'
  `);
  const run = db.transaction((list) => {
    for (const id of list) update.run((note || '').slice(0, 500), req.session.user.id, id);
  });
  run(ids);

  res.json({ ok: true, updated: ids.length });
});

module.exports = router;
