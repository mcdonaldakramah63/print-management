const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { forecastRevenue } = require('../lib/insights/forecast');
const { riskAlerts } = require('../lib/insights/risk');
const { stockOutlook } = require('../lib/insights/stock');
const { suggestFor } = require('../lib/insights/baskets');
const { reconcile } = require('./reconciliation');
const { customersCached, lookup } = require('../lib/insights/customers');
const { trafficAnalysis } = require('../lib/insights/traffic');
const { productMix } = require('../lib/insights/productMix');
const { suppliesStatus, recordRefill } = require('../lib/insights/supplies');
const { tonerStatus } = require('../lib/insights/toner');

const router = express.Router();

router.get('/forecast', requireAuth, (req, res) => {
  res.json(forecastRevenue());
});

router.get('/risk', requireAdmin, (req, res) => {
  res.json({ alerts: riskAlerts(reconcile) });
});

router.get('/stock', requireAuth, (req, res) => {
  res.json({ products: stockOutlook() });
});

router.get('/suggestions', requireAuth, (req, res) => {
  const ids = String(req.query.product_ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  res.json({ suggestions: suggestFor([...new Set(ids)]) });
});

// Customers recognised across spellings and phone formats, with RFM segments.
router.get('/customers', requireAdmin, (req, res) => {
  const segment = String(req.query.segment || '');
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = customersCached();
  const counts = {};
  for (const c of list) counts[c.segment] = (counts[c.segment] || 0) + 1;
  if (segment) list = list.filter((c) => c.segment === segment);
  if (q) list = list.filter((c) => [c.name, ...c.aliases, ...c.phones].some((v) => String(v).toLowerCase().includes(q)));
  res.json({ total: list.length, segments: counts, customers: list.slice(0, 200).map(({ sale_ids, ...c }) => c) });
});

// Checkout autocomplete: fuzzy name or phone lookup.
router.get('/customers/lookup', requireAuth, (req, res) => {
  res.json({ customers: lookup(req.query.q) });
});

router.get('/traffic', requireAdmin, (req, res) => {
  res.json(trafficAnalysis());
});

router.get('/product-mix', requireAdmin, (req, res) => {
  res.json({ products: productMix() });
});

router.get('/supplies', requireAdmin, (req, res) => {
  res.json({ printers: suppliesStatus(), measured: tonerStatus() });
});

// Measured toner / ink levels (SNMP) with learned pages-per-percent forecasts.
router.get('/toner', requireAdmin, (req, res) => {
  res.json({ printers: tonerStatus() });
});

router.post('/supplies/refill', requireAdmin, (req, res) => {
  const printer = String(req.body.printer || '').trim();
  const kind = req.body.kind;
  const capacity = Number(req.body.capacity);
  if (!printer || !['paper', 'toner'].includes(kind)) return res.status(400).json({ error: 'Printer and supply type (paper or toner) are required' });
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000000) return res.status(400).json({ error: 'Capacity must be a whole number of sheets or pages' });
  recordRefill(printer, kind, capacity, req.session.user.id);
  res.json({ ok: true, printers: suppliesStatus(), measured: tonerStatus() });
});

module.exports = router;
