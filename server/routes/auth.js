const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, loadSessionUser } = require('../middleware/auth');
const { createLoginGuard, waitMessage } = require('../lib/loginGuard');

const router = express.Router();
const guard = createLoginGuard();
const REMEMBER_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

/** Active admins still signing in with the default password. */
function defaultPasswordAdmins() {
  return db.prepare("SELECT username, password_hash FROM users WHERE role = 'admin' AND active = 1").all()
    .filter((u) => bcrypt.compareSync(DEFAULT_PASSWORD, u.password_hash)).map((u) => u.username);
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const ip = req.clientIp || req.ip;
  const wait = guard.check(username, ip, req.remote);
  if (wait > 0) return res.status(429).json({ error: waitMessage(wait) });

  const refuse = () => {
    const locked = guard.fail(username, ip, req.remote);
    res.status(locked > 0 ? 429 : 401).json({ error: locked > 0 ? waitMessage(locked) : 'Invalid username or password' });
  };
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !user.active) {
    bcrypt.compareSync(password, '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.LsnEeJZ0JcHZy0vV5S5vXvPZ3tY2'); // same time as a real check
    return refuse();
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return refuse();
  guard.succeed(username, req.remote);

  // From outside the shop (through the relay) only admins may sign in, and
  // not while they still use the published default password.
  if (req.remote && user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can sign in from outside the shop.' });
  }
  if (req.remote && password === DEFAULT_PASSWORD) {
    return res.status(403).json({ error: 'Change the default admin password at the shop (My account) before signing in remotely.' });
  }

  // Issue a fresh session id on login so a session id planted before
  // authentication can't be reused afterwards (session fixation).
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start a session' });
    req.session.user = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role
    };
    // "Keep me signed in" (the phone app always asks for it): 30 days.
    if (req.body.remember === true) req.session.cookie.maxAge = REMEMBER_MS;
    res.json({ user: req.session.user });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  res.json({ user: loadSessionUser(req), remote: !!req.remote });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const ok = bcrypt.compareSync(String(currentPassword || ''), user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.defaultPasswordAdmins = defaultPasswordAdmins;
