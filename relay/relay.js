#!/usr/bin/env node
'use strict';

/**
 * Receipt System relay
 * ---------------------------------------------------------------
 * Lets the shop's admin reach the Receipt System from anywhere (phone app or
 * browser) without port forwarding or a fixed IP. Run it on any small host
 * with a public HTTPS address (Render, Fly.io, Railway, a VPS behind Caddy…).
 *
 * The shop PC connects OUT to the relay and long-polls for work:
 *   POST /link/poll      shop waits here (up to 25 s) for requests
 *   POST /link/respond   shop answers one request
 *   PUT  /link/pulse     shop stores its encrypted status snapshot
 * People use:
 *   /s/<shop id>/...     the shop's web app, forwarded to the shop
 *   /s/<shop id>/__pulse the last encrypted snapshot (works while the shop is offline)
 *   /s/<shop id>/__status online / last seen
 *
 * Shops authenticate with "Bearer <shop id>.<secret>". The first link from a
 * new shop id registers the secret (stored hashed); later links must match.
 * Set RELAY_KEY so that only shops you configured can link at all.
 *
 * No dependencies: Node 18+ only.
 *
 * Environment
 *   PORT          listen port (default 8080)
 *   RELAY_KEY     shared key shops must present (strongly recommended)
 *   DATA_DIR      where shop registrations and snapshots are kept (default ./data)
 *   TRUST_PROXY   1 = behind a proxy/load balancer that sets X-Forwarded-* (default: on for Render/Fly/Railway)
 *   MAX_SHOPS     how many shops may register (default 20)
 *   TLS_CERT, TLS_KEY  serve HTTPS directly with these PEM files
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const RELAY_KEY = process.env.RELAY_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : !!(process.env.RENDER || process.env.FLY_APP_NAME || process.env.RAILWAY_ENVIRONMENT);
const MAX_SHOPS = Number(process.env.MAX_SHOPS) || 20;

const POLL_HOLD_MS = 25000;
const ONLINE_GRACE_MS = Number(process.env.ONLINE_GRACE_MS) || 45000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY = 10 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024; // base64 of ~12 MB
const MAX_PULSE = 512 * 1024;
const MAX_PENDING = 64;
const RATE_PER_MIN = 1500;
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host', 'content-length',
  'proxy-authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'x-remote-link', 'x-remote-client']);

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
const REGISTRY_FILE = path.join(DATA_DIR, 'shops.json');
let registry = {};
try { registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch { registry = {}; }
const saveRegistry = () => {
  try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 1), { mode: 0o600 }); } catch (err) { log(`Could not save shops: ${err.message}`); }
};

const live = new Map(); // shop id -> { queue, waiter, inflight, lastSeen }
function shopState(id) {
  if (!live.has(id)) live.set(id, { queue: [], waiter: null, inflight: new Map(), lastSeen: 0 });
  return live.get(id);
}
const isOnline = (s) => !!s.waiter || Date.now() - s.lastSeen < ONLINE_GRACE_MS;

const pulses = new Map(); // shop id -> { at, blob }
const pulseFile = (id) => path.join(DATA_DIR, `pulse-${id}.json`);
function storedPulse(id) {
  if (!pulses.has(id)) {
    try { pulses.set(id, JSON.parse(fs.readFileSync(pulseFile(id), 'utf8'))); } catch { return null; }
  }
  return pulses.get(id);
}

function log(msg) { console.log(`${new Date().toISOString()} ${msg}`); }

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    // Proxies append: the last entry is the address our proxy saw.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '';
}
const isHttps = (req) => req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extra = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function sendHtml(res, status, html) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

const rate = new Map(); // ip -> { minute, count }
function rateLimited(ip) {
  const minute = Math.floor(Date.now() / 60000);
  const r = rate.get(ip);
  if (!r || r.minute !== minute) {
    if (rate.size > 10000) rate.clear();
    rate.set(ip, { minute, count: 1 });
    return false;
  }
  return ++r.count > RATE_PER_MIN;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--stock:#EEF2F6;--sheet:#fff;--key:#1B1E24;--key-2:#59606C;--cyan:#0068A3;--magenta:#B8135F;--yellow:#F5C518;--line:#D9E0E8}
@media (prefers-color-scheme:dark){:root{--stock:#14171C;--sheet:#1D2128;--key:#EEF1F5;--key-2:#A7AFBB;--cyan:#5CB8F0;--line:#2E343D}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--stock);color:var(--key);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{max-width:440px;width:100%;background:var(--sheet);border:1px solid var(--line);border-radius:14px;padding:28px;box-shadow:0 10px 30px rgba(20,30,50,.08)}
.bar{display:flex;gap:3px;margin:0 0 18px}.bar i{height:6px;flex:1;border-radius:2px}.bar i:nth-child(1){background:#00A3E0}.bar i:nth-child(2){background:#D6167A}.bar i:nth-child(3){background:var(--yellow)}.bar i:nth-child(4){background:var(--key)}
h1{font-size:22px;line-height:1.25;margin:0 0 8px;letter-spacing:-.01em}p{margin:0 0 12px;color:var(--key-2)}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:10px;background:var(--cyan);color:#fff;border:0;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--magenta);margin-right:8px;vertical-align:middle}
@media (prefers-reduced-motion:no-preference){.card{animation:in .36s cubic-bezier(.16,1,.3,1)}@keyframes in{from{opacity:0;transform:translateY(8px)}}}
</style></head><body><main class="card"><div class="bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>${body}</main></body></html>`;
}

function offlinePage(lastSeen) {
  return page('Shop offline', `<h1><span class="dot" aria-hidden="true"></span>The shop computer is offline</h1>
<p>The Receipt System on the shop PC isn't connected right now${lastSeen ? `. It was last connected <b id="seen" data-at="${esc(lastSeen)}">${esc(lastSeen)}</b>` : ''}.</p>
<p>It reconnects by itself when the PC is on and online. The phone app still shows the last update it sent.</p>
<button class="btn" onclick="location.reload()">Try again</button>
<script>var e=document.getElementById('seen');if(e){var m=Math.round((Date.now()-Date.parse(e.dataset.at))/60000);e.textContent=m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':new Date(e.dataset.at).toLocaleString();}</script>`);
}

// ---------------------------------------------------------------
// Shop side
// ---------------------------------------------------------------
function linkAuth(req) {
  if (RELAY_KEY && !safeEqual(req.headers['x-relay-key'] || '', RELAY_KEY)) {
    return { status: 401, error: 'Wrong relay key. Copy RELAY_KEY from the relay host into Settings > Remote access.' };
  }
  const m = /^Bearer ([a-z0-9]{8,32})\.([A-Za-z0-9_-]{32,128})$/.exec(String(req.headers.authorization || ''));
  if (!m) return { status: 401, error: 'Missing shop credentials' };
  const [, id, secret] = m;
  const hash = sha256(secret);
  const rec = registry[id];
  if (!rec) {
    if (Object.keys(registry).length >= MAX_SHOPS) return { status: 403, error: 'This relay is full.' };
    registry[id] = { hash, created_at: new Date().toISOString() };
    saveRegistry();
    log(`Shop ${id} registered`);
  } else if (!safeEqual(rec.hash, hash)) {
    return { status: 403, error: 'This shop address is registered to a different shop. Reset pairing in Settings > Remote access.' };
  }
  return { id };
}

function deliver(shop, waiter, requests) {
  clearTimeout(waiter.timer);
  if (shop.waiter === waiter) shop.waiter = null;
  shop.lastSeen = Date.now();
  const res = waiter.res;
  if (res.writableEnded) return;
  if (res.headersSent) res.end(JSON.stringify({ requests }));
  else sendJson(res, 200, { requests });
}

function handlePoll(req, res, id) {
  const shop = shopState(id);
  shop.lastSeen = Date.now();
  if (shop.waiter) deliver(shop, shop.waiter, []); // a newer poll replaces the old one
  if (shop.queue.length) return sendJson(res, 200, { requests: shop.queue.splice(0, 16) });
  // Headers go out now, so the shop knows at once that it's connected;
  // the body (any requests) follows when there is work or the hold ends.
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const waiter = { res };
  waiter.timer = setTimeout(() => deliver(shop, waiter, []), POLL_HOLD_MS);
  shop.waiter = waiter;
  res.on('close', () => {
    clearTimeout(waiter.timer);
    if (shop.waiter === waiter) { shop.waiter = null; shop.lastSeen = Date.now(); }
  });
}

function rewriteCookie(cookie, id, secure) {
  let out = String(cookie);
  if (/;\s*path=/i.test(out)) out = out.replace(/;\s*path=([^;]*)/i, (_, p) => `; Path=/s/${id}${p.startsWith('/') ? p : `/${p}`}`);
  else out += `; Path=/s/${id}/`;
  out = out.replace(/;\s*domain=[^;]*/i, '');
  if (secure && !/;\s*secure/i.test(out)) out += '; Secure';
  return out;
}

