// When running as a pkg exe, __dirname points into the virtual snapshot (read-only).
// PKG_ROOT resolves to the folder containing the exe at runtime, which is writable.
// For normal `node server/server.js` runs, PKG_ROOT equals the project root as usual.
const path = require('path');
const PKG_ROOT = process.pkg
  ? path.dirname(process.execPath)          // beside the .exe
  : path.join(__dirname, '..');             // project root (normal dev run)

// Load .env from PKG_ROOT so it's always next to the exe / project root
require('dotenv').config({ path: path.join(PKG_ROOT, '.env') });

const express = require('express');
const session = require('express-session');

require('./db'); // ensures DB + default admin exist before routes load

const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const salesRoutes    = require('./routes/sales');
const productRoutes  = require('./routes/products');
const dashboardRoutes = require('./routes/dashboard');
const agentRoutes    = require('./routes/agents');
const printJobRoutes = require('./routes/printJobs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' })); // 5mb to allow a small base64 logo

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
    httpOnly: true,
    sameSite: 'lax',
  },
}));

app.use('/api/auth',       authRoutes);
app.use('/api/users',      userRoutes);
app.use('/api/settings',   settingsRoutes);
app.use('/api/sales',      salesRoutes);
app.use('/api/products',   productRoutes);
app.use('/api/dashboard',  dashboardRoutes);
app.use('/api/agents',     agentRoutes);
app.use('/api/print-jobs', printJobRoutes);

app.get('/', (req, res) => res.redirect('/login.html'));

// Serve static files from PKG_ROOT/public so they are accessible both in
// normal dev mode and when running as a pkg exe.
app.use(express.static(path.join(PKG_ROOT, 'public')));

app.listen(PORT, () => {
  console.log('------------------------------------------------------');
  console.log(` Receipt system running at http://localhost:${PORT}`);
  console.log('------------------------------------------------------');
});
