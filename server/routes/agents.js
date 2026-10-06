const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { hashAgentKey, generateAgentKey } = require('../middleware/agentAuth');

const router = express.Router();

// List agents with a simple online/offline read based on last_seen_at
router.get('/', requireAdmin, (req, res) => {
  const agents = db.prepare(`
    SELECT id, label, active, last_seen_at, created_at,
      CASE
        WHEN last_seen_at IS NOT NULL AND
             (julianday('now') - julianday(last_seen_at)) * 24 * 60 <= 5
        THEN 1 ELSE 0
      END AS online
    FROM agents WHERE kind = 'agent' ORDER BY created_at DESC
  `).all();
  res.json({ agents });
});

// Register a new agent. The raw API key is returned ONCE here and never again —
// store it in the agent's config when you set it up on the shop PC.
router.post('/', requireAdmin, (req, res) => {
  const label = typeof req.body.label === 'string' ? req.body.label : '';
  if (!label.trim()) {
    return res.status(400).json({ error: 'A label for this agent/PC is required' });
  }

  const rawKey = generateAgentKey();
  const info = db.prepare(`
    INSERT INTO agents (label, api_key_hash) VALUES (?, ?)
  `).run(label.trim(), hashAgentKey(rawKey));

  res.status(201).json({ id: info.lastInsertRowid, label: label.trim(), api_key: rawKey });
});

router.patch('/:id/active', requireAdmin, (req, res) => {
  const info = db.prepare('UPDATE agents SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ok: true });
});

module.exports = router;
