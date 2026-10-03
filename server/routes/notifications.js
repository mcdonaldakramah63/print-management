const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const notifications = require('../lib/notifications');

const router = express.Router();

// Everything for the alerts panel.
router.get('/', requireAdmin, (req, res) => res.json(notifications.list()));

// Light poll for the bell: unread alerts only.
router.get('/unread', requireAdmin, (req, res) => res.json({ notifications: notifications.unread() }));

router.post('/read', requireAdmin, (req, res) => {
  const body = req.body || {};
  const ids = body.all === true ? 'all' : (Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : []);
  res.json({ marked: notifications.markRead(ids), ...notifications.list() });
});

// Check now (after a refill or a delivery, without waiting for the next pass).
router.post('/refresh', requireAdmin, (req, res) => {
  notifications.evaluate();
  res.json(notifications.list());
});

module.exports = router;
