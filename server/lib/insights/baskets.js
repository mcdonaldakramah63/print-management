// ---------------------------------------------------------------
// "Often bought together" (association rules)
//
// For every pair of catalogue products sold in the same sale over the last
// 120 days: confidence(A→B) = P(B in sale | A in sale) and
// lift = confidence / P(B). Suggestions are ranked by the Wilson lower
// bound of the confidence (so 3-out-of-4 coincidences don't outrank
// 60-out-of-200 habits) weighted by log-lift (so items that are in every
// sale anyway, like B&W printing, don't get suggested for everything).
// Rebuilt at most every 10 minutes.
// ---------------------------------------------------------------
const db = require('../../db');
const { wilsonLower } = require('./stats');

const CACHE_MS = 10 * 60 * 1000;
let cache = null;

function buildRules() {
  const rows = db.prepare(`
    SELECT DISTINCT si.sale_id, si.product_id
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND si.product_id IS NOT NULL AND s.created_at >= datetime('now', '-120 days')
  `).all();
  const baskets = new Map();
  for (const r of rows) {
    if (!baskets.has(r.sale_id)) baskets.set(r.sale_id, []);
    baskets.get(r.sale_id).push(r.product_id);
  }
  const itemCount = new Map();
  const pairCount = new Map();
  for (const items of baskets.values()) {
    for (const a of items) itemCount.set(a, (itemCount.get(a) || 0) + 1);
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const key = `${items[i]}>${items[j]}`;
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }
  return { n: baskets.size, itemCount, pairCount, builtAt: Date.now() };
}

function rules() {
  if (!cache || Date.now() - cache.builtAt > CACHE_MS) cache = buildRules();
  return cache;
}

function invalidate() { cache = null; }

/** Suggest up to `limit` products to go with the products already in the cart. */
function suggestFor(productIds, limit = 3) {
  const { n, itemCount, pairCount } = rules();
  if (n < 20 || productIds.length === 0) return [];
  const inCart = new Set(productIds);
  const active = new Map(db.prepare('SELECT id, name, price FROM products WHERE active = 1').all().map((p) => [p.id, p]));
  const best = new Map();
  for (const a of inCart) {
    const nA = itemCount.get(a) || 0;
    if (nA < 5) continue;
    for (const [b, nB] of itemCount) {
      if (inCart.has(b) || !active.has(b)) continue;
      const nAB = pairCount.get(`${a}>${b}`) || 0;
      if (nAB < 3) continue;
      const confidence = nAB / nA;
      const lift = confidence / (nB / n);
      if (lift < 1.2) continue;
      // Require real evidence: the pessimistic (Wilson) estimate of how often
      // B follows A must still be at least 10%.
      const lower = wilsonLower(nAB, nA);
      if (lower < 0.1) continue;
      const score = lower * Math.log2(1 + lift);
      const prev = best.get(b);
      if (!prev || score > prev.score) {
        best.set(b, { product: active.get(b), because: active.get(a)?.name || '', confidence, lift, score });
      }
    }
  }
  return [...best.values()].sort((x, y) => y.score - x.score).slice(0, limit).map((s) => ({
    id: s.product.id,
    name: s.product.name,
    price: s.product.price,
    because: s.because,
    confidence: Math.round(s.confidence * 100) / 100,
    lift: Math.round(s.lift * 10) / 10
  }));
}

module.exports = { suggestFor, invalidate };