function rewriteLocation(loc, id) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.exec(loc);
  if (local) return `/s/${id}${local[3] || '/'}`;
  if (loc.startsWith('/') && !loc.startsWith('//')) return `/s/${id}${loc}`;
  return loc;
}

async function handleRespond(req, res, id) {
  let msg;
  try { msg = JSON.parse((await readBody(req, MAX_RESPONSE)).toString('utf8')); } catch (err) { return sendJson(res, err.status || 400, { error: 'Bad response' }); }
  sendJson(res, 200, { ok: true });
  const shop = shopState(id);
  shop.lastSeen = Date.now();
  const pending = shop.inflight.get(msg && msg.id);
  if (!pending) return;
  shop.inflight.delete(msg.id);
  clearTimeout(pending.timer);
  const out = pending.res;
  if (out.writableEnded) return;
  const headers = {};
  const cookies = [];
  for (const [k, v] of Array.isArray(msg.headers) ? msg.headers : []) {
    const key = String(k).toLowerCase();
    if (HOP.has(key) || key === 'x-powered-by') continue;
    if (key === 'set-cookie') cookies.push(rewriteCookie(v, id, pending.secure));
    else if (key === 'location') headers[key] = rewriteLocation(String(v), id);
    else headers[key] = String(v);
  }
  if (cookies.length) headers['set-cookie'] = cookies;
  const body = msg.body ? Buffer.from(msg.body, 'base64') : Buffer.alloc(0);
  headers['content-length'] = body.length;
  const status = Number.isInteger(msg.status) && msg.status >= 100 && msg.status < 600 ? msg.status : 502;
  try {
    out.writeHead(status, headers);
    out.end(pending.method === 'HEAD' ? undefined : body);
  } catch (err) {
    log(`Could not answer ${id}: ${err.message}`);
    if (!out.headersSent) sendJson(out, 502, { error: 'Bad answer from the shop' });
  }
}

