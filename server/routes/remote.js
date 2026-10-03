const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('../middleware/auth');
const remoteLink = require('../lib/remoteLink');
const { buildPulse, encrypt } = require('../lib/pulse');

const router = express.Router();

function view(req) {
  const cfg = remoteLink.config();
  const lan = req.app.locals.lanUrls ? req.app.locals.lanUrls() : [];
  return {
    enabled: cfg.enabled,
    relay_url: cfg.relay_url,
    has_relay_key: !!cfg.relay_key,
    shop_id: cfg.shop_id,
    shop_url: remoteLink.shopUrl(cfg),
    lan_urls: lan,
    pulse_key: cfg.pulse_key,
    status: remoteLink.status(),
    apk_available: !!req.app.locals.apkPath && fs.existsSync(req.app.locals.apkPath),
    via_remote: !!req.remote
  };
}

router.get('/', requireAdmin, (req, res) => res.json(view(req)));

router.put('/', requireAdmin, (req, res) => {
  const body = req.body || {};
  // Turning the link off from the phone would cut the phone off: say so.
  if (req.remote && body.enabled === false) {
    return res.status(400).json({ error: "Remote access can only be turned off at the shop, or you'd lock yourself out." });
  }
  if (body.enabled === true) {
    const weak = require('./auth').defaultPasswordAdmins();
    if (weak.length) {
      return res.status(400).json({ error: `Change the default password of ${weak.join(', ')} first (My account). It is published, and remote access would let anyone on the internet use it.` });
    }
  }
  try {
    remoteLink.update({ enabled: body.enabled, relay_url: body.relay_url, relay_key: body.relay_key });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json(view(req));
});

router.post('/reset', requireAdmin, (req, res) => {
  if (req.remote) return res.status(400).json({ error: 'Reset pairing at the shop: it changes the address you are using now.' });
  remoteLink.reset();
  res.json(view(req));
});

// ---------- Public, used by the phone app ----------
// Encrypted: readable only with the pairing key (see lib/pulse.js).
let cached = null;
const publicRouter = express.Router();
publicRouter.get('/__pulse', (req, res) => {
  const cfg = remoteLink.config();
  if (!cached || cached.key !== cfg.pulse_key || Date.now() - cached.at > 20000) {
    cached = { key: cfg.pulse_key, at: Date.now(), blob: encrypt(buildPulse(), cfg.pulse_key) };
  }
  res.set('Cache-Control', 'no-store').json(cached.blob);
});
publicRouter.get('/__status', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ online: true, direct: true, at: new Date().toISOString() });
});
publicRouter.get('/download/ReceiptAdmin.apk', (req, res) => {
  const apk = req.app.locals.apkPath;
  if (!apk || !fs.existsSync(apk)) return res.status(404).type('text').send('The Android app has not been placed next to the Receipt System on this PC.');
  res.download(apk, path.basename(apk));
});

module.exports = { router, publicRouter };
