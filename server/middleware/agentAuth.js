const crypto = require('crypto');
const db = require('../db');

// Agents authenticate with a long random key sent in the X-Agent-Key header,
// generated once at registration and never stored in plaintext.
// We store SHA-256 hashes and compare hashes (fast, and fine for a
// high-entropy random token — unlike user passwords, there's no need for
// the slow, salted hashing bcrypt gives us).
function hashAgentKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateAgentKey() {
  return crypto.randomBytes(32).toString('hex'); // 64-char random token
}

function requireAgent(req, res, next) {
  const rawKey = req.header('X-Agent-Key');
  if (!rawKey) {
    return res.status(401).json({ error: 'Missing X-Agent-Key header' });
  }

  const keyHash = hashAgentKey(rawKey);
  const agent = db.prepare('SELECT * FROM agents WHERE api_key_hash = ?').get(keyHash);

  if (!agent || !agent.active) {
    return res.status(401).json({ error: 'Invalid or revoked agent key' });
  }

  db.prepare('UPDATE agents SET last_seen_at = datetime(\'now\') WHERE id = ?').run(agent.id);
  req.agent = agent;
  next();
}

module.exports = { requireAgent, hashAgentKey, generateAgentKey };
