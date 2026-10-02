const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// List all users (admin only)
router.get('/', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT id, username, full_name, role, active, created_at FROM users ORDER BY created_at DESC'
  ).all();
  res.json({ users });
});

// Create a new user (admin only)
router.post('/', requireAdmin, (req, res) => {
  const { password, role } = req.body;
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const full_name = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
  if (!username || typeof password !== 'string' || !password || !full_name || !role) {
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
  const info = db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

// Edit a user's display name and/or role (admin only)
router.patch('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const fullName = req.body.full_name === undefined ? user.full_name : String(req.body.full_name).trim();
  const role = req.body.role === undefined ? user.role : req.body.role;
  if (!fullName) return res.status(400).json({ error: 'Full name is required' });
  if (!['admin', 'cashier'].includes(role)) return res.status(400).json({ error: 'Role must be admin or cashier' });

  if (user.role === 'admin' && role !== 'admin') {
    if (id === req.session.user.id) {
      return res.status(400).json({ error: 'You cannot remove your own admin role' });
    }
    const otherAdmins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).get(id).n;
    if (otherAdmins === 0) return res.status(400).json({ error: 'At least one active admin is required' });
  }

  db.prepare('UPDATE users SET full_name = ?, role = ? WHERE id = ?').run(fullName, role, id);
  res.json({ ok: true });
});

// Admin resets another user's password
router.post('/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

module.exports = router;
