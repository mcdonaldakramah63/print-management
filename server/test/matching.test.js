'use strict';
// The grouped session <-> sale matching must give the same optimum as one
// Hungarian over the full matrix (the old, O(n^3) way), and be fast.
const assert = require('assert');
const { matchPairs, pairCost, UNMATCHED_COST, BIG } = require('../lib/insights/matching');
const { hungarian } = require('../lib/insights/stats');

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const names = ['Kwame', 'Abena', 'Yaw', 'Akosua', ''];
const iso = (ms) => new Date(ms).toISOString();

function scenario(nSessions, nSales, spanHours) {
  const t0 = Date.parse('2026-09-01T08:00:00Z');
  const sessions = Array.from({ length: nSessions }, (_, i) => ({
    id: i + 1, owner: names[i % names.length], color_pages: Math.floor(rand() * 6), mono_pages: 1 + Math.floor(rand() * 20),
    ended_at: iso(t0 + rand() * spanHours * 3600000)
  }));
  const sales = Array.from({ length: nSales }, (_, j) => ({
    id: 1000 + j, receipt_no: `R${j}`, customer_name: names[j % names.length], color_qty: Math.floor(rand() * 6), mono_qty: 1 + Math.floor(rand() * 20),
    created_at: iso(t0 + rand() * spanHours * 3600000)
  }));
  return { sessions, sales };
}

function fullMatrixCost(sessions, sales) {
  const cost = sessions.map((s, i) => [...sales.map((sale) => pairCost(s, sale)), ...sessions.map((_, k) => (k === i ? UNMATCHED_COST : BIG))]);
  const a = hungarian(cost);
  return a.reduce((sum, col, i) => sum + Math.min(cost[i][col], UNMATCHED_COST), 0);
}

const totalCost = (sessions, result) => sessions.reduce((sum, s) => sum + (result.has(s.id) ? result.get(s.id).cost : UNMATCHED_COST), 0);

let checked = 0;
for (let trial = 0; trial < 120; trial++) {
  const { sessions, sales } = scenario(5 + Math.floor(rand() * 40), 5 + Math.floor(rand() * 50), 1 + rand() * 30);
  const result = matchPairs(sessions, sales);
  // Same optimum (costs are rounded to cents in the result).
  assert.ok(Math.abs(totalCost(sessions, result) - fullMatrixCost(sessions, sales)) < 0.01 * sessions.length + 1e-9, `trial ${trial}`);
  // No sale explains two sessions; every pairing is a feasible one.
  const used = new Set();
  for (const [sid, m] of result) {
    assert.ok(!used.has(m.sale.id));
    used.add(m.sale.id);
    assert.ok(pairCost(sessions.find((s) => s.id === sid), sales.find((x) => x.id === m.sale.id)) < UNMATCHED_COST);
  }
  checked++;
}

// A month of a busy shop: was ~95 s as one matrix.
const { sessions, sales } = scenario(1500, 3500, 30 * 10);
const t = Date.now();
const big = matchPairs(sessions, sales);
const ms = Date.now() - t;
assert.ok(ms < 3000, `took ${ms} ms`);
console.log(`matching: ${checked} random cases equal the full optimum; 1500 x 3500 in ${ms} ms (${big.size} matched)`);
