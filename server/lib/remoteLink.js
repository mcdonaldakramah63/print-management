// ---------------------------------------------------------------
// Remote link: the shop's way out to the internet
//
// The shop PC usually sits behind a router with no public address, so
// nothing on the internet can connect to it. Instead it connects out to a
// relay (relay/relay.js, run on any small cloud host) and keeps asking
// "anything for me?" (HTTP long polling, which passes through every router,
// proxy and mobile network). When the admin's phone or a browser opens
// https://<relay>/s/<shop id>/, the relay hands the request to the shop on
// its waiting poll; the shop runs it against this server on 127.0.0.1 and
// posts the answer back. No port forwarding, no fixed IP.
//
//   shop  --POST /link/poll------->  relay   <---- phone / browser
//   shop  <-- { requests: [...] }--  relay
//   shop  --POST /link/respond---->  relay   ----> answer
//   shop  --PUT  /link/pulse------>  relay   (encrypted status snapshot)
//
// Requests that arrive this way are marked (a per-process token header only
// this module knows), so the server can treat them as remote: only admins
// may sign in through the link.
// ---------------------------------------------------------------
const crypto = require('crypto');
const db = require('../db');
const { buildPulse, encrypt, newKey, b64url } = require('./pulse');

const TOKEN = crypto.randomBytes(24).toString('hex');
const POLL_TIMEOUT_MS = 40000;
const LOCAL_TIMEOUT_MS = 28000;
const PULSE_EVERY_MS = 2 * 60 * 1000;
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host', 'content-length', 'content-encoding', 'x-remote-link', 'x-remote-client']);

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// ---------- Settings ----------
function config() {
  let row = db.prepare('SELECT * FROM remote_link WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO remote_link (id, shop_id, shop_secret, pulse_key) VALUES (1, ?, ?, ?)')
      .run(newShopId(), b64url(crypto.randomBytes(32)), newKey());
    row = db.prepare('SELECT * FROM remote_link WHERE id = 1').get();
  }
  return { ...row, enabled: !!row.enabled };
}

function newShopId() {
  // 16 lowercase letters/digits (~82 bits): hard to guess, easy to type.
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.randomBytes(16)].map((b) => abc[b % abc.length]).join('');
}

function normaliseRelayUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { throw new Error('Enter the relay address, e.g. https://my-relay.onrender.com'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The relay address must start with https://');
  if (u.search || u.hash) throw new Error('The relay address should not have ? or # in it');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

function shopUrl(cfg = config()) {
  return cfg.relay_url ? `${cfg.relay_url}/s/${cfg.shop_id}/` : '';
}

// ---------- The link ----------
const state = { connected: false, since: null, last_ok_at: null, last_error: null, refused: false, pulse_at: null, pulse_error: null, requests: 0 };
let port = null;
let generation = 0;
let controller = null;
let pulseTimer = null;

function authHeaders(cfg) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.shop_id}.${cfg.shop_secret}`,
    ...(cfg.relay_key ? { 'x-relay-key': cfg.relay_key } : {})
  };
}

async function respond(cfg, payload) {
  try {
    await fetch(`${cfg.relay_url}/link/respond`, { method: 'POST', headers: authHeaders(cfg), body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  } catch { /* the waiting browser times out at the relay */ }
}

/** Run one forwarded request against this server and send the answer back. */
async function handle(cfg, r) {
  state.requests++;
  const fail = (status, error) => respond(cfg, { id: r.id, status, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify({ error })).toString('base64') });
  if (typeof r.path !== 'string' || !/^\/(?![/\\])/.test(r.path) || !/^[A-Z]{3,7}$/.test(String(r.method))) return fail(400, 'Bad request');
  const headers = {};
  for (const [k, v] of Object.entries(r.headers || {})) {
    if (!HOP.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
  }
  headers['x-remote-link'] = TOKEN;
  headers['x-remote-client'] = String(r.client_ip || 'remote').slice(0, 64);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${r.path}`, {
      method: r.method,
      headers,
      body: r.body && !['GET', 'HEAD'].includes(r.method) ? Buffer.from(r.body, 'base64') : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS)
    });
    const body = Buffer.from(await res.arrayBuffer());
    const out = [];
    res.headers.forEach((v, k) => { if (!HOP.has(k) && k !== 'set-cookie') out.push([k, v]); });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) out.push(['set-cookie', c]);
    await respond(cfg, { id: r.id, status: res.status, headers: out, body: body.toString('base64') });
  } catch (err) {
    await fail(502, `The shop computer couldn't answer: ${err.message}`);
  }
}

