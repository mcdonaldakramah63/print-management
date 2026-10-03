const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireAgent } = require('../middleware/agentAuth');
const control = require('../lib/printerControl');

const router = express.Router();

// Agent: snapshot + command results in, waiting commands out.
router.post('/agent-sync', requireAgent, (req, res) => {
  res.json(control.agentSync(req.agent.id, req.body || {}));
});

// Any signed-in user: every printer's front panel and diagnosis.
// ?glance=1 (the nav badge) doesn't count as someone watching.
router.get('/', requireAuth, (req, res) => {
  if (!req.query.glance) control.markViewed();
  res.json({ printers: control.listPrinters(req.session.user.role), now: new Date().toISOString() });
});

// One printer in full. ?refresh=1 re-reads its features from the PC.
router.get('/detail', requireAuth, (req, res) => {
  control.markViewed();
  const detail = control.printerDetail(Number(req.query.agent_id), String(req.query.printer || ''), req.session.user.role,
    { refresh: req.query.refresh === '1' });
  if (!detail) return res.status(404).json({ error: 'Printer not found' });
  res.json(detail);
});

// Ask a printer's agent to do something.
router.post('/commands', requireAuth, (req, res) => {
  try {
    const { agent_id: agentId, printer, action, params } = req.body || {};
    const result = control.enqueue({
      agentId: Number(agentId), printer: String(printer || ''), action: String(action || ''), params, user: req.session.user
    });
    control.markViewed();
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (!(err instanceof control.ControlError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

router.get('/commands/:id', requireAuth, (req, res) => {
  const command = control.getCommand(Number(req.params.id));
  if (!command) return res.status(404).json({ error: 'Not found' });
  control.markViewed();
  res.json({ command });
});

module.exports = router;
