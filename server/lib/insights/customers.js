// ---------------------------------------------------------------
// Customer recognition and RFM segmentation
//
// Customers are typed in free text at the till ("Kofi Mensah",
// "kofi mensa", "K. Mensah 024 123 4567"), so the same person appears under
// several spellings. Entity resolution:
//   1. Normalise: phone -> its last 9 digits (Ghana +233 / 0 prefixes and
//      spacing don't matter); name -> lower-case tokens, sorted.
//   2. Link records that share a phone number.
//   3. Link records whose full names are near-identical (Jaro-Winkler on the
//      sorted tokens >= 0.93, at least two name tokens, and no conflicting
//      phone numbers). Blocking on the first letters keeps this fast.
//   4. Union-find merges the links into customers.
//
// Each customer is then scored on Recency, Frequency and Monetary value
// (recency on day bands, frequency on visit counts, spend by quintile) and placed in a
// segment. Regulars with 3+ visits also get an expected-return check: if the
// time since their last visit is well past their own usual gap, they're
// flagged as overdue.
// ---------------------------------------------------------------
const db = require('../../db');
const { jaroWinkler, quantile, median } = require('./stats');

const WALK_IN = /^(walk[\s-]?in|customer|cash|n\/?a|none|-+|\.+)$/i;

function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p[rb] = ra; }
}

