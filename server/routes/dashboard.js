const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { reconcile } = require('./reconciliation');
const { localDateString } = require('../lib/dates');

const router = express.Router();

// sales.created_at is stored in UTC (datetime('now')), so every date
// comparison converts it to local time first — otherwise sales made in the
// hours around midnight land on the wrong day.
function localDayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

router.get('/summary', requireAuth, (req, res) => {
  const today = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS count
    FROM sales WHERE voided = 0 AND date(created_at,'localtime') = date('now','localtime') AND created_at >= date('now','localtime','-1 day')
  `).get();

  const last7Days = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS count
    FROM sales WHERE voided = 0 AND date(created_at,'localtime') >= date('now','localtime','-6 days') AND created_at >= date('now','localtime','-6 days','-1 day')
  `).get();

  const thisMonth = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS count
    FROM sales WHERE voided = 0 AND strftime('%Y-%m', created_at,'localtime') = strftime('%Y-%m','now','localtime') AND created_at >= date('now','localtime','start of month','-1 day')
  `).get();

  // Daily revenue for the last 14 days, filled in so days with no sales still show as 0
  const rawSeries = db.prepare(`
    SELECT date(created_at,'localtime') AS day, SUM(total) AS revenue
    FROM sales
    WHERE voided = 0 AND date(created_at,'localtime') >= date('now','localtime','-13 days') AND created_at >= date('now','localtime','-13 days','-1 day')
    GROUP BY day
  `).all();
  const seriesMap = Object.fromEntries(rawSeries.map((r) => [r.day, r.revenue]));
  const dailySeries = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDayKey(d);
    dailySeries.push({ day: key, revenue: seriesMap[key] || 0 });
  }

  const topItems = db.prepare(`
    SELECT si.name, SUM(si.qty) AS qty, SUM(si.line_total) AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND date(s.created_at,'localtime') >= date('now','localtime','-29 days') AND s.created_at >= date('now','localtime','-29 days','-1 day')
    GROUP BY si.name
    ORDER BY revenue DESC
    LIMIT 5
  `).all();

  const lowStock = db.prepare(`
    SELECT id, name, stock_qty, reorder_level
    FROM products
    WHERE active = 1 AND track_stock = 1 AND stock_qty <= reorder_level
    ORDER BY stock_qty ASC
    LIMIT 10
  `).all();

  const paymentMix = db.prepare(`
    SELECT payment_method AS method, COUNT(*) AS count, SUM(total) AS revenue
    FROM sales WHERE voided = 0 AND date(created_at,'localtime') = date('now','localtime') AND created_at >= date('now','localtime','-1 day')
    GROUP BY payment_method ORDER BY revenue DESC
  `).all();

  // Today's printing, and pages printed vs sold (admins only — cashiers
  // don't see print monitoring).
  let printing = null;
  if (req.session.user.role === 'admin') {
    const todayKey = localDateString();
    const rec = reconcile(todayKey, todayKey);
    const r = rec.rows[0] || { color_printed: 0, mono_printed: 0, unknown_printed: 0, color_sold: 0, mono_sold: 0, gap: 0, estimated_value: 0 };
    printing = {
      pages: r.color_printed + r.mono_printed + r.unknown_printed,
      color_pages: r.color_printed,
      mono_pages: r.mono_printed,
      pages_sold: r.color_sold + r.mono_sold,
      gap: r.gap,
      estimated_value: r.estimated_value,
      has_print_services: rec.printServices.length > 0
    };
  }

  const closedToday = !!db.prepare('SELECT 1 FROM day_closings WHERE business_date = ?').get(localDateString());

  res.json({ today, last7Days, thisMonth, dailySeries, topItems, lowStock, paymentMix, printing, closedToday });
});

module.exports = router;
