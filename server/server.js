const path = require('path');

// When running as a pkg-built .exe, __dirname points into the read-only
// virtual snapshot. PKG_ROOT is the folder containing the .exe instead, which
// is where .env and public/ live. For `node server/server.js` it's the project root.
const PKG_ROOT = process.pkg
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..');

require('dotenv').config({ path: path.join(PKG_ROOT, '.env') });
const express = require('express');
const session = require('express-session');

require('./db'); // ensures DB + default admin exist before routes load

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const salesRoutes = require('./routes/sales');
const productRoutes = require('./routes/products');
const dashboardRoutes = require('./routes/dashboard');
const agentRoutes = require('./routes/agents');
const printJobRoutes = require('./routes/printJobs');
const reportRoutes = require('./routes/reports');
const { router: reconciliationRoutes } = require('./routes/reconciliation');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' })); // 5mb to allow a small base64 logo

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-this-secret-in-production') {
  console.warn('WARNING: SESSION_SECRET is not set to a unique value in .env - set one before real use.');
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/products', productRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/print-jobs', printJobRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/reconciliation', reconciliationRoutes);

app.get('/', (req, res) => res.redirect('/login.html'));

app.use(express.static(path.join(PKG_ROOT, 'public')));

// Unknown API routes and unexpected errors answer in JSON, which is what the
// frontend's api() helper expects to read an error message from.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
  console.log(`Receipt system running at http://localhost:${PORT}`);
});