function resolveCustomers(sinceDays = 365) {
  const rows = db.prepare(`
    SELECT id, customer_name, customer_phone, total, created_at
    FROM sales
    WHERE voided = 0 AND created_at >= datetime('now', ?)
      AND (trim(customer_name) != '' OR trim(customer_phone) != '')
  `).all(`-${sinceDays} days`);

  // One record per distinct (name, phone) spelling.
  const records = new Map();
  for (const r of rows) {
    const name = String(r.customer_name || '').trim().replace(/\s+/g, ' ');
    if (WALK_IN.test(name) && !phoneKey(r.customer_phone)) continue;
    const key = `${nameKey(name)}|${phoneKey(r.customer_phone)}`;
    if (key === '|') continue;
    if (!records.has(key)) records.set(key, { name: nameKey(name), phone: phoneKey(r.customer_phone), spellings: new Map(), phones: new Set(), sales: [] });
    const rec = records.get(key);
    if (name && !WALK_IN.test(name)) rec.spellings.set(name, (rec.spellings.get(name) || 0) + 1);
    if (r.customer_phone) rec.phones.add(String(r.customer_phone).trim());
    rec.sales.push(r);
  }
  const list = [...records.values()];
  const uf = new UnionFind(list.length);

  // Same phone number -> same customer.
  const byPhone = new Map();
  list.forEach((r, i) => {
    if (!r.phone) return;
    if (byPhone.has(r.phone)) uf.union(byPhone.get(r.phone), i); else byPhone.set(r.phone, i);
  });

  // Near-identical full names (blocked by first two letters), never across different phones.
  const blocks = new Map();
  list.forEach((r, i) => {
    if (!r.name) return;
    const b = r.name.slice(0, 2);
    if (!blocks.has(b)) blocks.set(b, []);
    blocks.get(b).push(i);
  });
  for (const idxs of blocks.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = list[idxs[x]];
        const b = list[idxs[y]];
        if (a.phone && b.phone && a.phone !== b.phone) continue;
        const fullNames = a.name.includes(' ') && b.name.includes(' ');
        if (fullNames) {
          if (a.name === b.name || jaroWinkler(a.name, b.name) >= 0.93) uf.union(idxs[x], idxs[y]);
        } else if (a.name === b.name && !a.phone && !b.phone) {
          // A single first name ("Kojo") is too common to merge on, unless
          // neither record has a phone that could tell two people apart.
          uf.union(idxs[x], idxs[y]);
        }
      }
    }
  }

  // Build customers from the merged groups.
  const groups = new Map();
  list.forEach((r, i) => {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });

  const now = Date.now();
  const toMs = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);
  const customers = [...groups.values()].map((recs, idx) => {
    const spellings = new Map();
    const phones = new Set();
    const sales = [];
    for (const r of recs) {
      for (const [n, c] of r.spellings) spellings.set(n, (spellings.get(n) || 0) + c);
      r.phones.forEach((p) => phones.add(p));
      sales.push(...r.sales);
    }
    sales.sort((a, b) => toMs(a.created_at) - toMs(b.created_at));
    // Visits: sales on different days (two receipts in one visit count once).
    const days = [...new Set(sales.map((s) => s.created_at.slice(0, 10)))];
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push((Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400000);
    const last = toMs(sales[sales.length - 1].created_at);
    const name = [...spellings.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || [...phones][0] || 'Unknown';
    const spend = sales.reduce((s, x) => s + x.total, 0);
    const daysSince = (now - last) / 86400000;
    const usualGap = gaps.length >= 2 ? median(gaps) : null;
    return {
      key: idx,
      name,
      aliases: [...spellings.keys()].filter((n) => n !== name).slice(0, 5),
      phones: [...phones].slice(0, 3),
      visits: days.length,
      receipts: sales.length,
      spend: Math.round(spend * 100) / 100,
      average: Math.round((spend / sales.length) * 100) / 100,
      first_visit: sales[0].created_at,
      last_visit: sales[sales.length - 1].created_at,
      days_since: Math.round(daysSince),
      usual_gap_days: usualGap === null ? null : Math.round(usualGap * 10) / 10,
      overdue: usualGap !== null && days.length >= 3 && daysSince > Math.max(7, usualGap * 2.5),
      sale_ids: sales.map((s) => s.id).slice(-50)
    };
  });

  scoreRFM(customers);
  return customers.sort((a, b) => b.spend - a.spend);
}

/** Quintile scores (1-5) for recency, frequency and spend, then a segment. */
function scoreRFM(customers) {
  if (customers.length === 0) return;
  // Quintile cut-offs once per list (computing them per customer re-sorted
  // every customer's figures n times: seconds on a year of sales).
  const cutsOf = (values) => [0.2, 0.4, 0.6, 0.8].map((q) => quantile(values, q));
  const freqCuts = cutsOf(customers.map((c) => c.visits));
  const monCuts = cutsOf(customers.map((c) => c.spend));
  const score = (value, cuts, higherIsBetter) => {
    let s = 1 + cuts.filter((c) => value > c).length;
    if (!higherIsBetter) s = 6 - s;
    return s;
  };
  for (const c of customers) {
    // Recency on fixed day bands: ranking against other customers is unstable
    // for small shops where everyone came in this week.
    c.r = c.days_since <= 7 ? 5 : c.days_since <= 14 ? 4 : c.days_since <= 30 ? 3 : c.days_since <= 60 ? 2 : 1;
    // Frequency is lumpy (lots of 1s), so score it on absolute visits once
    // the quintiles collapse.
    c.f = Math.min(5, Math.max(score(c.visits, freqCuts, true), c.visits >= 10 ? 5 : c.visits >= 5 ? 4 : c.visits >= 3 ? 3 : c.visits === 2 ? 2 : 1));
    c.m = score(c.spend, monCuts, true);
    c.segment = segmentOf(c);
  }
}

function segmentOf({ r, f, m, visits, overdue }) {
  if (visits === 1) return r >= 4 ? 'new' : 'one_off';
  if (r >= 4 && f >= 4) return 'champion';
  if (overdue && (f >= 3 || m >= 4)) return 'at_risk';
  if (f >= 3 && r >= 3) return 'loyal';
  if (r >= 4) return 'promising';
  if (r <= 2 && (f >= 3 || m >= 4)) return 'at_risk';
  if (r <= 1) return 'lost';
  return 'needs_attention';
}

let cache = null;
function customersCached() {
  if (!cache || Date.now() - cache.at > 5 * 60 * 1000) cache = { at: Date.now(), list: resolveCustomers() };
  return cache.list;
}
function invalidateCustomers() { cache = null; }

/** Fuzzy lookup for the checkout: by phone digits or by name similarity. */
function lookup(q, limit = 6) {
  const text = String(q || '').trim();
  if (text.length < 2) return [];
  const digits = text.replace(/\D/g, '');
  const qName = nameKey(text);
  const scored = [];
  for (const c of customersCached()) {
    let s = 0;
    if (digits.length >= 3 && c.phones.some((p) => p.replace(/\D/g, '').includes(digits))) s = 1;
    if (qName) {
      for (const n of [c.name, ...c.aliases]) {
        const k = nameKey(n);
        if (k.startsWith(qName) || k.split(' ').some((w) => w.startsWith(qName))) s = Math.max(s, 0.95);
        else {
          // Typo-tolerant: the query against the whole name and against each word.
          s = Math.max(s, jaroWinkler(qName, k) - 0.1, ...k.split(' ').map((w) => jaroWinkler(qName, w) - 0.05));
        }
      }
    }
    if (s >= 0.8) scored.push({ c, s });
  }
  return scored.sort((a, b) => b.s - a.s || b.c.visits - a.c.visits).slice(0, limit).map(({ c }) => ({
    name: c.name, phone: c.phones[0] || '', visits: c.visits, last_visit: c.last_visit, segment: c.segment, spend: c.spend
  }));
}

module.exports = { resolveCustomers, customersCached, invalidateCustomers, lookup, phoneKey, nameKey };
