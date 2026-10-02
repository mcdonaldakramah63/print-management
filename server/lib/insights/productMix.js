// ---------------------------------------------------------------
// Product mix: margins and ABC-XYZ classification (last 90 days)
//
// ABC (value): products sorted by revenue; A = the products making up the
// first 80% of revenue, B = the next 15%, C = the last 5%.
// XYZ (predictability): coefficient of variation of weekly units sold;
// X < 0.5 steady, Y < 1.0 variable, Z >= 1.0 erratic.
// Together they say how to stock each product (e.g. AX: never run out,
// automate; CZ: order on demand).
// Margins use the cost snapshotted on each sale line when available.
// ---------------------------------------------------------------
const db = require('../../db');
const { mean, std } = require('./stats');

const ADVICE = {
  AX: 'Top seller with steady demand: never let it run out; reorder on a schedule.',
  AY: 'Top seller with variable demand: keep a healthy safety stock.',
  AZ: 'Top seller but erratic: watch closely and keep extra buffer.',
  BX: 'Steady mid-range item: regular reorders work well.',
  BY: 'Mid-range with variable demand: review stock weekly.',
  BZ: 'Mid-range and erratic: keep small stock, reorder when it moves.',
  CX: 'Small but steady: low priority, keep a little in stock.',
  CY: 'Small and variable: keep minimal stock.',
  CZ: 'Small and erratic: consider ordering only on demand.'
};

function productMix() {
  const rows = db.prepare(`
    SELECT si.product_id AS id, p.name, p.track_stock, p.cost_price,
           SUM(si.qty) AS qty, SUM(si.line_total) AS revenue,
           SUM(CASE WHEN COALESCE(si.unit_cost, p.cost_price) IS NOT NULL THEN si.line_total ELSE 0 END) AS costed_revenue,
           SUM(si.qty * COALESCE(si.unit_cost, p.cost_price)) AS cost
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
    WHERE s.voided = 0 AND s.created_at >= datetime('now', '-90 days')
    GROUP BY si.product_id ORDER BY revenue DESC
  `).all();
  const weekly = db.prepare(`
    SELECT si.product_id AS id, CAST((julianday('now') - julianday(s.created_at)) / 7 AS INTEGER) AS wk, SUM(si.qty) AS qty
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND s.created_at >= datetime('now', '-91 days') AND si.product_id IS NOT NULL
    GROUP BY si.product_id, wk
  `).all();
  const firstSale = new Map(db.prepare(`
    SELECT si.product_id AS id, MIN(s.created_at) AS first FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE si.product_id IS NOT NULL GROUP BY si.product_id
  `).all().map((r) => [r.id, r.first]));

  const total = rows.reduce((s, r) => s + r.revenue, 0);
  let cumulative = 0;
  return rows.map((r) => {
    const share = total ? r.revenue / total : 0;
    const before = cumulative;
    cumulative += share;
    const abc = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';

    // Weeks since the product first sold (max 13), zero-filled.
    const weeksActive = Math.max(1, Math.min(13, Math.ceil((Date.now() - Date.parse(`${(firstSale.get(r.id) || '').replace(' ', 'T')}Z`)) / (7 * 86400000)) || 13));
    const series = new Array(weeksActive).fill(0);
    for (const w of weekly) if (w.id === r.id && w.wk < weeksActive) series[w.wk] = w.qty;
    const cv = mean(series) > 0 ? std(series) / mean(series) : null;
    const xyz = cv === null || weeksActive < 4 ? null : cv < 0.5 ? 'X' : cv < 1 ? 'Y' : 'Z';

    const margin = r.cost != null && r.costed_revenue > 0 ? r.costed_revenue - r.cost : null;
    return {
      id: r.id,
      name: r.name,
      qty: Math.round(r.qty * 100) / 100,
      revenue: Math.round(r.revenue * 100) / 100,
      share: Math.round(share * 1000) / 10,
      abc,
      xyz,
      cv: cv === null ? null : Math.round(cv * 100) / 100,
      class: xyz ? abc + xyz : abc,
      advice: xyz ? ADVICE[abc + xyz] : 'Needs at least 4 weeks of sales to judge demand stability.',
      margin: margin === null ? null : Math.round(margin * 100) / 100,
      margin_pct: margin === null ? null : Math.round((margin / r.costed_revenue) * 1000) / 10
    };
  });
}

module.exports = { productMix };
