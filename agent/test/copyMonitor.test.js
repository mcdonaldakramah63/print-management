'use strict';
// Photocopy detection: the ledger logic on a simulated clock, then the full
// poller against a fake SNMP printer whose page counter we turn by hand.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CopyDetector, createCopyMonitor, jobUnits } = require('../copyMonitor');
const { startFakePrinter } = require('./fakePrinter');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 3, 8, 0, 0);
const at = (m) => T0 + m * MIN;

function run(script, opts = {}) {
  const det = new CopyDetector(opts);
  const dev = det.device('printer');
  dev.color = opts.color || 'mono';
  let count = 10000;
  const events = [];
  for (let m = 0; m <= script.length + 20; m++) {
    const step = script[m] || {};
    for (const job of step.spool || []) det.jobSpooling('printer', job.external_job_id, at(m));
    for (const job of step.jobs || []) det.jobPrinted('printer', job, at(m));
    count += step.add || 0;
    if (step.reset) count = step.reset;
    events.push(...det.observe('printer', { count, unit: opts.unit || 'impressions', status: step.status || 'idle' }, at(m)));
  }
  return events;
}

const job = (id, m, pages, extra = {}) => ({
  external_job_id: String(id), pages, copies: 1, duplex: 'simplex',
  submitted_at: new Date(at(m)).toISOString(), completed_at: new Date(at(m)).toISOString(), ...extra
});

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

test('units: duplex halves sheets, copies multiply', () => {
  assert.deepStrictEqual(jobUnits({ pages: 5, copies: 2, duplex: 'duplex' }), { impressions: 10, sheets: 6 });
  assert.strictEqual(jobUnits({ pages: 0 }), null);
});

test('print jobs that come out are not copies', () => {
  const s = [];
  s[1] = { jobs: [job(1, 1, 10)] };
  s[2] = { add: 6 }; s[3] = { add: 4 };
  assert.deepStrictEqual(run(s), []);
});

test('a walk-up copy run is detected as one event', () => {
  const s = [];
  s[3] = { add: 12, status: 'printing' };
  s[4] = { add: 13, status: 'printing' };
  const ev = run(s);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].pages, 25);
  assert.strictEqual(ev[0].mono_pages, 25);
  assert.strictEqual(ev[0].confidence, 'high');
  assert.ok(ev[0].evidence.includes('printing_without_job'));
  assert.ok(ev[0].evidence.includes('sustained'));
});

test('a copy made right after a print: only the extra pages', () => {
  const s = [];
  s[2] = { jobs: [job(1, 2, 5)] };
  s[3] = { add: 12 };
  const ev = run(s);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].pages, 7);
  assert.strictEqual(ev[0].confidence, 'medium');
});

test('counter moving before the spooler reports the job is not a copy', () => {
  const s = [];
  s[2] = { add: 20 };
  s[5] = { jobs: [job(1, 1, 20)] };   // reported 3 minutes later, submitted at minute 1
  assert.deepStrictEqual(run(s), []);
});

test('a long job still spooling holds detection until it is reported', () => {
  const s = [];
  s[1] = { spool: [{ external_job_id: '9' }] };
  for (let m = 2; m <= 11; m++) s[m] = { add: 10, status: 'printing' };
  s[12] = { jobs: [job(9, 1, 100)] };
  assert.deepStrictEqual(run(s), []);
});

test('a job with no page count absorbs growth while it prints', () => {
  const s = [];
  s[2] = { jobs: [job(1, 2, 0)] };
  s[3] = { add: 7 };
  assert.deepStrictEqual(run(s), []);
});

test('duplex job on a printer that counts sheets', () => {
  const s = [];
  s[2] = { jobs: [job(1, 2, 5, { copies: 2, duplex: 'duplex' })] };
  s[3] = { add: 6 };
  assert.deepStrictEqual(run(s, { unit: 'sheets' }), []);
  s[3] = { add: 9 };
  const ev = run(s, { unit: 'sheets' });
  assert.strictEqual(ev[0].pages, 3);
  assert.strictEqual(ev[0].unit, 'sheets');
});

