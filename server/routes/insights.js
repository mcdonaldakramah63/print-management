const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { forecastRevenue } = require('../lib/insights/forecast');
const { riskAlerts } = require('../lib/insights/risk');
const { stockOutlook } = require('../lib/insights/stock');
const { suggestFor } = require('../lib/insights/baskets');
const { reconcile } = require('./reconciliation');

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

module.exports = router;
