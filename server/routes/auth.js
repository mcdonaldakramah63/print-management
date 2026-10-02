const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, loadSessionUser } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !user.active) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid username or password' });
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
  res.json({ user: loadSessionUser(req) });
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