test('counter reset re-baselines instead of inventing pages', () => {
  const s = [];
  s[3] = { reset: 50 };
  s[4] = { add: 0 };
  assert.deepStrictEqual(run(s), []);
});

test('a spooled job that never came out makes later growth low confidence', () => {
  const s = [];
  s[1] = { jobs: [job(1, 1, 8)] };     // never prints (jam / held at the printer)
  s[24] = { add: 8 };                  // ...comes out later, after its credit expired
  const ev = run(s);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].confidence, 'low');
  assert.ok(ev[0].evidence.includes('spooled_pages_missing_nearby'));
});

test('single page is low confidence (status / fax report pages)', () => {
  const s = [];
  s[3] = { add: 1 };
  assert.strictEqual(run(s)[0].confidence, 'low');
});

test('two separate copy runs stay separate; colour device reports unknown colour', () => {
  const s = [];
  s[2] = { add: 4 };
  s[20] = { add: 9 };
  const ev = run(s, { color: 'unknown' });
  assert.strictEqual(ev.length, 2);
  assert.deepStrictEqual(ev.map((e) => e.pages), [4, 9]);
  assert.strictEqual(ev[1].unknown_pages, 9);
});

test('vendor copy counters are used directly, colour split included', () => {
  const det = new CopyDetector();
  det.device('p').color = 'unknown';
  const out = [];
  out.push(...det.observe('p', { count: 100, copyCount: 500, colorCopyCount: 40 }, at(0)));
  out.push(...det.observe('p', { count: 130, copyCount: 520, colorCopyCount: 45 }, at(1)));
  for (let m = 2; m < 15; m++) out.push(...det.observe('p', { count: 130, copyCount: 520, colorCopyCount: 45 }, at(m)));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'copy_counter');
  assert.deepStrictEqual([out[0].pages, out[0].color_pages, out[0].mono_pages], [20, 5, 15]);
  assert.strictEqual(out[0].confidence, 'high');
});

(async () => {
  // Full poller over real UDP against a fake printer.
  const life = '1.3.6.1.2.1.43.10.2.1.4.1.1';
  const fake = await startFakePrinter({
    '1.3.6.1.2.1.43.10.2.1.3.1.1': 7,              // counter unit: impressions
    [life]: { counter: 48000 },
    '1.3.6.1.2.1.25.3.5.1.1.1': 3,                 // idle
    '1.3.6.1.2.1.43.12.1.1.4.1.1': 'black'         // mono device
  });
  const queuePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'copies-')), 'q.json');
  const posted = [];
  const monitor = createCopyMonitor({
    config: { printerAddresses: { 'Office MFP': { host: '127.0.0.1', port: fake.port } }, copyPollSeconds: 60 },
    postJson: async (url, body) => { posted.push({ url, body }); return { ok: true, status: 200 }; },
    log: () => {},
    queuePath
  });
  await monitor.refreshTargets();
  // Job credits are stamped with the real clock; run the poller on it too.
  const now = Date.now();
  await monitor.pollOnce(now - MIN);
  monitor.jobPrinted({ printer_name: 'Office MFP', external_job_id: '1', pages: 3, copies: 1, submitted_at: new Date().toISOString(), completed_at: new Date().toISOString() });
  fake.table[life] = { counter: 48003 + 15 };      // the print job + 15 copied pages
  fake.table['1.3.6.1.2.1.25.3.5.1.1.1'] = 4;      // printing
  await monitor.pollOnce(now);
  fake.table['1.3.6.1.2.1.25.3.5.1.1.1'] = 3;
  for (let m = 1; m <= 12; m++) await monitor.pollOnce(now + m * MIN);
  fake.close();
  const events = posted.flatMap((p) => p.body.events);
  assert.strictEqual(posted[0].url, '/api/print-jobs/copies');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].printer_name, 'Office MFP');
  assert.strictEqual(events[0].address, '127.0.0.1');
  assert.strictEqual(events[0].pages, 15);
  assert.strictEqual(events[0].mono_pages, 15, 'black-only device => B&W copies');
  assert.strictEqual(events[0].confidence, 'high');
  assert.strictEqual(monitor.queue.length, 0);
  passed++;
  console.log('ok - poller over SNMP reports 15 copied pages and not the print job');
  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
