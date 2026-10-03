'use strict';
// CI: prepares a shop server + relay for the emulator test. Signs in, sets a
// real password, rings up a sale, turns on remote access and waits until
// the relay holds the shop's encrypted snapshot. Writes SHOP_URL (as the
// emulator sees the host: 10.0.2.2) and SHOP_KEY to $GITHUB_ENV.
const fs = require('fs');
const SHOP = 'http://127.0.0.1:3000';
const RELAY = 'http://127.0.0.1:8080';
let cookie = '';
async function call(method, path, body) {
  const res = await fetch(SHOP + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(SHOP + '/login.html'); break; } catch { await wait(500); } }
  await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  await call('POST', '/api/auth/change-password', { currentPassword: 'admin123', newPassword: 'Str0ng-pass' });
  await call('POST', '/api/sales', { items: [{ name: 'A4 colour print', qty: 12, unit_price: 2.5 }], payment_method: 'momo' });
  await call('POST', '/api/sales', { items: [{ name: 'Photocopy', qty: 40, unit_price: 0.5 }], payment_method: 'cash', amount_tendered: 20 });
  const remote = await call('PUT', '/api/remote', { enabled: true, relay_url: RELAY, relay_key: 'ci-relay-key' });
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${remote.shop_url}__pulse`);
    if (r.ok) break;
    await wait(500);
  }
  const shopUrl = remote.shop_url.replace('127.0.0.1', '10.0.2.2');
  console.log('Shop URL for the emulator:', shopUrl);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `SHOP_URL=${shopUrl}\nSHOP_KEY=${remote.pulse_key}\n`);
})().catch((err) => { console.error(err); process.exit(1); });
