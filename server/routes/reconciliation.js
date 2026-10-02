const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { round2 } = require('../lib/saleCreator');
const { SALE_DAY, isDateString, localDateString, daysAgo } = require('../lib/dates');

const router = express.Router();

// Pages printed (from the print agents; pages x copies) vs pages sold (quantity of products
// marked as colour / B&W print services), one row per day.
function reconcile(from, to) {
  // print_jobs.submitted_at is the agent's local timestamp; its first 10
  // characters are the wall-clock date the job printed.
  const printed = db.prepare(`
    SELECT substr(submitted_at, 1, 10) AS day,
      COALESCE(SUM(CASE WHEN color_mode = 'color' THEN COALESCE(impressions, pages) END), 0) AS color,
      COALESCE(SUM(CASE WHEN color_mode = 'mono' THEN COALESCE(impressions, pages) END), 0) AS mono,
      COALESCE(SUM(CASE WHEN color_mode NOT IN ('color','mono') OR color_mode IS NULL THEN COALESCE(impressions, pages) END), 0) AS unknown
    FROM print_jobs
    WHERE substr(submitted_at, 1, 10) BETWEEN ? AND ?
    GROUP BY day
  `).all(from, to);

  const sold = db.prepare(`
    SELECT ${SALE_DAY} AS day, p.print_color_mode AS mode,
           SUM(si.qty) AS qty, SUM(si.line_total) AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.voided = 0 AND p.print_color_mode IN ('color','mono') AND ${SALE_DAY} BETWEEN ? AND ?
    GROUP BY day, mode
  `).all(from, to);

  // Price per page used to value a gap: what was actually charged in this
  // period, else the current price of the active print-service products.
  function pagePrice(mode) {
    const s = sold.filter((r) => r.mode === mode);
    const qty = s.reduce((n, r) => n + r.qty, 0);
    if (qty > 0) return s.reduce((n, r) => n + r.revenue, 0) / qty;
    const p = db.prepare('SELECT AVG(price) AS price FROM products WHERE active = 1 AND print_color_mode = ?').get(mode);
    return p.price || 0;
  }
  const prices = { color: pagePrice('color'), mono: pagePrice('mono') };

  const days = new Map();
  const row = (day) => {
    if (!days.has(day)) {
      days.set(day, { day, color_printed: 0, color_sold: 0, mono_printed: 0, mono_sold: 0, unknown_printed: 0 });
    }
    return days.get(day);
  };
  for (const p of printed) Object.assign(row(p.day), { color_printed: p.color, mono_printed: p.mono, unknown_printed: p.unknown });
  for (const s of sold) row(s.day)[`${s.mode}_sold`] = s.qty;

  const rows = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).map((r) => {
    const colorGap = r.color_printed - r.color_sold;
    const monoGap = r.mono_printed - r.mono_sold;
    return {
      ...r,
      color_gap: colorGap,
      mono_gap: monoGap,
      gap: colorGap + monoGap,
      // Only unsold pages carry a value; selling more than was detected
      // (e.g. jobs from a printer without an agent) isn't money missing.
      estimated_value: round2(Math.max(colorGap, 0) * prices.color + Math.max(monoGap, 0) * prices.mono)
    };
  });

  const totals = rows.reduce((t, r) => {
    for (const k of ['color_printed', 'color_sold', 'mono_printed', 'mono_sold', 'unknown_printed', 'gap', 'estimated_value']) t[k] += r[k];
    return t;
  }, { color_printed: 0, color_sold: 0, mono_printed: 0, mono_sold: 0, unknown_printed: 0, gap: 0, estimated_value: 0 });
  totals.estimated_value = round2(totals.estimated_value);

  const printServices = db.prepare(`
    SELECT id, name, price, print_color_mode FROM products WHERE active = 1 AND print_color_mode IS NOT NULL ORDER BY name
  `).all();

  // Client sessions in the range and how many were rung up from checkout.
  const sessions = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN sale_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS billed
    FROM print_sessions
    WHERE id IN (SELECT session_id FROM print_jobs WHERE substr(submitted_at, 1, 10) BETWEEN ? AND ?)
  `).get(from, to);

  return { from, to, rows, totals, sessions, prices: { color: round2(prices.color), mono: round2(prices.mono) }, printServices };
}

router.get('/', requireAdmin, (req, res) => {
  const from = isDateString(req.query.from) ? req.query.from : daysAgo(13);
  const to = isDateString(req.query.to) ? req.query.to : localDateString();
  res.json(from <= to ? reconcile(from, to) : reconcile(to, from));
});

module.exports = { router, reconcile };
