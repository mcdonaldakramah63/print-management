const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { round2 } = require('../lib/saleCreator');
const { SALE_DAY, isDateString, localDateString, saleSpan } = require('../lib/dates');
const { sendCsv } = require('../lib/csv');

const router = express.Router();

// from/to default to the current month so far.
function readRange(query) {
  const today = localDateString();
  const from = isDateString(query.from) ? query.from : `${today.slice(0, 8)}01`;
  const to = isDateString(query.to) ? query.to : today;
  return from <= to ? { from, to } : { from: to, to: from };
}

// ---------------------------------------------------------------
// Sales report for a date range
// ---------------------------------------------------------------
router.get('/summary', requireAuth, (req, res) => {
  const { from, to } = readRange(req.query);
  const range = `${SALE_DAY} BETWEEN ? AND ? AND ${saleSpan(from, to)}`;

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(total), 0) AS revenue,
      COALESCE(SUM(discount_amount), 0) AS discounts,
      COALESCE(SUM(tax_amount), 0) AS tax
    FROM sales s WHERE s.voided = 0 AND ${range}
  `).get(from, to);
  const voided = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS value FROM sales s WHERE s.voided = 1 AND ${range}
  `).get(from, to);

  const byItem = db.prepare(`
    SELECT si.name, SUM(si.qty) AS qty, SUM(si.line_total) AS revenue
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND ${range}
    GROUP BY si.name ORDER BY revenue DESC LIMIT 25
  `).all(from, to);

  const byCashier = db.prepare(`
    SELECT u.id, u.full_name AS name, COUNT(*) AS count, SUM(s.total) AS revenue
    FROM sales s JOIN users u ON u.id = s.user_id
    WHERE s.voided = 0 AND ${range}
    GROUP BY u.id ORDER BY revenue DESC
  `).all(from, to);

  const byPayment = db.prepare(`
    SELECT s.payment_method AS method, COUNT(*) AS count, SUM(s.total) AS revenue
    FROM sales s WHERE s.voided = 0 AND ${range}
    GROUP BY s.payment_method ORDER BY revenue DESC
  `).all(from, to);

  const daily = db.prepare(`
    SELECT ${SALE_DAY} AS day, COUNT(*) AS count, SUM(s.total) AS revenue
    FROM sales s WHERE s.voided = 0 AND ${range}
    GROUP BY day ORDER BY day
  `).all(from, to);

  res.json({
    from, to,
    totals: {
      ...totals,
      average: totals.count ? round2(totals.revenue / totals.count) : 0,
      voided_count: voided.count,
      voided_value: voided.value
    },
    byItem, byCashier, byPayment, daily
  });
});

// Line-item CSV for a date range (one row per item sold)
router.get('/export.csv', requireAuth, (req, res) => {
  const { from, to } = readRange(req.query);
  const rows = db.prepare(`
    SELECT s.receipt_no, s.created_at, ${SALE_DAY} AS day, u.full_name AS cashier, s.customer_name,
           s.payment_method, si.name, si.qty, si.unit_price, si.line_total, s.voided
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN users u ON u.id = s.user_id
    WHERE ${SALE_DAY} BETWEEN ? AND ? AND ${saleSpan(from, to)}
    ORDER BY s.created_at, s.id, si.id
  `).all(from, to);

  sendCsv(res, `sales-report-${from}-to-${to}.csv`,
    ['Receipt', 'Date (UTC)', 'Business day', 'Cashier', 'Customer', 'Payment', 'Item', 'Qty', 'Unit price', 'Line total', 'Status'],
    rows.map((r) => [r.receipt_no, r.created_at, r.day, r.cashier, r.customer_name, r.payment_method,
      r.name, r.qty, r.unit_price, r.line_total, r.voided ? 'voided' : 'completed']));
});

