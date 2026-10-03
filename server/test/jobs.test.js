'use strict';
// Job builder pricing, paying for a job through a sale, and the toner and
// stock alerts. Runs against a scratch database.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-'));
process.env.RECEIPTS_DB = path.join(dir, 'test.db');
const db = require('../db');
const { quote } = require('../lib/jobPricing');
const { createSale } = require('../lib/saleCreator');
const notifications = require('../lib/notifications');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const add = db.prepare(`INSERT INTO products (name, price, print_color_mode, print_kind, print_sides, track_stock, stock_qty, reorder_level)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const id = (info) => Number(info.lastInsertRowid);
const P = {
  mono: id(add.run('B&W print', 0.5, 'mono', 'print', 1, 0, 0, 0)),
  monoDuplex: id(add.run('B&W print both sides', 0.8, 'mono', 'print', 2, 0, 0, 0)),
  color: id(add.run('Colour print', 2, 'color', 'print', 1, 0, 0, 0)),
  colorA3: id(add.run('A3 colour print', 4, 'color', 'print', 1, 0, 0, 0)),
  monoCopy: id(add.run('B&W photocopy', 0.3, 'mono', 'copy', 1, 0, 0, 0)),
  binding: id(add.run('Spiral binding', 10, null, 'print', 1, 1, 8, 5))
};
const userId = db.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;

test('one-sided pages are charged per page, copies multiply', () => {
  const q = quote([{ type: 'print', pages: 10, copies: 2, color: 'mono', sides: 1 }]);
  assert.strictEqual(q.lines.length, 1);
  assert.strictEqual(q.lines[0].product_id, P.mono);
  assert.strictEqual(q.lines[0].qty, 20);
  assert.strictEqual(q.subtotal, 10);
  assert.strictEqual(q.sheets, 20);
  assert.deepStrictEqual(q.warnings, []);
});

test('both sides use the per-sheet product: odd pages round up', () => {
  const q = quote([{ type: 'print', pages: 9, copies: 2, color: 'mono', sides: 2 }]);
  assert.strictEqual(q.lines[0].product_id, P.monoDuplex);
  assert.strictEqual(q.lines[0].qty, 10);
  assert.strictEqual(q.subtotal, 8);
  assert.strictEqual(q.sheets, 10);
});

test('paper size matches on the product name; a named size never stands in for another', () => {
  const a3 = quote([{ type: 'print', pages: 3, copies: 1, color: 'color', paper: 'A3' }]);
  assert.strictEqual(a3.lines[0].product_id, P.colorA3);
  assert.strictEqual(a3.subtotal, 12);
  const a4 = quote([{ type: 'print', pages: 3, copies: 1, color: 'color', paper: 'A4' }]);
  assert.strictEqual(a4.lines[0].product_id, P.color);
  const a5 = quote([{ type: 'print', pages: 2, copies: 1, color: 'mono', paper: 'A5' }]);
  assert.strictEqual(a5.lines[0].product_id, P.mono);
  assert.ok(a5.warnings.some((w) => /A5/.test(w)), 'unnamed size used for A5 is flagged');
});

test('no two-sided colour product: each side is charged as a page, with a warning', () => {
  const q = quote([{ type: 'print', pages: 4, copies: 1, color: 'color', sides: 2 }]);
  assert.strictEqual(q.lines[0].product_id, P.color);
  assert.strictEqual(q.lines[0].qty, 4);
  assert.ok(q.warnings.some((w) => /each side/.test(w)));
});

test('photocopies use the copy product; colour copies fall back to the print product', () => {
  assert.strictEqual(quote([{ type: 'copy', pages: 5, copies: 1, color: 'mono' }]).lines[0].product_id, P.monoCopy);
  assert.strictEqual(quote([{ type: 'copy', pages: 5, copies: 1, color: 'color' }]).lines[0].product_id, P.color);
});

test('items and custom lines; bad input is refused with the part number', () => {
  const q = quote([
    { type: 'item', product_id: P.binding, qty: 2 },
    { type: 'custom', name: 'Design work', qty: 1, unit_price: 15.5 }
  ]);
  assert.strictEqual(q.subtotal, 35.5);
  assert.throws(() => quote([]), /at least one/);
  assert.throws(() => quote([{ type: 'print', pages: 0 }]), /Part 1: enter the number of pages/);
  assert.throws(() => quote([{ type: 'custom', name: 'x', qty: 1, unit_price: 1 }, { type: 'item', product_id: 9999, qty: 1 }]), /Part 2: choose a product/);
  assert.throws(() => quote([{ type: 'laser-etching' }]), /unknown kind/);
});

function newJob(parts, status = 'queued') {
  const q = quote(parts);
  const info = db.prepare("INSERT INTO jobs (job_no, parts, lines, total, status, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`T-${Math.random()}`, JSON.stringify(q.parts), JSON.stringify(q.lines), q.subtotal, status, userId);
  return { id: Number(info.lastInsertRowid), lines: q.lines };
}
const job = (jobId) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
const sell = (j, extra = {}) => createSale({
  userId, items: j.lines.map((l) => ({ name: l.name, qty: l.qty, unit_price: l.unit_price, product_id: l.product_id })),
  paymentMethod: 'cash', jobIds: [j.id], ...extra
});

test('a sale pays for a job once; a ready job is handed over with it', () => {
  const queued = newJob([{ type: 'print', pages: 4, copies: 1, color: 'mono' }]);
  const sale = sell(queued);
  assert.strictEqual(job(queued.id).sale_id, sale.id);
  assert.strictEqual(job(queued.id).status, 'queued', 'paying up front keeps it on the board');
  assert.throws(() => sell(queued), /already paid/);

  const ready = newJob([{ type: 'item', product_id: P.binding, qty: 1 }], 'ready');
  sell(ready);
  assert.strictEqual(job(ready.id).status, 'collected');
  assert.ok(job(ready.id).collected_at);

  const cancelled = newJob([{ type: 'print', pages: 1, copies: 1, color: 'mono' }], 'cancelled');
  const before = db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  assert.throws(() => sell(cancelled), /cancelled/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, before, 'the failed sale left nothing behind');
});

test('stock alerts: raised once, escalated when out, resolved after a delivery', () => {
  // Binding: 8 in stock, one sold above -> 7, alert level 5.
  notifications.evaluate();
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'stock' AND resolved_at IS NULL").get().n, 0);

  db.prepare('UPDATE products SET stock_qty = 3 WHERE id = ?').run(P.binding);
  const raised = notifications.evaluate();
  assert.strictEqual(raised.length, 1);
  assert.strictEqual(raised[0].level, notifications.WARNING);
  assert.match(raised[0].title, /Spiral binding/);
  assert.strictEqual(notifications.evaluate().length, 0, 'not raised twice');

  notifications.markRead('all');
  db.prepare('UPDATE products SET stock_qty = 0 WHERE id = ?').run(P.binding);
  const worse = notifications.evaluate();
  assert.strictEqual(worse.length, 1);
  assert.strictEqual(worse[0].level, notifications.CRITICAL);
  assert.strictEqual(notifications.unread().length, 1, 'escalation is unread again');
  assert.ok(notifications.forPulse().some((a) => a.kind === 'stock' && a.severity === 'high'));

  db.prepare('UPDATE products SET stock_qty = 40 WHERE id = ?').run(P.binding);
  notifications.evaluate();
  const { open, resolved } = notifications.list();
  assert.strictEqual(open.length, 0);
  assert.strictEqual(resolved.length, 1);
});

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
