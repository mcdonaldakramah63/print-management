const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// List all users (admin only)
router.get('/', requireAdmin, (req, res) => {
  // Exclude the locked system account used for Print Monitoring auto-billed
  // sales — it's not a real login and would just confuse this list.
  const users = db.prepare(
    `SELECT id, username, full_name, role, active, created_at FROM users
     WHERE username != 'print-monitor' ORDER BY created_at DESC`
  ).all();
  res.json({ users });
});

// Create a new user (admin only)
router.post('/', requireAdmin, (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !full_name || !role) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!['admin', 'cashier'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or cashier' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)
  `).run(username, hash, full_name, role);

  res.status(201).json({ id: info.lastInsertRowid });
});

// Activate/deactivate a user (admin only)
router.patch('/:id/active', requireAdmin, (req, res) => {
  const { active } = req.body;
  const id = Number(req.params.id);
  if (id === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  res.json({ ok: true });
});

// Admin resets another user's password
router.post('/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