async function handlePulseUpload(req, res, id) {
  let blob;
  try { blob = JSON.parse((await readBody(req, MAX_PULSE)).toString('utf8')); } catch (err) { return sendJson(res, err.status || 400, { error: 'Bad snapshot' }); }
  if (!blob || typeof blob.iv !== 'string' || typeof blob.data !== 'string') return sendJson(res, 400, { error: 'Bad snapshot' });
  const entry = { at: new Date().toISOString(), blob: { v: blob.v, alg: blob.alg, iv: blob.iv, data: blob.data } };
  pulses.set(id, entry);
  shopState(id).lastSeen = Date.now();
  fs.writeFile(pulseFile(id), JSON.stringify(entry), () => {});
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------
// People side
// ---------------------------------------------------------------
async function forward(req, res, id, rest, search) {
  const shop = shopState(id);
  const wantsJson = /^\/?api\//.test(rest) || /json/.test(String(req.headers.accept || ''));
  if (!isOnline(shop)) {
    const last = shop.lastSeen ? new Date(shop.lastSeen).toISOString() : (storedPulse(id) || {}).at;
    if (wantsJson) return sendJson(res, 503, { error: 'The shop computer is offline.', offline: true, last_seen: last || null });
    return sendHtml(res, 503, offlinePage(last));
  }
  if (shop.inflight.size >= MAX_PENDING) return sendJson(res, 503, { error: 'The shop is busy. Try again in a moment.' });

  let body = null;
  if (!['GET', 'HEAD'].includes(req.method)) {
    try { body = await readBody(req, MAX_BODY); } catch (err) { return sendJson(res, err.status || 400, { error: err.status === 413 ? 'Upload too large' : 'Bad request' }); }
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === 'string') headers[k] = v;
  const rid = crypto.randomBytes(12).toString('hex');
  const entry = { id: rid, method: req.method, path: `/${rest}${search}`, headers, client_ip: clientIp(req), body: body && body.length ? body.toString('base64') : null };
  const pending = { res, method: req.method, secure: isHttps(req) };
  pending.timer = setTimeout(() => {
    shop.inflight.delete(rid);
    shop.queue = shop.queue.filter((q) => q.id !== rid);
    sendJson(res, 504, { error: "The shop computer didn't answer in time." });
  }, REQUEST_TIMEOUT_MS);
  shop.inflight.set(rid, pending);
  res.on('close', () => {
    if (!res.writableEnded && shop.inflight.get(rid) === pending) {
      clearTimeout(pending.timer);
      shop.inflight.delete(rid);
      shop.queue = shop.queue.filter((q) => q.id !== rid);
    }
  });
  if (shop.waiter) deliver(shop, shop.waiter, [entry]);
  else shop.queue.push(entry);
}

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------
async function route(req, res) {
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return sendJson(res, 400, { error: 'Bad URL' }); }
  const p = url.pathname;

  if (p.startsWith('/link/')) {
    if (req.method !== 'POST' && req.method !== 'PUT') return sendJson(res, 405, { error: 'Method not allowed' });
    const auth = linkAuth(req);
    if (auth.error) { req.resume(); return sendJson(res, auth.status, { error: auth.error }); }
    if (p === '/link/poll' && req.method === 'POST') { req.resume(); return handlePoll(req, res, auth.id); }
    if (p === '/link/respond' && req.method === 'POST') return handleRespond(req, res, auth.id);
    if (p === '/link/pulse' && req.method === 'PUT') return handlePulseUpload(req, res, auth.id);
    req.resume();
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (p === '/healthz') return sendJson(res, 200, { ok: true });
  if (p === '/' || p === '/index.html') {
    return sendHtml(res, 200, page('Receipt System relay', `<h1>Receipt System relay</h1>
<p>This server connects shops running the Receipt System to their owners' phones and browsers. Open your shop's own link (Settings &gt; Remote access on the shop PC) or use the Receipt Admin app.</p>`));
  }

  const m = /^\/s\/([a-z0-9]{8,32})(\/.*)?$/.exec(p);
  if (!m) return sendJson(res, 404, { error: 'Not found' });
  const id = m[1];
  if (!registry[id]) return sendHtml(res, 404, page('Unknown shop', '<h1>No shop at this address</h1><p>Check the link, or pair again from the shop PC (Settings &gt; Remote access).</p>'));
  if (!m[2]) { res.writeHead(301, { location: `/s/${id}/${url.search}` }); return res.end(); }
  if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many requests. Slow down a little.' });

  const rest = m[2].slice(1);
  if (rest === '__status') {
    const shop = shopState(id);
    const pulse = storedPulse(id);
    return sendJson(res, 200, { online: isOnline(shop), last_seen: shop.lastSeen ? new Date(shop.lastSeen).toISOString() : null, pulse_at: pulse ? pulse.at : null }, { 'access-control-allow-origin': '*' });
  }
  if (rest === '__pulse') {
    const pulse = storedPulse(id);
    if (!pulse) return sendJson(res, 404, { error: 'No snapshot yet' });
    return sendJson(res, 200, { ...pulse.blob, relay_at: pulse.at }, { 'access-control-allow-origin': '*' });
  }
  return forward(req, res, id, rest, url.search);
}

function handler(req, res) {
  route(req, res).catch((err) => {
    log(`Error: ${err.stack || err.message}`);
    sendJson(res, 500, { error: 'Relay error' });
  });
}

const server = process.env.TLS_CERT && process.env.TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
  : http.createServer(handler);
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 120000;

if (require.main === module) {
  server.listen(PORT, () => {
    log(`Receipt System relay listening on port ${PORT}`);
    if (!RELAY_KEY) log('WARNING: RELAY_KEY is not set, so any shop can link to this relay. Set it on public hosts.');
  });
  const shutdown = () => { saveRegistry(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { server, rewriteCookie, rewriteLocation };
