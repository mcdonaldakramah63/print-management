const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { createSale } = require('../lib/saleCreator');

const router = express.Router();

// Create a new sale (any logged-in user)
router.post('/', requireAuth, (req, res) => {
  const { customer_name, items, discount_type, discount_value } = req.body;

  try {
    const result = createSale({
      userId: req.session.user.id,
      customerName: customer_name,
      items,
      discountType: discount_type,
      discountValue: discount_value
    });
    res.status(201).json({ id: result.id, receipt_no: result.receipt_no });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List sales (with optional filters) — any logged-in user sees all sales
router.get('/', requireAuth, (req, res) => {
  const { from, to, q, cashier_id } = req.query;

  let sql = `
    SELECT s.*, u.full_name AS cashier_name
    FROM sales s JOIN users u ON u.id = s.user_id
    WHERE 1=1
  `;
  const params = [];

  if (from) { sql += ' AND date(s.created_at) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(s.created_at) <= date(?)'; params.push(to); }
  if (cashier_id) { sql += ' AND s.user_id = ?'; params.push(Number(cashier_id)); }
  if (q) { sql += ' AND (s.receipt_no LIKE ? OR s.customer_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

  sql += ' ORDER BY s.created_at DESC LIMIT 500';

  const sales = db.prepare(sql).all(...params);
  res.json({ sales });
});

// Get one sale with its items (for viewing/printing a receipt)
router.get('/:id', requireAuth, (req, res) => {
  const sale = db.prepare(`
    SELECT s.*, u.full_name AS cashier_name
    FROM sales s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!sale) return res.status(404).json({ error: 'Sale not found' });

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
  res.json({ sale, items });
});

// Void a sale (admin only) — keeps history but flags it
router.patch('/:id/void', requireAdmin, (req, res) => {
  db.prepare('UPDATE sales SET voided = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