async function pollLoop(gen, signal) {
  let failures = 0;
  while (gen === generation) {
    const cfg = config();
    if (!cfg.enabled || !cfg.relay_url || !port) break;
    try {
      const res = await fetch(`${cfg.relay_url}/link/poll`, {
        method: 'POST', headers: authHeaders(cfg), body: '{}',
        signal: AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]) : AbortSignal.timeout(POLL_TIMEOUT_MS)
      });
      if (res.status === 401 || res.status === 403) {
        const body = await res.json().catch(() => ({}));
        state.refused = true;
        throw new Error(body.error || 'The relay refused this shop. Check the relay key.');
      }
      if (!res.ok) throw new Error(`The relay answered ${res.status}`);
      // The relay sends headers as soon as the poll is waiting: connected.
      if (!state.connected) { state.since = new Date().toISOString(); if (!state.pulse_at) pushPulse(); }
      Object.assign(state, { connected: true, last_ok_at: new Date().toISOString(), last_error: null, refused: false });
      failures = 0;
      const body = await res.json();
      for (const r of Array.isArray(body.requests) ? body.requests : []) handle(cfg, r);
    } catch (err) {
      if (gen !== generation) break;
      failures++;
      state.connected = false;
      state.last_error = err.name === 'TimeoutError' ? "The relay didn't answer in time." : err.cause && err.cause.code ? `Can't reach the relay (${err.cause.code}).` : err.message;
      await sleep(state.refused ? 5 * 60 * 1000 : Math.min(60000, 1000 * 2 ** Math.min(failures, 6)), signal);
    }
  }
}

async function pushPulse() {
  const cfg = config();
  if (!cfg.enabled || !cfg.relay_url) return;
  try {
    const blob = encrypt(buildPulse(), cfg.pulse_key);
    const res = await fetch(`${cfg.relay_url}/link/pulse`, { method: 'PUT', headers: authHeaders(cfg), body: JSON.stringify(blob), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`The relay answered ${res.status}`);
    state.pulse_at = new Date().toISOString();
    state.pulse_error = null;
  } catch (err) {
    state.pulse_error = err.message;
  }
}

/** (Re)start the link with the current settings. */
function restart() {
  generation++;
  if (controller) controller.abort();
  clearInterval(pulseTimer);
  Object.assign(state, { connected: false, since: null, last_error: null, refused: false, pulse_at: null, pulse_error: null });
  const cfg = config();
  if (!cfg.enabled || !cfg.relay_url || !port) return;
  controller = new AbortController();
  pollLoop(generation, controller.signal);
  pulseTimer = setInterval(pushPulse, PULSE_EVERY_MS);
  if (pulseTimer.unref) pulseTimer.unref();
}

function start(listeningPort) {
  port = listeningPort;
  restart();
}

function stop() {
  generation++;
  if (controller) controller.abort();
  clearInterval(pulseTimer);
}

function update({ enabled, relay_url: relayUrl, relay_key: relayKey }) {
  const cfg = config();
  const url = relayUrl === undefined ? cfg.relay_url : normaliseRelayUrl(relayUrl);
  const on = enabled === undefined ? cfg.enabled : !!enabled;
  if (on && !url) throw new Error('Enter the relay address first.');
  const key = relayKey === undefined ? cfg.relay_key : String(relayKey).trim().slice(0, 200);
  db.prepare("UPDATE remote_link SET enabled = ?, relay_url = ?, relay_key = ?, updated_at = datetime('now') WHERE id = 1").run(on ? 1 : 0, url, key);
  restart();
  return config();
}

/** New shop address, link secret and pairing key: every paired phone must pair again. */
function reset() {
  config();
  db.prepare("UPDATE remote_link SET shop_id = ?, shop_secret = ?, pulse_key = ?, updated_at = datetime('now') WHERE id = 1")
    .run(newShopId(), b64url(crypto.randomBytes(32)), newKey());
  restart();
  return config();
}

function status() {
  return { ...state };
}

// ---------- Marking requests that came through the link ----------
function isLinkToken(value) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function remoteContext(req, res, next) {
  req.remote = isLinkToken(req.get('x-remote-link'));
  req.clientIp = req.remote ? String(req.get('x-remote-client') || 'remote') : req.ip;
  next();
}

module.exports = { config, update, reset, start, stop, restart, status, shopUrl, pushPulse, remoteContext, normaliseRelayUrl };
