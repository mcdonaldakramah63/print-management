/**
 * Receipt System relay on Cloudflare Workers (free plan)
 * ---------------------------------------------------------------
 * The same job as relay/relay.js: lets the admin reach the shop's Receipt
 * System from anywhere, without port forwarding. Here each shop gets a
 * Durable Object that holds:
 *   - the shop's link: one WebSocket the shop PC keeps open. It uses the
 *     hibernation API, so an idle link costs nothing; pings are answered
 *     without waking the object;
 *   - requests from phones and browsers waiting for the shop's answer;
 *   - the shop's last encrypted status snapshot (readable only by paired
 *     phones), served even while the shop PC is off.
 *
 *   GET  /healthz                 { ok, link: "ws" }  (the shop picks WebSocket mode)
 *   WS   /link/ws?shop=<id>       shop link; first message { type: "hello", id, secret, key }
 *   ANY  /s/<id>/...              the shop's web app
 *   GET  /s/<id>/__status         online, last seen
 *   GET  /s/<id>/__pulse          last encrypted snapshot
 *
 * Messages on the link (JSON):
 *   relay -> shop  { type: "req", id, method, path, headers, client_ip, body(base64) }
 *   shop -> relay  { type: "res", id, status, headers: [[k, v]...], body(base64) }
 *   shop -> relay  { type: "pulse", blob }           -> { type: "pulse-ok" }
 *   "ping" -> "pong" (answered by the runtime)
 *
 * Secrets: RELAY_KEY (required). A shop's first link registers its secret
 * (stored hashed); later links must match it.
 */
import { DurableObject } from 'cloudflare:workers';

const SHOP_ID = /^[a-z0-9]{8,32}$/;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY = 10 * 1024 * 1024;
const MAX_PENDING = 64;
const MAX_PULSE = 512 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host', 'content-length',
  'proxy-authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'x-remote-link', 'x-remote-client',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cdn-loop', 'x-relay-shop']);

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } });
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

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function rewriteCookie(cookie, id) {
  let out = String(cookie);
  if (/;\s*path=/i.test(out)) out = out.replace(/;\s*path=([^;]*)/i, (_, p) => `; Path=/s/${id}${p.startsWith('/') ? p : `/${p}`}`);
  else out += `; Path=/s/${id}/`;
  out = out.replace(/;\s*domain=[^;]*/i, '');
  if (!/;\s*secure/i.test(out)) out += '; Secure';
  return out;
}

function rewriteLocation(loc, id) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.exec(loc);
  if (local) return `/s/${id}${local[3] || '/'}`;
  if (loc.startsWith('/') && !loc.startsWith('//')) return `/s/${id}${loc}`;
  return loc;
}

// ---------------------------------------------------------------
// Front door: routes each request to its shop's Durable Object
// ---------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/healthz') return json({ ok: true, link: 'ws' });
    if (p === '/' || p === '/index.html') {
      return html(page('Receipt System relay', `<h1>Receipt System relay</h1>
<p>This server connects shops running the Receipt System to their owners' phones and browsers. Open your shop's own link (Settings &gt; Remote access on the shop PC) or use the Receipt Admin app.</p>`));
    }

    if (p === '/link/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
      const shop = url.searchParams.get('shop') || '';
      if (!SHOP_ID.test(shop)) return json({ error: 'Bad shop id' }, 400);
      if (!env.RELAY_KEY) return json({ error: 'The relay has no RELAY_KEY set.' }, 503);
      return stub(env, shop).fetch(withShop(request, shop));
    }

    const m = /^\/s\/([a-z0-9]{8,32})(\/.*)?$/.exec(p);
    if (!m) return json({ error: 'Not found' }, 404);
    if (!m[2]) return Response.redirect(`${url.origin}/s/${m[1]}/${url.search}`, 301);
    return stub(env, m[1]).fetch(withShop(request, m[1]));
  }
};

const stub = (env, shop) => env.SHOPS.get(env.SHOPS.idFromName(shop));

function withShop(request, shop) {
  const headers = new Headers(request.headers);
  headers.set('x-relay-shop', shop);
  return new Request(request, { headers });
}

