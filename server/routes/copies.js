const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const copies = require('../lib/copies');
const { isDateString, localDateString } = require('../lib/dates');

const router = express.Router();

// Admin: photocopy runs detected on a given day.
router.get('/', requireAdmin, (req, res) => {
  const date = isDateString(req.query.date) ? req.query.date : localDateString();
  res.json({ date, copies: copies.listCopies(date, req.query.status) });
});

// Checkout: recent copy runs nobody has rung up yet, with suggested lines.
router.get('/open', requireAuth, (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 12, 1), 72);
  res.json({ copies: copies.openCopies(hours) });
});

// Not a sale: a test / report page, the shop's own copies, a misread.
router.patch('/:id/dismiss', requireAdmin, (req, res) => {
  const note = String(req.body.note || '').trim().slice(0, 300);
  if (!copies.setStatus(Number(req.params.id), 'dismissed', note, req.session.user.id)) {
    return res.status(404).json({ error: 'Photocopy run not found or already billed' });
  }
  res.json({ ok: true });
});

router.patch('/:id/restore', requireAdmin, (req, res) => {
  if (!copies.setStatus(Number(req.params.id), 'open', '', req.session.user.id)) {
    return res.status(404).json({ error: 'Photocopy run not found or already billed' });
  }
  res.json({ ok: true });
});

// The copies were paid for in an existing sale (rung up by hand).
router.patch('/:id/link', requireAdmin, (req, res) => {
  const saleId = Number(req.body.sale_id);
  const sale = db.prepare('SELECT id, voided FROM sales WHERE id = ?').get(saleId);
  if (!sale || sale.voided) return res.status(400).json({ error: 'Choose a valid, non-voided sale' });
  const info = db.prepare(`
    UPDATE copy_events SET status = 'billed', sale_id = ?, billed_at = datetime('now') WHERE id = ? AND status = 'open'
  `).run(saleId, Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Photocopy run not found or not open' });
  res.json({ ok: true });
});

module.exports = router;