// ---------------------------------------------------------------
// End-of-day close (Z-report)
// ---------------------------------------------------------------
function dayFigures(date) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN voided = 0 THEN 1 ELSE 0 END), 0) AS sales_count,
      COALESCE(SUM(CASE WHEN voided = 1 THEN 1 ELSE 0 END), 0) AS voided_count,
      COALESCE(SUM(CASE WHEN voided = 0 THEN total END), 0) AS gross_total,
      COALESCE(SUM(CASE WHEN voided = 0 AND payment_method = 'cash' THEN total END), 0) AS cash_total,
      COALESCE(SUM(CASE WHEN voided = 0 AND payment_method = 'momo' THEN total END), 0) AS momo_total,
      COALESCE(SUM(CASE WHEN voided = 0 AND payment_method = 'card' THEN total END), 0) AS card_total
    FROM sales s WHERE ${SALE_DAY} = ? AND ${saleSpan(date, date)}
  `).get(date);
  for (const k of ['gross_total', 'cash_total', 'momo_total', 'card_total']) row[k] = round2(row[k]);

  row.byCashier = db.prepare(`
    SELECT u.full_name AS name, COUNT(*) AS count, SUM(s.total) AS revenue,
           SUM(CASE WHEN s.payment_method = 'cash' THEN s.total ELSE 0 END) AS cash
    FROM sales s JOIN users u ON u.id = s.user_id
    WHERE s.voided = 0 AND ${SALE_DAY} = ? AND ${saleSpan(date, date)}
    GROUP BY u.id ORDER BY revenue DESC
  `).all(date);
  return row;
}

function closingFor(date) {
  return db.prepare(`
    SELECT c.*, u.full_name AS closed_by_name
    FROM day_closings c JOIN users u ON u.id = c.closed_by
    WHERE c.business_date = ?
  `).get(date) || null;
}

router.get('/close', requireAuth, (req, res) => {
  const date = isDateString(req.query.date) ? req.query.date : localDateString();
  res.json({ date, figures: dayFigures(date), closing: closingFor(date) });
});

router.post('/close', requireAuth, (req, res) => {
  const date = isDateString(req.body.date) ? req.body.date : localDateString();
  if (date > localDateString()) return res.status(400).json({ error: 'You cannot close a day that has not happened yet' });

  const counted = Number(req.body.cash_counted);
  if (req.body.cash_counted === '' || req.body.cash_counted == null || !Number.isFinite(counted) || counted < 0) {
    return res.status(400).json({ error: 'Enter the cash counted in the drawer' });
  }
  if (closingFor(date)) return res.status(409).json({ error: `${date} is already closed` });

  const f = dayFigures(date);
  db.prepare(`
    INSERT INTO day_closings (
      business_date, sales_count, voided_count, gross_total, cash_total, momo_total, card_total,
      cash_counted, variance, note, closed_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, f.sales_count, f.voided_count, f.gross_total, f.cash_total, f.momo_total, f.card_total,
    round2(counted), round2(counted - f.cash_total), String(req.body.note || '').slice(0, 500), req.session.user.id);

  res.status(201).json({ ok: true, closing: closingFor(date) });
});

// Reopen a closed day (admin only) so late sales or voids can be recorded;
// it can then be closed again with fresh figures.
router.delete('/close/:date', requireAdmin, (req, res) => {
  if (!isDateString(req.params.date)) return res.status(400).json({ error: 'Invalid date' });
  const info = db.prepare('DELETE FROM day_closings WHERE business_date = ?').run(req.params.date);
  if (info.changes === 0) return res.status(404).json({ error: 'That day is not closed' });
  res.json({ ok: true });
});

router.get('/closings', requireAuth, (req, res) => {
  const closings = db.prepare(`
    SELECT c.*, u.full_name AS closed_by_name
    FROM day_closings c JOIN users u ON u.id = c.closed_by
    ORDER BY c.business_date DESC LIMIT 30
  `).all();
  res.json({ closings });
});

module.exports = router;
