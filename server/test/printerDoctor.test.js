'use strict';
// Printer doctor: merging signals, stuck-queue detection, print-speed learning.
const assert = require('assert');
const { diagnose, learnSpeed } = require('../lib/printerDoctor');

const NOW = Date.UTC(2026, 9, 3, 10, 0, 0);
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const job = (id, document, printed, total, status = 'Printing', position = id) => ({ id, document, pages_printed: printed, total_pages: total, status, position });
const base = (over = {}) => ({ name: 'P', printer_status: 3, detected_error_state: 2, state: 'Normal', work_offline: false, jobs: [], ...over });
const fresh = { updated_at: ago(0.1), now: NOW };

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

test('idle printer is ready', () => {
  const d = diagnose(base(), fresh);
  assert.strictEqual(d.health, 'ready');
  assert.strictEqual(d.headline, 'Ready');
});

test('a jam reported by the printer and by Windows is one confirmed issue with a restart fix', () => {
  const d = diagnose(base({
    detected_error_state: 8, state: 'PaperJam', jobs: [job(4, 'Report.pdf', 3, 10)],
    device: { reachable: true, errors: ['jammed'], display: ['Jam in tray 2'], trays: [], covers: [{ name: 'Front door', status: 'open' }] }
  }), fresh);
  const jam = d.issues.find((i) => i.key === 'jammed');
  assert.ok(jam.confirmed);
  assert.deepStrictEqual(jam.sources.sort(), ['printer', 'windows']);
  assert.strictEqual(jam.fixes[0].action, 'restart_job');
  assert.deepStrictEqual(jam.fixes[0].params, { job_id: 4, document: 'Report.pdf' });
  assert.ok(jam.steps[0].includes('Front door'));
  assert.strictEqual(d.health, 'error');
  assert.strictEqual(d.queue[0].eta_min, null, 'no wait time while jammed');
});

test('stuck queue: first job unchanged for 4 minutes with nothing wrong', () => {
  const head = job(7, 'Big.pdf', 5, 40);
  const history = [6, 4, 3, 2, 1, 0.5].map((m) => ({ at: ago(m), jobs: [m === 6 ? job(7, 'Big.pdf', 2, 40) : head] }));
  const d = diagnose(base({ jobs: [head, job(8, 'Next.docx', 0, 2)] }), fresh, history);
  const stuck = d.issues.find((i) => i.key === 'queue_stuck');
  assert.ok(stuck, 'flagged');
  assert.ok(stuck.title.includes('4 min'));
  assert.deepStrictEqual(stuck.fixes.map((f) => f.action), ['restart_job', 'cancel_job']);
  assert.strictEqual(d.stalled_job_id, 7);
});

test('not stuck when the printer is paused (that is the issue instead)', () => {
  const head = job(7, 'Big.pdf', 5, 40);
  const history = [5, 3, 1].map((m) => ({ at: ago(m), jobs: [head] }));
  const d = diagnose(base({ state: 'Paused', jobs: [head] }), fresh, history);
  assert.ok(!d.issues.some((i) => i.key === 'queue_stuck'));
  assert.strictEqual(d.issues[0].fixes[0].action, 'resume_printer');
});

test('print speed is learned from the history and drives wait times', () => {
  const history = [];
  for (let k = 0; k <= 6; k++) history.push({ at: ago(3 - k * 0.5), jobs: [job(1, 'A.pdf', k * 15, 200)] });  // 15 pages / 30 s
  const s = learnSpeed(history);
  assert.deepStrictEqual([s.ppm, s.source], [30, 'learned']);
  const d = diagnose(base({ jobs: [job(1, 'A.pdf', 90, 200), job(2, 'B.pdf', 0, 60)] }), fresh, history);
  assert.deepStrictEqual(d.queue.map((j) => j.eta_min), [4, 6]);   // 110 pages, then 170, at 30 ppm
  assert.ok(d.headline.includes('about 6 min'));
});

test('a printer that stopped reporting is offline, with its last state kept', () => {
  const d = diagnose(base({ jobs: [job(1, 'A.pdf', 0, 2)] }), { updated_at: ago(5), now: NOW });
  assert.strictEqual(d.health, 'offline');
  assert.strictEqual(d.issues[0].key, 'agent_offline');
});

test('unreachable network printer with jobs waiting is critical; Windows "offline" folds into it', () => {
  const d = diagnose(base({ printer_status: 7, host: '10.0.0.9', jobs: [job(1, 'A.pdf', 0, 2)], device: { reachable: false } }), fresh);
  assert.strictEqual(d.issues[0].key, 'unreachable');
  assert.strictEqual(d.issues[0].severity, 'critical');
  assert.ok(!d.issues.some((i) => i.key === 'offline'));
});

test('one empty tray is a heads-up; all empty is out of paper', () => {
  const t = (name, level) => ({ name, level, max: 250, percent: Math.round(level / 2.5), empty: level === 0, media: 'A4' });
  let d = diagnose(base({ device: { reachable: true, errors: [], trays: [t('Tray 1', 0), t('Tray 2', 200)], covers: [] } }), fresh);
  assert.strictEqual(d.issues[0].key, 'tray_empty');
  d = diagnose(base({ jobs: [job(1, 'A.pdf', 0, 2)], device: { reachable: true, errors: [], trays: [t('Tray 1', 0), t('Tray 2', 0)], covers: [] } }), fresh);
  assert.strictEqual(d.issues[0].key, 'no_paper');
  assert.strictEqual(d.issues[0].severity, 'critical');
});

test('a held job offers release; an errored one restart/cancel', () => {
  const d = diagnose(base({ jobs: [job(1, 'A.pdf', 0, 2, 'Error, Printing'), job(2, 'B.pdf', 0, 1, 'Paused')] }), fresh);
  assert.deepStrictEqual(d.issues.find((i) => i.key === 'job_error:1').fixes.map((f) => f.action), ['restart_job', 'cancel_job']);
  assert.deepStrictEqual(d.issues.find((i) => i.key === 'job_paused:2').fixes.map((f) => f.action), ['resume_job', 'cancel_job']);
});

console.log(`\n${passed} passed`);
