const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { round2 } = require('../lib/saleCreator');
const { SALE_DAY, isDateString, localDateString, daysAgo } = require('../lib/dates');
const { matchUnbilledSessions } = require('../lib/insights/matching');
const { copyPagesByDay, unbilledCopies } = require('../lib/copies');

const router = express.Router();

// Pages output (print jobs from the agents, pages x copies, plus photocopies
// detected on the printers' page counters) vs pages sold (quantity of
// products marked as colour / B&W print or photocopy services; a two-sided
// service counts 2 pages per sheet sold), one row per day.
function reconcile(from, to) {
  // print_jobs.submitted_at is the agent's local timestamp; its first 10
  // characters are the wall-clock date the job printed.
  const printed = db.prepare(`
    SELECT substr(submitted_at, 1, 10) AS day,
      COALESCE(SUM(CASE WHEN color_mode = 'color' THEN COALESCE(impressions, pages) END), 0) AS color,
      COALESCE(SUM(CASE WHEN color_mode = 'mono' THEN COALESCE(impressions, pages) END), 0) AS mono,
      COALESCE(SUM(CASE WHEN color_mode NOT IN ('color','mono') OR color_mode IS NULL THEN COALESCE(impressions, pages) END), 0) AS unknown,
      -- Odd-page documents printed on both sides leave the last back blank:
      -- sold per sheet, that's a page charged but never printed.
      COALESCE(SUM(CASE WHEN color_mode = 'color' AND duplex = 'duplex' THEN MAX(0, 2 * sheets - impressions) END), 0) AS color_blank,
      COALESCE(SUM(CASE WHEN color_mode = 'mono' AND duplex = 'duplex' THEN MAX(0, 2 * sheets - impressions) END), 0) AS mono_blank
    FROM print_jobs
    WHERE substr(submitted_at, 1, 10) BETWEEN ? AND ?
    GROUP BY day
  `).all(from, to);

  const sold = db.prepare(`
    SELECT ${SALE_DAY} AS day, p.print_color_mode AS mode,
           SUM(si.qty * p.print_sides) AS qty, SUM(si.line_total) AS revenue,
           SUM(CASE WHEN p.print_sides = 2 THEN si.qty * 2 ELSE 0 END) AS two_sided,
           SUM(CASE WHEN p.print_kind = 'copy' THEN si.qty * p.print_sides ELSE 0 END) AS copies
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.voided = 0 AND p.print_color_mode IN ('color','mono') AND ${SALE_DAY} BETWEEN ? AND ?
    GROUP BY day, mode
  `).all(from, to);

  const copied = copyPagesByDay(from, to);

  // Price per page used to value a gap: what was actually charged in this
  // period, else the current price of the active print-service products.
  function pagePrice(mode) {
    const s = sold.filter((r) => r.mode === mode);
    const qty = s.reduce((n, r) => n + r.qty, 0);
    if (qty > 0) return s.reduce((n, r) => n + r.revenue, 0) / qty;
    const p = db.prepare('SELECT AVG(price * 1.0 / print_sides) AS price FROM products WHERE active = 1 AND print_color_mode = ?').get(mode);
    return p.price || 0;
  }
  const prices = { color: pagePrice('color'), mono: pagePrice('mono') };

  const days = new Map();
  const row = (day) => {
    if (!days.has(day)) {
      days.set(day, {
        day, color_printed: 0, color_sold: 0, mono_printed: 0, mono_sold: 0, unknown_printed: 0,
        copy_pages: 0, copy_runs: 0, copy_sold: 0, two_sided_sold: 0, color_blank: 0, mono_blank: 0
      });
    }
    return days.get(day);
  };
  for (const p of printed) {
    Object.assign(row(p.day), { color_printed: p.color, mono_printed: p.mono, unknown_printed: p.unknown, color_blank: p.color_blank, mono_blank: p.mono_blank });
  }
  // Photocopies of unknown colour (colour device, no copy counter) are
  // counted as B&W: the cheaper, far more common case.
  for (const c of copied) {
    const r = row(c.day);
    r.color_printed += c.color;
    r.mono_printed += c.mono + c.unknown;
    r.copy_pages = c.color + c.mono + c.unknown;
    r.copy_runs = c.runs;
  }
  for (const s of sold) {
    const r = row(s.day);
    r[`${s.mode}_sold`] = s.qty;
    r.copy_sold += s.copies;
    r.two_sided_sold += s.two_sided;
    r[`${s.mode}_two_sided`] = s.two_sided;
  }

  const rows = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).map((r) => {
    // Blank backs explain pages sold two-sided but never printed, up to
    // what was actually sold two-sided.
    const allowance = (mode) => Math.min(r[`${mode}_blank`], r[`${mode}_two_sided`] || 0);
    const colorGap = r.color_printed - (r.color_sold - allowance('color'));
    const monoGap = r.mono_printed - (r.mono_sold - allowance('mono'));
    // Print-service sales but not a single page reported: the agent wasn't
    // running (not installed yet, PC off, offline). Comparing would show a
    // huge false "oversold" gap, so the day is shown but left out of totals.
    const noData = r.color_printed + r.mono_printed + r.unknown_printed === 0 && r.color_sold + r.mono_sold > 0;
    const { color_two_sided: _c, mono_two_sided: _m, ...out } = r;
    return {
      ...out,
      no_data: noData,
      color_gap: colorGap,
      mono_gap: monoGap,
      gap: colorGap + monoGap,
      // Only unsold pages carry a value; selling more than was detected
      // (e.g. jobs from a printer without an agent) isn't money missing.
      estimated_value: round2(Math.max(colorGap, 0) * prices.color + Math.max(monoGap, 0) * prices.mono)
    };
  });

  const totals = rows.filter((r) => !r.no_data).reduce((t, r) => {
    for (const k of Object.keys(t)) t[k] += r[k];
    return t;
  }, {
    color_printed: 0, color_sold: 0, mono_printed: 0, mono_sold: 0, unknown_printed: 0, gap: 0, estimated_value: 0,
    copy_pages: 0, copy_runs: 0, copy_sold: 0, two_sided_sold: 0
  });
  totals.estimated_value = round2(totals.estimated_value);
  totals.no_data_days = rows.filter((r) => r.no_data).length;

  const printServices = db.prepare(`
    SELECT id, name, price, print_color_mode, print_kind, print_sides FROM products WHERE active = 1 AND print_color_mode IS NOT NULL ORDER BY name
  `).all();

  // Client sessions in the range and how many were rung up from checkout.
  const sessions = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN sale_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS billed
    FROM print_sessions
    WHERE id IN (SELECT session_id FROM print_jobs WHERE substr(submitted_at, 1, 10) BETWEEN ? AND ?)
  `).get(from, to);

  return { from, to, rows, totals, sessions, prices: { color: round2(prices.color), mono: round2(prices.mono) }, printServices };
}

// Unbilled sessions split into "probably rung up by hand" (matched to a sale)
// and "no plausible sale found", with the value of each.
function sessionAudit(from, to, prices) {
  const matches = matchUnbilledSessions(from, to);
  const unbilled = db.prepare(`
    SELECT ps.id, ps.owner, ps.machine, ps.started_at, ps.ended_at, ps.job_count, ps.color_pages, ps.mono_pages,
           ps.unknown_pages, ps.flags, a.label AS agent_label
    FROM print_sessions ps JOIN agents a ON a.id = ps.agent_id
    WHERE ps.sale_id IS NULL AND ps.id IN (SELECT session_id FROM print_jobs WHERE substr(submitted_at, 1, 10) BETWEEN ? AND ?)
    ORDER BY ps.ended_at DESC
  `).all(from, to);
  const value = (s) => round2(s.color_pages * prices.color + s.mono_pages * prices.mono);
  const parse = (f) => { try { return JSON.parse(f); } catch (_) { return []; } };
  const likely = [];
  const missing = [];
  for (const s of unbilled) {
    const row = { ...s, flags: parse(s.flags), value: value(s) };
    const m = matches.get(s.id);
    if (m) likely.push({ ...row, match: m }); else missing.push(row);
  }
  // Photocopy runs nobody rang up (confident detections only).
  const copies = unbilledCopies(from, to).map((c) => ({
    ...c, value: round2(c.color_pages * prices.color + (c.mono_pages + c.unknown_pages) * prices.mono)
  }));
  return {
    likely,
    copies: copies.slice(0, 100),
    copies_count: copies.length,
    copies_value: round2(copies.reduce((n, c) => n + c.value, 0)),
    missing: missing.slice(0, 100),
    missing_count: missing.length,
    missing_value: round2(missing.reduce((n, s) => n + s.value, 0))
  };
}

router.get('/', requireAdmin, (req, res) => {
  const from = isDateString(req.query.from) ? req.query.from : daysAgo(13);
  const to = isDateString(req.query.to) ? req.query.to : localDateString();
  const [a, b] = from <= to ? [from, to] : [to, from];
  const result = reconcile(a, b);
  res.json({ ...result, audit: sessionAudit(a, b, result.prices) });
});

module.exports = { router, reconcile };
