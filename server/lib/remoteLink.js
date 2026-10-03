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
const http = require('http');
const db = require('../db');
const { buildPulse, encrypt, newKey, b64url } = require('./pulse');

const TOKEN = crypto.randomBytes(24).toString('hex');
const POLL_TIMEOUT_MS = 40000;
const LOCAL_TIMEOUT_MS = 28000;
const PULSE_EVERY_MS = 2 * 60 * 1000;
// Hop-by-hop headers stay on each leg. Content-Encoding passes through: a
// gzipped answer reaches the phone still gzipped.
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host', 'content-length', 'x-remote-link', 'x-remote-client']);
const localAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

/** One request to this server, bytes untouched (no decompression). */
function localRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: localAgent, timeout: LOCAL_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

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
  try { u = new URL(raw); } catch { throw new Error('Enter the relay address, e.g. https://receipt-relay.yourname.workers.dev'); }
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

// Reply channel of the current link: HTTP for the Node relay, the open
// WebSocket for the Cloudflare relay.
let activeSocket = null;

async function respond(cfg, payload) {
  try {
    await fetch(`${cfg.relay_url}/link/respond`, { method: 'POST', headers: authHeaders(cfg), body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  } catch { /* the waiting browser times out at the relay */ }
}

/** Run one forwarded request against this server and send the answer back. */
async function handle(cfg, r, reply = (payload) => respond(cfg, payload)) {
  state.requests++;
  const fail = (status, error) => reply({ id: r.id, status, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify({ error })).toString('base64') });
  if (typeof r.path !== 'string' || !/^\/(?![/\\])/.test(r.path) || !/^[A-Z]{3,7}$/.test(String(r.method))) return fail(400, 'Bad request');
  const headers = {};
  for (const [k, v] of Object.entries(r.headers || {})) {
    if (!HOP.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
  }
  headers['x-remote-link'] = TOKEN;
  headers['x-remote-client'] = String(r.client_ip || 'remote').slice(0, 64);
  try {
    const body = r.body && !['GET', 'HEAD'].includes(r.method) ? Buffer.from(r.body, 'base64') : null;
    if (body) headers['content-length'] = String(body.length);
    const res = await localRequest(r.method, r.path, headers, body);
    const out = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      const k = res.rawHeaders[i].toLowerCase();
      if (!HOP.has(k)) out.push([k, res.rawHeaders[i + 1]]);
    }
    await reply({ id: r.id, status: res.status, headers: out, body: res.body.toString('base64') });
  } catch (err) {
    await fail(502, `The shop computer couldn't answer: ${err.message}`);
  }
}

const describe = (err) => (err.name === 'TimeoutError' ? "The relay didn't answer in time." : err.cause && err.cause.code ? `Can't reach the relay (${err.cause.code}).` : err.message);

/**
 * Which link the relay speaks: the Cloudflare relay holds a WebSocket per
 * shop (it costs nothing while idle there); the Node relay long-polls.
 */
async function linkMode(cfg, signal) {
  const res = await fetch(`${cfg.relay_url}/healthz`, { signal: AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`The relay answered ${res.status}. Is the address right?`);
  const body = await res.json().catch(() => null);
  if (!body || body.ok !== true) throw new Error("That address isn't a Receipt System relay.");
  return body.link === 'ws' ? 'ws' : 'poll';
}

async function linkLoop(gen, signal) {
  let failures = 0;
  while (gen === generation) {
    const cfg = config();
    if (!cfg.enabled || !cfg.relay_url || !port) break;
    let mode;
    try {
      mode = await linkMode(cfg, signal);
    } catch (err) {
      if (gen !== generation) break;
      failures++;
      Object.assign(state, { connected: false, last_error: describe(err) });
      await sleep(Math.min(60000, 1000 * 2 ** Math.min(failures, 6)), signal);
      continue;
    }
    if (mode === 'ws') {
      const started = Date.now();
      const end = await wsSession(cfg, signal);
      if (gen !== generation) break;
      state.connected = false;
      if (end.error) state.last_error = end.error;
      else if (!state.last_error) state.last_error = 'The connection to the relay closed. Reconnecting…';
      state.refused = !!end.refused;
      failures = Date.now() - started > 60000 ? 1 : failures + 1;
      await sleep(end.refused ? 5 * 60 * 1000 : Math.min(60000, 1000 * 2 ** Math.min(failures, 6)), signal);
    } else {
      failures = await pollLoop(gen, signal, failures);
    }
  }
}

/**
 * One WebSocket session with the Cloudflare relay. Resolves when it ends
 * ({ error, refused }). Pings every 25 s and gives up on a link that has
 * gone quiet for 70 s (a dropped mobile/ADSL line may never send a close).
 */
function wsSession(cfg, signal) {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') return resolve({ error: 'This relay needs Node.js 22 or newer on the shop PC.' });
    const url = `${cfg.relay_url.replace(/^http/, 'ws')}/link/ws?shop=${encodeURIComponent(cfg.shop_id)}`;
    let ws;
    try { ws = new WebSocket(url); } catch (err) { return resolve({ error: describe(err) }); }
    const result = {};
    let lastHeard = Date.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
      if (activeSocket === ws) activeSocket = null;
      try { ws.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const onAbort = () => finish();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setInterval(() => {
      if (Date.now() - lastHeard > 70000) { result.error = "The relay stopped answering. Reconnecting…"; finish(); return; }
      try { ws.send('ping'); } catch { /* closing */ }
    }, 25000);
    if (timer.unref) timer.unref();

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', id: cfg.shop_id, secret: cfg.shop_secret, key: cfg.relay_key || '' }));
    });
    ws.addEventListener('message', (ev) => {
      lastHeard = Date.now();
      if (ev.data === 'pong' || typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ok') {
        activeSocket = ws;
        if (!state.connected) state.since = new Date().toISOString();
        Object.assign(state, { connected: true, last_ok_at: new Date().toISOString(), last_error: null, refused: false });
        if (!state.pulse_at) pushPulse();
      } else if (msg.type === 'error') {
        result.error = msg.error || 'The relay refused this shop.';
        result.refused = msg.status === 401 || msg.status === 403;
      } else if (msg.type === 'req') {
        state.last_ok_at = new Date().toISOString();
        handle(cfg, msg, async (payload) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'res', ...payload }));
        });
      } else if (msg.type === 'pulse-ok') {
        state.pulse_at = new Date().toISOString();
        state.pulse_error = null;
      }
    });
    ws.addEventListener('error', (ev) => {
      if (!result.error) result.error = ev && ev.message ? `Can't reach the relay (${ev.message}).` : "Can't reach the relay.";
    });
    ws.addEventListener('close', () => finish());
  });
}

/** Long polling (the Node relay). Returns the failure count when it stops. */
async function pollLoop(gen, signal, failures = 0) {
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
      state.last_error = describe(err);
      await sleep(state.refused ? 5 * 60 * 1000 : Math.min(60000, 1000 * 2 ** Math.min(failures, 6)), signal);
      // Re-check which relay this is now and then (it may have been replaced).
      if (failures % 3 === 0) return failures;
    }
  }
  return failures;
}

async function pushPulse() {
  const cfg = config();
  if (!cfg.enabled || !cfg.relay_url) return;
  try {
    const blob = encrypt(buildPulse(), cfg.pulse_key);
    if (activeSocket && activeSocket.readyState === 1) {
      activeSocket.send(JSON.stringify({ type: 'pulse', blob }));
      return; // confirmed by a pulse-ok message
    }
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
  linkLoop(generation, controller.signal);
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
