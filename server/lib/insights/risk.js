// ---------------------------------------------------------------
// Risk alerts (loss prevention)
//
// Every check compares like with like and is built to stay quiet on noise:
//   * Cashier void and discount rates use empirical-Bayes shrinkage: each
//     cashier's rate is pulled towards the shop-wide rate in proportion to
//     how little data they have, so 2 voids out of 5 sales isn't treated as
//     a 40% void rate.
//   * Daily revenue is compared with the same weekday in previous weeks
//     using a robust z-score (median / MAD), so one odd day in the history
//     doesn't hide another.
//   * The daily print gap (pages printed but not sold, as a share of pages
//     printed) is checked the same way against the last 30 days.
//   * Cash drawer closings: unusually large shortages, and runs of
//     consecutive shortages (small, steady skimming).
//   * Late voids: sales voided long after they were rung up.
// ---------------------------------------------------------------
const db = require('../../db');
const { localDateString } = require('../dates');
const { betaPrior, robustZ, median } = require('./stats');

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateString(new Date(y, m - 1, d + n));
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

function cashierRates(since) {
  const rows = db.prepare(`
    SELECT u.id, u.full_name AS name, COUNT(*) AS n,
           SUM(s.voided) AS voids,
           SUM(CASE WHEN s.voided = 0 THEN s.discount_amount ELSE 0 END) AS discount,
           SUM(CASE WHEN s.voided = 0 THEN s.subtotal ELSE 0 END) AS gross,
           SUM(CASE WHEN s.voided = 0 AND s.discount_amount > 0 THEN 1 ELSE 0 END) AS discounted
    FROM sales s JOIN users u ON u.id = s.user_id
    WHERE date(s.created_at, 'localtime') >= ?
    GROUP BY u.id
  `).all(since);
  const alerts = [];
  if (rows.length === 0) return alerts;

  const checks = [
    { key: 'voids', label: 'void rate', x: (r) => r.voids, n: (r) => r.n, minX: 3 },
    { key: 'discounted', label: 'share of sales discounted', x: (r) => r.discounted, n: (r) => r.n - r.voids, minX: 4 }
  ];
  for (const check of checks) {
    const groups = rows.map((r) => ({ x: check.x(r), n: check.n(r) }));
    const prior = betaPrior(groups);
    for (const r of rows) {
      const x = check.x(r);
      const n = check.n(r);
      if (n <= 0 || x < check.minX) continue;
      const shrunk = (x + prior.a) / (n + prior.a + prior.b);
      // Flag only when even the shrunk estimate is far above the shop rate.
      if (shrunk > Math.max(prior.pooled * 2, prior.pooled + 0.03)) {
        alerts.push({
          type: `cashier_${check.key}`,
          severity: shrunk > prior.pooled * 3 ? 'high' : 'medium',
          title: `${r.name}: high ${check.label}`,
          detail: `${x} of ${n} sales (${pct(x / n)}) in the last 30 days, against ${pct(prior.pooled)} shop-wide. Adjusted for sample size: ${pct(shrunk)}.`,
          metric: { cashier_id: r.id, rate: x / n, adjusted: shrunk, shop: prior.pooled }
        });
      }
    }
  }

  // Discount value as a share of gross, per cashier (same shrinkage idea, by value).
  const totalGross = rows.reduce((s, r) => s + (r.gross || 0), 0);
  const totalDisc = rows.reduce((s, r) => s + (r.discount || 0), 0);
  const shopShare = totalGross ? totalDisc / totalGross : 0;
  const avgSale = totalGross / Math.max(1, rows.reduce((s, r) => s + r.n - r.voids, 0));
  for (const r of rows) {
    if (!r.gross || r.discount < avgSale) continue;
    const weight = 20 * avgSale; // prior worth ~20 average sales
    const shrunk = (r.discount + shopShare * weight) / (r.gross + weight);
    if (shrunk > Math.max(shopShare * 2, shopShare + 0.03)) {
      alerts.push({
        type: 'cashier_discount_value',
        severity: shrunk > shopShare * 3 ? 'high' : 'medium',
        title: `${r.name}: discounts well above normal`,
        detail: `Discounts were ${pct(r.discount / r.gross)} of their sales value (shop-wide ${pct(shopShare)}).`,
        metric: { cashier_id: r.id, share: r.discount / r.gross, adjusted: shrunk, shop: shopShare }
      });
    }
  }
  return alerts;
}

function revenueAnomalies(today) {
  const rows = db.prepare(`
    SELECT date(created_at, 'localtime') AS day, SUM(total) AS revenue
    FROM sales WHERE voided = 0 AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
    GROUP BY day
  `).all(addDays(today, -70), today);
  const map = new Map(rows.map((r) => [r.day, r.revenue]));
  if (rows.length < 21) return [];
  const first = rows.reduce((m, r) => (r.day < m ? r.day : m), today);
  const alerts = [];
  for (let i = 1; i <= 14; i++) {
    const day = addDays(today, -i);
    if (day < first) break;
    const y = map.get(day) || 0;
    // Same weekday over the 8 weeks before it (days the shop had started trading).
    const ref = [];
    for (let w = 1; w <= 8; w++) {
      const d = addDays(day, -7 * w);
      if (d >= first) ref.push(map.get(d) || 0);
    }
    if (ref.length < 3 || median(ref) <= 0) continue;
    const z = robustZ(y, ref, 0.1 * median(ref));
    if (z <= -3.5 || z >= 4) {
      const low = z < 0;
      alerts.push({
        type: low ? 'revenue_low' : 'revenue_high',
        severity: low && y === 0 ? 'high' : 'medium',
        title: `${low ? 'Unusually low' : 'Unusually high'} takings on ${day}`,
        detail: `${y.toFixed(2)} taken against a typical ${median(ref).toFixed(2)} on that weekday.`,
        metric: { day, revenue: y, typical: median(ref), z: Math.round(z * 10) / 10 }
      });
    }
  }
  return alerts;
}

