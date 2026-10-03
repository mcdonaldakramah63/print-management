'use strict';
// End to end: relay + shop server + link. Signs in through the relay, checks
// cookies and redirects are rewritten, cashiers are kept out, the encrypted
// snapshot decrypts with the pairing key, and the relay reports the shop
// offline (still serving the snapshot) once the shop stops.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
const RELAY_PORT = 39000 + Math.floor(Math.random() * 500);
const SHOP_PORT = RELAY_PORT + 600;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const SHOP = `http://127.0.0.1:${SHOP_PORT}`;
const KEY = 'test-relay-key';
const children = [];

function start(script, cwd, env) {
  const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  children.push(child);
  return child;
}

async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

class Jar {
  constructor() { this.cookies = new Map(); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [name, value] = pair.split('=');
      this.cookies.set(name.trim(), { value, attrs: attrs.map((a) => a.trim()) });
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v.value}`).join('; '); }
}

async function call(base, method, url, body, jar) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(jar && jar.cookies.size ? { cookie: jar.header() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  if (jar) jar.store(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, headers: res.headers, text, json };
}

function decrypt(blob, keyB64url) {
  const key = Buffer.from(keyB64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const raw = Buffer.from(blob.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
}

(async () => {
  // Shop server from a scratch copy (it keeps its database beside server/).
  for (const dir of ['server', 'public']) fs.cpSync(path.join(ROOT, dir), path.join(tmp, dir), { recursive: true });
  const nodePath = path.join(ROOT, 'node_modules');
  start(path.join(ROOT, 'relay', 'relay.js'), tmp, { PORT: String(RELAY_PORT), RELAY_KEY: KEY, DATA_DIR: path.join(tmp, 'relay-data'), TRUST_PROXY: '0', ONLINE_GRACE_MS: '3000' });
  const shop = start(path.join(tmp, 'server', 'server.js'), tmp, { PORT: String(SHOP_PORT), SESSION_SECRET: 'test', NO_BROWSER: '1', NODE_PATH: nodePath });
  await waitFor(async () => (await fetch(`${RELAY}/healthz`)).ok, 'relay');
  await waitFor(async () => (await fetch(`${SHOP}/login.html`)).ok, 'shop server');

  // At the shop: admin turns on remote access, adds a cashier.
  const local = new Jar();
  assert.equal((await call(SHOP, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, local)).status, 200);
  assert.equal((await call(SHOP, 'POST', '/api/users', { username: 'cash', password: 'cash123', full_name: 'Cashier', role: 'cashier' }, local)).status < 300, true);
  const weak = await call(SHOP, 'PUT', '/api/remote', { enabled: true, relay_url: RELAY, relay_key: KEY }, local);
  assert.equal(weak.status, 400, 'default password blocks remote access');
  assert.match(weak.json.error, /default password/);
  assert.equal((await call(SHOP, 'POST', '/api/auth/change-password', { currentPassword: 'admin123', newPassword: 'Str0ng-pass' }, local)).status, 200);
  const wrong = await call(SHOP, 'PUT', '/api/remote', { enabled: true, relay_url: RELAY, relay_key: 'nope' }, local);
  assert.equal(wrong.status, 200);
  await waitFor(async () => (await call(SHOP, 'GET', '/api/remote', null, local)).json.status.refused, 'wrong key refused');
  const conf = await call(SHOP, 'PUT', '/api/remote', { enabled: true, relay_url: `${RELAY}/`, relay_key: KEY }, local);
  assert.equal(conf.json.relay_url, RELAY, 'trailing slash removed');
  const shopPath = `/s/${conf.json.shop_id}`;
  assert.equal(conf.json.shop_url, `${RELAY}${shopPath}/`);
  await waitFor(async () => (await call(SHOP, 'GET', '/api/remote', null, local)).json.status.connected, 'link connected');

  // From anywhere: through the relay.
  const status = await call(RELAY, 'GET', `${shopPath}/__status`);
  assert.equal(status.json.online, true);
  const bare = await call(RELAY, 'GET', shopPath);
  assert.equal(bare.status, 301);
  const root = await call(RELAY, 'GET', `${shopPath}/`);
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), 'login.html', 'relative redirect kept');
  const loginPage = await call(RELAY, 'GET', `${shopPath}/login.html`);
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /<form/);

  const phone = new Jar();
  const login = await call(RELAY, 'POST', `${shopPath}/api/auth/login`, { username: 'admin', password: 'Str0ng-pass', remember: true }, phone);
  assert.equal(login.status, 200, login.text);
  const sid = phone.cookies.get('connect.sid');
  assert.ok(sid, 'session cookie');
  assert.ok(sid.attrs.includes(`Path=${shopPath}/`), `cookie path rewritten: ${sid.attrs}`);
  const expires = Date.parse(sid.attrs.find((a) => /^Expires=/i.test(a)).slice(8));
  assert.ok(expires - Date.now() > 29 * 24 * 3600 * 1000, 'remember me: 30 days');
  const summary = await call(RELAY, 'GET', `${shopPath}/api/dashboard/summary`, null, phone);
  assert.equal(summary.status, 200);
  assert.ok(summary.json.today);
  const sale = await call(RELAY, 'POST', `${shopPath}/api/sales`, { items: [{ name: 'Remote test', qty: 1, unit_price: 4 }], payment_method: 'cash', amount_tendered: 5 }, phone);
  assert.equal(sale.status, 201, sale.text);
  const css = await fetch(`${RELAY}${shopPath}/css/style.css`);
  assert.equal(css.status, 200);
  assert.ok((await css.arrayBuffer()).byteLength > 10000);
  const font = await fetch(`${RELAY}${shopPath}/fonts/archivo-latin.woff2`);
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2', 'binary bodies survive');

  const me = await call(RELAY, 'GET', `${shopPath}/api/auth/me`, null, phone);
  assert.equal(me.json.remote, true, 'server knows the request is remote');
  assert.equal((await call(SHOP, 'GET', '/api/auth/me', null, local)).json.remote, false);

  // Remote settings can't switch remote access off (you'd be locked out).
  const off = await call(RELAY, 'PUT', `${shopPath}/api/remote`, { enabled: false }, phone);
  assert.equal(off.status, 400);

  // Cashiers can't sign in from outside, but can at the counter.
  const cashier = await call(RELAY, 'POST', `${shopPath}/api/auth/login`, { username: 'cash', password: 'cash123' }, new Jar());
  assert.equal(cashier.status, 403);
  assert.equal((await call(SHOP, 'POST', '/api/auth/login', { username: 'cash', password: 'cash123' }, new Jar())).status, 200);

  // Remote guessing locks remote sign-in only.
  for (let i = 0; i < 5; i++) await call(RELAY, 'POST', `${shopPath}/api/auth/login`, { username: 'admin', password: 'guess' }, new Jar());
  assert.equal((await call(RELAY, 'POST', `${shopPath}/api/auth/login`, { username: 'admin', password: 'Str0ng-pass' }, new Jar())).status, 429);
  assert.equal((await call(SHOP, 'POST', '/api/auth/login', { username: 'admin', password: 'Str0ng-pass' }, new Jar())).status, 200);
  // The phone's existing session still works.
  assert.equal((await call(RELAY, 'GET', `${shopPath}/api/auth/me`, null, phone)).json.user.username, 'admin');

  // Snapshot: encrypted at the relay, readable with the pairing key.
  await waitFor(async () => (await call(RELAY, 'GET', `${shopPath}/__pulse`)).status === 200, 'pulse at relay');
  const blob = (await call(RELAY, 'GET', `${shopPath}/__pulse`)).json;
  assert.ok(!JSON.stringify(blob).includes('My Business'), 'relay only sees ciphertext');
  const pulse = decrypt(blob, conf.json.pulse_key);
  assert.equal(pulse.v, 1);
  assert.equal(pulse.business, 'My Business');
  assert.equal(pulse.series.length, 14);
  assert.throws(() => decrypt(blob, crypto.randomBytes(32).toString('base64')), 'wrong key fails');
  // The shop serves its own (fresh) snapshot for phones on the shop Wi-Fi.
  const direct = decrypt((await call(SHOP, 'GET', '/__pulse')).json, conf.json.pulse_key);
  assert.ok(direct.today.count >= 1, 'direct pulse is fresh');

  // Another shop can't take over this shop's address.
  const hijack = await fetch(`${RELAY}/link/poll`, { method: 'POST', headers: { authorization: `Bearer ${conf.json.shop_id}.${'x'.repeat(43)}`, 'x-relay-key': KEY }, body: '{}' });
  assert.equal(hijack.status, 403);
  const noKey = await fetch(`${RELAY}/link/poll`, { method: 'POST', headers: { authorization: `Bearer abcdefgh12345678.${'y'.repeat(43)}` }, body: '{}' });
  assert.equal(noKey.status, 401);

  // Shop PC switched off: offline page, JSON for the API, snapshot still there.
  shop.kill();
  await waitFor(async () => (await call(RELAY, 'GET', `${shopPath}/__status`)).json.online === false, 'relay sees shop offline', 20000);
  const offPage = await call(RELAY, 'GET', `${shopPath}/app.html`);
  assert.equal(offPage.status, 503);
  assert.match(offPage.text, /offline/);
  const offApi = await call(RELAY, 'GET', `${shopPath}/api/dashboard/summary`, null, phone);
  assert.equal(offApi.status, 503);
  assert.equal(offApi.json.offline, true);
  assert.equal((await call(RELAY, 'GET', `${shopPath}/__pulse`)).status, 200);

  console.log('relay: all checks passed');
})().catch((err) => {
  console.error(err);
  for (const c of children) if (c.output) console.error(`--- ${c.spawnargs[1]}\n${c.output.slice(-3000)}`);
  process.exitCode = 1;
}).finally(() => {
  for (const c of children) c.kill();
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows locks */ } }, 300);
});
