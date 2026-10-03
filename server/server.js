const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { isSea } = require('./lib/sqlite');

// Running as the standalone Windows app (ReceiptSystem.exe)? Then the web
// pages are embedded in the .exe and .env / data/ live beside it.
const STANDALONE = isSea() || !!process.pkg;
const PKG_ROOT = STANDALONE ? path.dirname(process.execPath) : path.join(__dirname, '..');

require('dotenv').config({ path: path.join(PKG_ROOT, '.env') });
const express = require('express');
const session = require('express-session');

require('./db'); // ensures DB + default admin exist before routes load

// Group and score print jobs recorded before print analysis existed.
const backfilled = require('./lib/printAnalysis').backfill();
if (backfilled) console.log(`Analysed ${backfilled} earlier print job(s) into client sessions.`);

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const salesRoutes = require('./routes/sales');
const productRoutes = require('./routes/products');
const dashboardRoutes = require('./routes/dashboard');
const agentRoutes = require('./routes/agents');
const printJobRoutes = require('./routes/printJobs');
const reportRoutes = require('./routes/reports');
const printSessionRoutes = require('./routes/printSessions');
const insightRoutes = require('./routes/insights');
const copyRoutes = require('./routes/copies');
const printerRoutes = require('./routes/printers');
const { router: reconciliationRoutes } = require('./routes/reconciliation');
const { router: remoteRoutes, publicRouter: remotePublic } = require('./routes/remote');
const remoteLink = require('./lib/remoteLink');
const notificationRoutes = require('./routes/notifications');
const jobRoutes = require('./routes/jobs');
const { SqliteStore } = require('./lib/sessionStore');
const { createStatic, diskSource, seaSource, compressResponses } = require('./lib/staticFiles');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' })); // 5mb to allow a small base64 logo

// The app can be reached from the internet through the relay: basic
// hardening headers, and mark requests that arrived through the link.
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(remoteLink.remoteContext);
app.use(compressResponses);

// No SESSION_SECRET configured: generate a random one once and keep it in
// data/, so logins survive restarts without anyone having to edit .env.
function sessionSecret() {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured !== 'change-this-secret-in-production') return configured;
  const file = path.join(PKG_ROOT, 'data', 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(file, secret, { mode: 0o600 }); } catch { /* read-only: per-run secret */ }
    return secret;
  }
}

app.use(session({
  store: new SqliteStore(require('./db')),
  secret: sessionSecret(),
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
app.use('/api/print-sessions', printSessionRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/copies', copyRoutes);
app.use('/api/printers', printerRoutes);
app.use('/api/reconciliation', reconciliationRoutes);
app.use('/api/remote', remoteRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/jobs', jobRoutes);
app.use(remotePublic);

// Relative, so it also works under the relay's /s/<shop>/ prefix.
app.get('/', (req, res) => res.redirect('login.html'));

app.locals.lanUrls = () => lanAddresses().map((ip) => `http://${ip}:${server.address() ? server.address().port : PORT}/`);
// The phone app, if it has been put beside the server (ReceiptAdmin.apk).
app.locals.apkPath = [path.join(PKG_ROOT, 'ReceiptAdmin.apk'), path.join(PKG_ROOT, 'dist', 'ReceiptAdmin.apk')].find((f) => fs.existsSync(f)) || path.join(PKG_ROOT, 'ReceiptAdmin.apk');

app.use(createStatic(isSea() ? seaSource() : diskSource(path.join(PKG_ROOT, 'public'))));

// Unknown API routes and unexpected errors answer in JSON, which is what the
// frontend's api() helper expects to read an error message from.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function openBrowser(url) {
  if (process.env.NO_BROWSER) return;
  const { exec } = require('child_process');
  if (process.platform === 'win32') exec(`start "" "${url}"`);
  else if (process.platform === 'darwin') exec(`open "${url}"`);
}

const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('------------------------------------------------------');
  console.log(` Receipt System is running at ${url}`);
  for (const ip of lanAddresses()) console.log(` Other devices / print agents: http://${ip}:${PORT}`);
  const link = remoteLink.config();
  if (link.enabled) console.log(` Remote access (phone app): ${remoteLink.shopUrl(link)}`);
  if (STANDALONE) console.log(' Keep this window open. Closing it stops the system.');
  console.log('------------------------------------------------------');
  if (STANDALONE) openBrowser(url);
  remoteLink.start(server.address().port);
  require('./lib/notifications').start();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Most likely already running (double-clicked twice): just open it.
    console.error(`Port ${PORT} is already in use. If Receipt System is already running, use that window.`);
    if (STANDALONE) openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(1), STANDALONE ? 8000 : 0);
    return;
  }
  throw err;
});
