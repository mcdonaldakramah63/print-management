const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { createSale, isDayClosed, PAYMENT_METHODS } = require('../lib/saleCreator');
const { moveStock } = require('../lib/stock');
const { SALE_DAY, isDateString } = require('../lib/dates');
const { sendCsv } = require('../lib/csv');

const router = express.Router();

// Create a new sale (any logged-in user)
router.post('/', requireAuth, (req, res) => {
  const {
    customer_name, customer_phone, items, discount_type, discount_value,
    payment_method, amount_tendered, print_session_ids, copy_event_ids
  } = req.body;

  try {
    const result = createSale({
      userId: req.session.user.id,
      customerName: customer_name,
      customerPhone: customer_phone,
      items,
      discountType: discount_type,
      discountValue: discount_value,
      paymentMethod: payment_method,
      amountTendered: amount_tendered,
      printSessionIds: print_session_ids,
      copyEventIds: copy_event_ids
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Shared WHERE clause for the list and the CSV export.
function buildFilters(query) {
  const { from, to, q, cashier_id, payment_method, status } = query;
  let where = 'WHERE 1=1';
  const params = [];

  // created_at is stored in UTC; compare on the local calendar date the
  // user picked in the filter.
  if (isDateString(from)) { where += ` AND ${SALE_DAY} >= ?`; params.push(from); }
  if (isDateString(to)) { where += ` AND ${SALE_DAY} <= ?`; params.push(to); }
  if (cashier_id) { where += ' AND s.user_id = ?'; params.push(Number(cashier_id)); }
  if (PAYMENT_METHODS.includes(payment_method)) { where += ' AND s.payment_method = ?'; params.push(payment_method); }
  if (status === 'voided') where += ' AND s.voided = 1';
  if (status === 'completed') where += ' AND s.voided = 0';
  if (q) {
    where += ' AND (s.receipt_no LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  return { where, params };
}

// List sales (paginated, filterable) — any logged-in user sees all sales
router.get('/', requireAuth, (req, res) => {
  const { where, params } = buildFilters(req.query);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const totals = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN s.voided = 0 THEN s.total END), 0) AS revenue,
           COALESCE(SUM(s.voided), 0) AS voided
    FROM sales s ${where}
  `).get(...params);

  const sales = db.prepare(`
    SELECT s.*, u.full_name AS cashier_name
    FROM sales s JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  res.json({
    sales,
    page,
    limit,
    total: totals.count,
    pages: Math.max(1, Math.ceil(totals.count / limit)),
    summary: { revenue: totals.revenue, voided: totals.voided }
  });
});

// CSV export of the same filtered list (no pagination)
router.get('/export.csv', requireAuth, (req, res) => {
  const { where, params } = buildFilters(req.query);
  const rows = db.prepare(`
    SELECT s.*, u.full_name AS cashier_name
    FROM sales s JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY s.created_at ASC, s.id ASC
  `).all(...params);

  sendCsv(res, 'sales.csv',
    ['Receipt', 'Date (UTC)', 'Customer', 'Phone', 'Cashier', 'Payment', 'Subtotal', 'Discount', 'Tax', 'Total', 'Tendered', 'Change', 'Status'],
    rows.map((s) => [
      s.receipt_no, s.created_at, s.customer_name, s.customer_phone, s.cashier_name, s.payment_method,
      s.subtotal, s.discount_amount, s.tax_amount, s.total, s.amount_tendered, s.change_due,
      s.voided ? 'voided' : 'completed'
    ]));
});

// Get one sale with its items (for viewing/printing a receipt)
router.get('/:id', requireAuth, (req, res) => {
  const sale = db.prepare(`
    SELECT s.*, u.full_name AS cashier_name, vu.full_name AS voided_by_name
    FROM sales s JOIN users u ON u.id = s.user_id
    LEFT JOIN users vu ON vu.id = s.voided_by
    WHERE s.id = ?
  `).get(req.params.id);

  if (!sale) return res.status(404).json({ error: 'Sale not found' });

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
  res.json({ sale, items });
});

// Void a sale (admin only) — keeps history but flags it, and puts any
// tracked stock it consumed back on the shelf.
router.patch('/:id/void', requireAdmin, (req, res) => {
  const sale = db.prepare(`SELECT id, voided, date(created_at, 'localtime') AS day FROM sales WHERE id = ?`).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  if (sale.voided) return res.status(400).json({ error: 'This sale is already voided' });
  if (isDayClosed(sale.day)) {
    return res.status(400).json({ error: `${sale.day} has been closed. Reopen that day in Reports before voiding its sales.` });
  }

  const items = db.prepare('SELECT product_id, qty FROM sale_items WHERE sale_id = ? AND product_id IS NOT NULL').all(sale.id);
  const userId = req.session.user.id;

  db.transaction(() => {
    db.prepare(`UPDATE sales SET voided = 1, voided_at = datetime('now'), voided_by = ? WHERE id = ?`).run(userId, sale.id);
    // Print sessions this sale billed become unbilled again so they can be re-rung.
    db.prepare('UPDATE print_sessions SET sale_id = NULL, billed_at = NULL WHERE sale_id = ?').run(sale.id);
    db.prepare("UPDATE copy_events SET status = 'open', sale_id = NULL, billed_at = NULL WHERE sale_id = ?").run(sale.id);
    for (const item of items) {
      moveStock({ productId: item.product_id, delta: item.qty, reason: 'void', saleId: sale.id, userId });
    }
  })();

  res.json({ ok: true });
});

module.exports = router;
