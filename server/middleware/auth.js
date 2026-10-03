const db = require('../db');

// Re-read the user on every request instead of trusting the copy stored in the
// session at login, so disabling an account (or changing its role) takes
// effect immediately rather than when the 12-hour session cookie expires.
function loadSessionUser(req) {
  if (!req.session.user) return null;
  const user = db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?')
    .get(req.session.user.id);
  if (!user || !user.active) {
    req.session.user = null;
    return null;
  }
  // Through the relay (from outside the shop) only admins get in.
  if (req.remote && user.role !== 'admin') return null;
  req.session.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role
  };
  return req.session.user;
}

function requireAuth(req, res, next) {
  if (!loadSessionUser(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const user = loadSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, loadSessionUser };
