// ---------------------------------------------------------------
// Stock-out forecasting and reorder suggestions
//
// Demand per product per day comes from the stock movement log (sales
// minus voids). Steady sellers use an exponentially weighted moving
// average; intermittent sellers (zero sales on most days, e.g. ink
// cartridges) use Croston's method with the Syntetos-Boylan correction,
// which models "how much when it sells" and "how often it sells"
// separately instead of averaging lots of zeros.
//
// Reorder point = expected demand over the supplier lead time + safety
// stock (z · σ · √lead time, 95% service level). Suggested order brings
// stock up to cover lead time + the review period.
// ---------------------------------------------------------------
const db = require('../../db');
const { localDateString } = require('../dates');
const { mean, std } = require('./stats');

const WINDOW_DAYS = 56;
const Z95 = 1.645;

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateString(new Date(y, m - 1, d + n));
}

function ewma(series, alpha = 0.15) {
  let level = mean(series.slice(0, Math.min(7, series.length)));
  for (const x of series) level = alpha * x + (1 - alpha) * level;
  return level;
}

/** Croston with Syntetos-Boylan approximation: demand rate for intermittent series. */
function crostonSBA(series, alpha = 0.1) {
  const nonZero = series.map((x, i) => [x, i]).filter(([x]) => x > 0);
  if (nonZero.length === 0) return 0;
  let size = nonZero[0][0];
  let interval = nonZero[0][1] + 1;
  let last = nonZero[0][1];
  for (const [x, i] of nonZero.slice(1)) {
    size = alpha * x + (1 - alpha) * size;
    interval = alpha * (i - last) + (1 - alpha) * interval;
    last = i;
  }
  // A long silence since the last sale also counts as evidence of a slower rate.
  const sinceLast = series.length - 1 - last;
  if (sinceLast > interval) interval = alpha * sinceLast + (1 - alpha) * interval;
  return (1 - alpha / 2) * (size / interval);
}

function stockOutlook(now = new Date()) {
  const today = localDateString(now);
  const settings = db.prepare('SELECT reorder_lead_days, reorder_cover_days FROM settings WHERE id = 1').get();
  const lead = Math.max(1, settings.reorder_lead_days || 3);
  const cover = Math.max(1, settings.reorder_cover_days || 14);
  const from = addDays(today, -WINDOW_DAYS);

  const products = db.prepare('SELECT id, name, stock_qty, reorder_level FROM products WHERE active = 1 AND track_stock = 1').all();
  const movements = db.prepare(`
    SELECT product_id, date(created_at, 'localtime') AS day, -SUM(delta) AS sold, MIN(created_at) AS first
    FROM stock_movements
    WHERE reason IN ('sale', 'void') AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
    GROUP BY product_id, day
  `).all(from, today);
  const firstSeen = db.prepare(`SELECT product_id, MIN(date(created_at, 'localtime')) AS day FROM stock_movements GROUP BY product_id`).all();
  const firstMap = new Map(firstSeen.map((r) => [r.product_id, r.day]));

  const byProduct = new Map();
  for (const m of movements) {
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, new Map());
    byProduct.get(m.product_id).set(m.day, Math.max(0, m.sold));
  }

  return products.map((p) => {
    // Only count days since the product existed, so new products aren't diluted.
    const start = [from, firstMap.get(p.id) || today].sort()[1];
    const daily = byProduct.get(p.id) || new Map();
    const series = [];
    for (let d = start; d < today; d = addDays(d, 1)) series.push(daily.get(d) || 0);

    let rate = 0;
    let method = 'none';
    if (series.length >= 3) {
      const zeroShare = series.filter((x) => x === 0).length / series.length;
      if (zeroShare > 0.5) { rate = crostonSBA(series); method = 'croston'; } else { rate = ewma(series); method = 'ewma'; }
    }
    const sigma = series.length >= 3 ? std(series) : 0;
    const safety = Z95 * sigma * Math.sqrt(lead);
    const reorderPoint = rate * lead + safety;
    const target = rate * (lead + cover) + safety;
    const suggested = Math.max(0, Math.ceil(target - p.stock_qty));
    const daysLeft = rate > 0 ? Math.max(0, p.stock_qty) / rate : null;

    let status = 'ok';
    if (p.stock_qty <= 0) status = 'out';
    else if (rate > 0 && p.stock_qty <= reorderPoint) status = 'order_now';
    else if (daysLeft !== null && daysLeft <= lead + 7) status = 'order_soon';
    else if (rate === 0 && p.stock_qty <= p.reorder_level) status = 'below_alert';

    return {
      id: p.id,
      name: p.name,
      stock_qty: p.stock_qty,
      reorder_level: p.reorder_level,
      daily_rate: Math.round(rate * 100) / 100,
      method,
      history_days: series.length,
      days_left: daysLeft === null ? null : Math.round(daysLeft * 10) / 10,
      stockout_date: daysLeft === null ? null : addDays(today, Math.floor(daysLeft)),
      reorder_point: Math.ceil(reorderPoint),
      suggested_order: status === 'ok' ? 0 : suggested,
      status
    };
  }).sort((a, b) => {
    const order = { out: 0, order_now: 1, order_soon: 2, below_alert: 3, ok: 4 };
    return order[a.status] - order[b.status] || (a.days_left ?? 1e9) - (b.days_left ?? 1e9);
  });
}

module.exports = { stockOutlook, crostonSBA, ewma };
