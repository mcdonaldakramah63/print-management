const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/summary', requireAuth, (req, res) => {
  const today = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS count
    FROM sales WHERE voided = 0 AND date(created_at) = date('now','localtime')
  `).get();

  const last7Days = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS count
    FROM sales WHERE voided = 0 AND date(created_at) >= date('now','-6 days','localtime')
  `).get();

  const thisMonth = db.prepare(`
    SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS count
    FROM sales WHERE voided = 0 AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now','localtime')
  `).get();

  // Daily revenue for the last 14 days, filled in so days with no sales still show as 0
  const rawSeries = db.prepare(`
    SELECT date(created_at) AS day, SUM(total) AS revenue
    FROM sales
    WHERE voided = 0 AND date(created_at) >= date('now','-13 days','localtime')
    GROUP BY day
  `).all();
  const seriesMap = Object.fromEntries(rawSeries.map((r) => [r.day, r.revenue]));
  const dailySeries = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailySeries.push({ day: key, revenue: seriesMap[key] || 0 });
  }

  const topItems = db.prepare(`
    SELECT si.name, SUM(si.qty) AS qty, SUM(si.line_total) AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND date(s.created_at) >= date('now','-29 days','localtime')
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

  res.json({ today, last7Days, thisMonth, dailySeries, topItems, lowStock });
});

module.exports = router;