// ---------------------------------------------------------------
// One shop
// ---------------------------------------------------------------
export class ShopRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.inflight = new Map(); // request id -> resolve(answer | null)
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const shop = request.headers.get('x-relay-shop');

    if (url.pathname === '/link/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ shop, auth: false });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!(await this.ctx.storage.get('secretHash'))) {
      return html(page('Unknown shop', '<h1>No shop at this address</h1><p>Check the link, or pair again from the shop PC (Settings &gt; Remote access).</p>'), 404);
    }
    const rest = url.pathname.slice(`/s/${shop}/`.length);
    if (rest === '__status') {
      const pulse = await this.ctx.storage.get('pulse');
      const lastSeen = await this.ctx.storage.get('lastSeen');
      return json({ online: !!this.shopSocket(), last_seen: lastSeen ? new Date(lastSeen).toISOString() : null, pulse_at: pulse ? pulse.at : null }, 200, { 'access-control-allow-origin': '*' });
    }
    if (rest === '__pulse') {
      const pulse = await this.ctx.storage.get('pulse');
      if (!pulse) return json({ error: 'No snapshot yet' }, 404);
      return json({ ...pulse.blob, relay_at: pulse.at }, 200, { 'access-control-allow-origin': '*' });
    }
    return this.forward(request, shop, rest, url.search);
  }

  shopSocket() {
    return this.ctx.getWebSockets().find((ws) => (ws.deserializeAttachment() || {}).auth) || null;
  }

  async forward(request, shop, rest, search) {
    const ws = this.shopSocket();
    const wantsJson = /^api\//.test(rest) || /json/.test(request.headers.get('accept') || '');
    if (!ws) {
      const seen = await this.ctx.storage.get('lastSeen');
      const last = seen ? new Date(seen).toISOString() : null;
      if (wantsJson) return json({ error: 'The shop computer is offline.', offline: true, last_seen: last }, 503);
      return html(offlinePage(last), 503);
    }
    if (this.inflight.size >= MAX_PENDING) return json({ error: 'The shop is busy. Try again in a moment.' }, 503);

    let body = null;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_BODY) return json({ error: 'Upload too large' }, 413);
      if (buf.byteLength) body = toBase64(buf);
    }
    const headers = {};
    for (const [k, v] of request.headers) if (!HOP.has(k)) headers[k] = v;

    const id = crypto.randomUUID();
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.inflight.delete(id); resolve(null); }, REQUEST_TIMEOUT_MS);
      this.inflight.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      try {
        ws.send(JSON.stringify({ type: 'req', id, method: request.method, path: `/${rest}${search}`, headers, client_ip: request.headers.get('cf-connecting-ip') || '', body }));
      } catch {
        clearTimeout(timer);
        this.inflight.delete(id);
        resolve({ lost: true });
      }
    });
    if (!answer) return json({ error: "The shop computer didn't answer in time." }, 504);
    if (answer.lost) return json({ error: 'The shop computer went offline.', offline: true }, 503);

    const out = new Headers();
    for (const [k, v] of Array.isArray(answer.headers) ? answer.headers : []) {
      const key = String(k).toLowerCase();
      if (HOP.has(key) || key === 'x-powered-by') continue;
      if (key === 'set-cookie') out.append('set-cookie', rewriteCookie(v, shop));
      else if (key === 'location') out.set('location', rewriteLocation(String(v), shop));
      else out.append(key, String(v));
    }
    const status = Number.isInteger(answer.status) && answer.status >= 200 && answer.status < 600 ? answer.status : 502;
    const noBody = request.method === 'HEAD' || status === 204 || status === 304;
    // The shop may already have gzipped the body: pass it through untouched.
    return new Response(noBody || !answer.body ? null : fromBase64(answer.body), { status, headers: out, encodeBody: 'manual' });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const att = ws.deserializeAttachment() || {};

    if (!att.auth) {
      const refuse = (status, error) => {
        try { ws.send(JSON.stringify({ type: 'error', status, error })); } catch { /* gone */ }
        ws.close(1008, 'refused');
      };
      if (msg.type !== 'hello') return refuse(400, 'Say hello first.');
      if (!this.env.RELAY_KEY || !safeEqual(msg.key || '', this.env.RELAY_KEY)) {
        return refuse(401, 'Wrong relay key. Copy RELAY_KEY into Settings > Remote access on the shop PC.');
      }
      if (msg.id !== att.shop || !/^[A-Za-z0-9_-]{32,128}$/.test(String(msg.secret || ''))) return refuse(401, 'Missing shop credentials');
      const hash = await sha256(msg.secret);
      const known = await this.ctx.storage.get('secretHash');
      if (!known) await this.ctx.storage.put({ secretHash: hash, createdAt: Date.now() });
      else if (!safeEqual(known, hash)) return refuse(403, 'This shop address is registered to a different shop. Reset pairing in Settings > Remote access.');
      // A newer link from the same shop replaces the old one.
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && (other.deserializeAttachment() || {}).auth) { try { other.close(1000, 'replaced'); } catch { /* gone */ } }
      }
      ws.serializeAttachment({ ...att, auth: true });
      await this.ctx.storage.put('lastSeen', Date.now());
      ws.send(JSON.stringify({ type: 'ok' }));
      return;
    }

    if (msg.type === 'res') {
      const resolve = this.inflight.get(msg.id);
      if (resolve) { this.inflight.delete(msg.id); resolve(msg); }
      return;
    }
    if (msg.type === 'pulse') {
      const b = msg.blob;
      if (!b || typeof b.iv !== 'string' || typeof b.data !== 'string' || b.data.length > MAX_PULSE) return;
      await this.ctx.storage.put({ pulse: { at: new Date().toISOString(), blob: { v: b.v, alg: b.alg, iv: b.iv, data: b.data } }, lastSeen: Date.now() });
      ws.send(JSON.stringify({ type: 'pulse-ok' }));
    }
  }

  async webSocketClose(ws, code) {
    await this.closed(ws, code);
  }

  async webSocketError(ws) {
    await this.closed(ws, 1011);
  }

  async closed(ws, code) {
    const att = ws.deserializeAttachment() || {};
    if (att.auth) {
      await this.ctx.storage.put('lastSeen', Date.now());
      // Requests waiting on this link won't be answered.
      const stillLinked = this.ctx.getWebSockets().some((w) => w !== ws && (w.deserializeAttachment() || {}).auth);
      if (!stillLinked) {
        for (const resolve of this.inflight.values()) resolve({ lost: true });
        this.inflight.clear();
      }
    }
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch { /* already closed */ }
  }
}