function printGapAnomalies(today, reconcile) {
  const rec = reconcile(addDays(today, -30), addDays(today, -1));
  const rows = rec.rows.filter((r) => r.color_printed + r.mono_printed >= 20 && rec.printServices.length > 0);
  if (rows.length < 7) return [];
  const ratio = (r) => Math.max(0, r.gap) / (r.color_printed + r.mono_printed);
  const ratios = rows.map(ratio);
  return rows.filter((r) => {
    const z = robustZ(ratio(r), ratios, 0.05);
    return z >= 3 && ratio(r) >= 0.1;
  }).slice(0, 5).map((r) => ({
    type: 'print_gap',
    severity: ratio(r) >= 0.3 ? 'high' : 'medium',
    title: `Large print gap on ${r.day}`,
    detail: `${r.gap} of ${r.color_printed + r.mono_printed} pages (${pct(ratio(r))}) were printed but not sold; the usual gap is ${pct(median(ratios))}.`,
    metric: { day: r.day, gap: r.gap, ratio: ratio(r), typical: median(ratios) }
  }));
}

function cashDrawerAlerts() {
  const closings = db.prepare('SELECT business_date, variance, cash_total FROM day_closings ORDER BY business_date DESC LIMIT 60').all();
  const alerts = [];
  if (closings.length === 0) return alerts;

  // Runs of consecutive shortages, most recent first.
  let streak = 0;
  let streakTotal = 0;
  for (const c of closings) {
    if (c.variance < -0.009) { streak++; streakTotal += c.variance; } else break;
  }
  if (streak >= 3) {
    alerts.push({
      type: 'cash_shortage_streak',
      severity: streak >= 5 ? 'high' : 'medium',
      title: `Cash drawer short ${streak} closings in a row`,
      detail: `Short by ${Math.abs(streakTotal).toFixed(2)} in total. Small repeated shortages are worth a closer look.`,
      metric: { streak, total: streakTotal }
    });
  }

  // Unusually large single shortage relative to this shop's variance history.
  if (closings.length >= 8) {
    const variances = closings.map((c) => c.variance);
    for (const c of closings.slice(0, 14)) {
      const z = robustZ(c.variance, variances, 1);
      if (c.variance < 0 && z <= -4) {
        alerts.push({
          type: 'cash_shortage_large',
          severity: 'high',
          title: `Large cash shortage on ${c.business_date}`,
          detail: `Short by ${Math.abs(c.variance).toFixed(2)}; closings are usually within ${Math.abs(median(variances)).toFixed(2)}.`,
          metric: { day: c.business_date, variance: c.variance }
        });
      }
    }
  }
  return alerts;
}

function lateVoids(since) {
  const rows = db.prepare(`
    SELECT s.receipt_no, s.total, u.full_name AS voided_by,
           (julianday(s.voided_at) - julianday(s.created_at)) * 24 AS hours
    FROM sales s LEFT JOIN users u ON u.id = s.voided_by
    WHERE s.voided = 1 AND s.voided_at IS NOT NULL AND date(s.created_at, 'localtime') >= ?
      AND (julianday(s.voided_at) - julianday(s.created_at)) * 24 >= 12
    ORDER BY hours DESC LIMIT 5
  `).all(since);
  return rows.map((r) => ({
    type: 'late_void',
    severity: 'medium',
    title: `${r.receipt_no} voided ${Math.round(r.hours)} hours after the sale`,
    detail: `Voided by ${r.voided_by || 'unknown'} for ${r.total.toFixed(2)}. Voids are normally done at the till, straight away.`,
    metric: { receipt_no: r.receipt_no, hours: r.hours }
  }));
}

function offHoursPrinting(since) {
  const row = db.prepare(`
    SELECT COUNT(*) AS jobs, COALESCE(SUM(COALESCE(impressions, pages)), 0) AS pages,
           COUNT(DISTINCT substr(submitted_at, 1, 10)) AS days
    FROM print_jobs WHERE flags LIKE '%"off_hours"%' AND substr(submitted_at, 1, 10) >= ?
  `).get(since);
  if (row.pages < 10) return [];
  return [{
    type: 'off_hours_printing',
    severity: row.pages >= 100 ? 'high' : 'medium',
    title: `Printing while the shop is usually closed`,
    detail: `${row.pages} pages in ${row.jobs} jobs over ${row.days} day(s), outside the opening hours learned from your sales. Check Print monitor for who printed them.`,
    metric: row
  }];
}

function riskAlerts(reconcile, now = new Date()) {
  const today = localDateString(now);
  const since = addDays(today, -30);
  const alerts = [
    ...cashierRates(since),
    ...revenueAnomalies(today),
    ...printGapAnomalies(today, reconcile),
    ...cashDrawerAlerts(),
    ...lateVoids(since),
    ...offHoursPrinting(since)
  ];
  const rank = { high: 0, medium: 1 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return alerts;
}

module.exports = { riskAlerts };
