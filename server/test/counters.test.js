'use strict';
// Photocopies from typed-in counter readings, for printers no agent can read
// (USB inkjets without PJL, copiers on no PC). Scratch database.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'counters-test-'));
process.env.RECEIPTS_DB = path.join(dir, 'test.db');
const db = require('../db');
const counters = require('../lib/counterReadings');
const { openCopies } = require('../lib/copies');
const notifications = require('../lib/notifications');
const { localIso } = require('../lib/dates');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

const userId = db.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
const agentId = db.prepare("INSERT INTO agents (label, api_key_hash) VALUES ('Front PC', 'x')").run().lastInsertRowid;
db.prepare("INSERT INTO products (name, price, print_color_mode, print_kind, track_stock) VALUES ('B&W photocopy', 0.3, 'mono', 'copy', 0)").run();
let jobSeq = 0;
function printed(printer, pages, at, color = 'mono') {
  db.prepare(`INSERT INTO print_jobs (agent_id, dedupe_key, printer_name, pages, color_mode, submitted_at, completed_at, impressions, sheets)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(agentId, `j${++jobSeq}`, printer, pages, color, localIso(at), localIso(at), pages, pages);
}
const HOUR = 3600 * 1000;
const t0 = new Date();
t0.setHours(8, 0, 0, 0);
const at = (h) => new Date(t0.getTime() + h * HOUR);

test('first reading is the starting point; the next counts copies, PC printing taken off', () => {
  const p = counters.addPrinter({ name: 'EPSON L3250 Series', color: 'mono', userId });
  const first = counters.recordReading(p.id, { count: 10000, userId, now: at(0) });
  assert.strictEqual(first.first, true);
  printed('EPSON L3250 Series', 40, at(2));
  printed('Another Printer', 500, at(3));
  printed('EPSON L3250 Series', 12, at(11)); // after the reading: not this interval
  const r = counters.recordReading(p.id, { count: 10175, userId, now: at(10) });
  assert.deepStrictEqual([r.growth, r.printed, r.copies, r.mono], [175, 40, 135, 135]);
  const event = db.prepare('SELECT * FROM copy_events WHERE id = ?').get(r.event_id);
  assert.strictEqual(event.source, 'manual_counter');
  assert.strictEqual(event.pages, 135);
  assert.strictEqual(event.status, 'open');
  assert.ok(event.counter_from, 'the real span is kept');
  const till = openCopies(72).find((c) => c.id === r.event_id);
  assert.ok(till, 'billable at the till like detected copies');
  assert.strictEqual(till.suggestion.lines[0].name, 'B&W photocopy');
  assert.strictEqual(till.suggestion.lines[0].qty, 135);
});

test('a colour counter splits colour from B&W copies', () => {
  const p = counters.addPrinter({ name: 'Canon G3020', color: 'split', userId });
  counters.recordReading(p.id, { count: 500, color_count: 200, now: at(0) });
  printed('Canon G3020', 10, at(1), 'color');
  printed('Canon G3020', 5, at(1.5), 'mono');
  const r = counters.recordReading(p.id, { count: 560, color_count: 230, now: at(4) });
  // 60 up, 15 printed -> 45 copies; colour 30 up, 10 printed in colour -> 20 colour copies.
  assert.deepStrictEqual([r.copies, r.color, r.mono], [45, 20, 25]);
});

test('nothing copied: no copy run; more printed than counted: a warning, not negative copies', () => {
  const p = counters.addPrinter({ name: 'Old Laser', color: 'mono', userId });
  counters.recordReading(p.id, { count: 100, now: at(0) });
  printed('Old Laser', 30, at(1));
  const r = counters.recordReading(p.id, { count: 120, now: at(2) });
  assert.strictEqual(r.copies, 0);
  assert.strictEqual(r.event_id, null);
  assert.match(r.warning, /counter only went up by 20/);
});

test('a lower number is refused unless the counter was reset', () => {
  const p = counters.addPrinter({ name: 'Ricoh copier', color: 'mono', userId });
  counters.recordReading(p.id, { count: 90000, now: at(0) });
  assert.throws(() => counters.recordReading(p.id, { count: 8900, now: at(1) }), /lower than the last reading \(90000\)/);
  const r = counters.recordReading(p.id, { count: 120, reset: true, now: at(1) });
  assert.deepStrictEqual([r.first, r.reset], [true, true]);
  assert.throws(() => counters.recordReading(p.id, { count: 'abc', now: at(2) }), /whole number/);
});

test('a printer with no reading for a day raises a reminder; a reading clears it', () => {
  const p = counters.addPrinter({ name: 'Copier on no PC', color: 'mono', userId });
  notifications.evaluate();
  const open = () => db.prepare("SELECT * FROM notifications WHERE key = ? AND resolved_at IS NULL").get(`counter:${p.id}`);
  assert.ok(open(), 'reminder raised');
  assert.match(open().title, /Type in the counter of Copier on no PC/);
  counters.recordReading(p.id, { count: 5 });
  notifications.evaluate();
  assert.ok(!open(), 'reminder cleared');
});

test('the built-in agent for typed-in readings never shows as a print agent', () => {
  const kinds = db.prepare('SELECT kind, active FROM agents ORDER BY id').all();
  assert.deepStrictEqual(kinds.map((k) => k.kind), ['agent', 'manual']);
  assert.strictEqual(kinds[1].active, 0, 'it can never sign in');
});

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
