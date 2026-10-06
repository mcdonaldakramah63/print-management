const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const counters = require('../lib/counterReadings');

const router = express.Router();

// Printers whose counter is typed in, with their last reading (the close
// card shows these to whoever closes the day).
router.get('/', requireAuth, (req, res) => {
  res.json({ printers: counters.listPrinters({ includeInactive: req.query.all === '1' && req.session.user.role === 'admin' }) });
});

// Admin: start typed-in readings for a printer (or a copier on no PC).
router.post('/printers', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    res.status(201).json({ printer: counters.addPrinter({ name: b.name, unit: b.unit, color: b.color, userId: req.session.user.id }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/printers/:id', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    res.json({ printer: counters.updatePrinter(req.params.id, { unit: b.unit, color: b.color, active: b.active }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Anyone signed in can type in a reading (usually at closing).
router.post('/printers/:id/readings', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    res.status(201).json(counters.recordReading(req.params.id, { count: b.count, color_count: b.color_count, reset: b.reset === true, userId: req.session.user.id }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/printers/:id/readings', requireAdmin, (req, res) => {
  res.json({ readings: counters.readings(req.params.id) });
});

module.exports = router;
