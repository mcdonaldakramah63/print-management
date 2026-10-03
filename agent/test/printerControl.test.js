'use strict';
// Printer control on the agent: the PowerShell host's supervision and the
// at-most-once command journal, with fake processes instead of Windows.
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PowerShellHost, createPrinterControl } = require('../printerControl');

function fakeSpawn(behaviour) {
  const spawned = [];
  const fn = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('exit', 1)); };
    let buf = '';
    proc.stdin.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        behaviour(req, (reply) => proc.stdout.write(`${JSON.stringify({ id: req.id, ...reply })}\n`), proc);
      }
    });
    spawned.push(proc);
    return proc;
  };
  fn.spawned = spawned;
  return fn;
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

(async () => {
  await test('host answers requests over JSON lines and reports errors', async () => {
    const spawnFn = fakeSpawn((req, reply) => (req.action === 'boom' ? reply({ ok: false, error: 'Access denied' }) : reply({ ok: true, data: { action: req.action, printer: req.printer } })));
    const host = new PowerShellHost({ scriptPath: 'x.ps1', log: () => {}, spawnFn });
    assert.deepStrictEqual(await host.request('pause_printer', 'P', {}), { action: 'pause_printer', printer: 'P' });
    await assert.rejects(host.request('boom', 'P', {}), /Access denied/);
    assert.strictEqual(spawnFn.spawned.length, 1, 'one long-running process');
  });

  await test('a wedged host is killed on timeout and replaced', async () => {
    let n = 0;
    const spawnFn = fakeSpawn((req, reply) => { if (n++ > 0) reply({ ok: true, data: 'fine' }); });
    const host = new PowerShellHost({ scriptPath: 'x.ps1', log: () => {}, spawnFn });
    await assert.rejects(host.request('snapshot', null, {}, 50), /did not answer/);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(spawnFn.spawned[0].killed);
    host.restartAt = 0; // skip the restart pause
    assert.strictEqual(await host.request('snapshot', null, {}), 'fine');
    assert.strictEqual(spawnFn.spawned.length, 2);
  });

  await test('a crash fails the requests in flight instead of hanging', async () => {
    const spawnFn = fakeSpawn((req, reply, proc) => proc.emit('exit', 3));
    const host = new PowerShellHost({ scriptPath: 'x.ps1', log: () => {}, spawnFn });
    await assert.rejects(host.request('snapshot', null, {}), /stopped \(code 3\)/);
  });

  await test('sync: commands run once, results re-sent until acknowledged, interval follows watchers', async () => {
    const calls = [];
    const executor = { request: async (action) => { calls.push(action); return action === 'snapshot' ? [{ name: 'P', jobs: [] }] : { done: true }; } };
    const posted = [];
    let replies = [
      { commands: [{ id: 5, action: 'test_page', printer: 'P', params: {}, expires_in_ms: 60000 }], acked: [], watch: true },
      { commands: [{ id: 5, action: 'test_page', printer: 'P', params: {}, expires_in_ms: 60000 }], acked: [], watch: true }, // redelivered
      { commands: [], acked: [5], watch: false },
      { commands: [], acked: [], watch: false }
    ];
    const postJson = async (url, body) => { posted.push(body); return { ok: true, status: 200, body: replies.shift() }; };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
    const ctl = createPrinterControl({ config: {}, postJson, log: () => {}, executor, journalPath: path.join(dir, 'j.json'), readDevice: async () => ({ reachable: true }) });
    await ctl.syncOnce(); assert.ok(ctl.watching);
    await ctl.syncOnce();
    await ctl.syncOnce(); assert.ok(!ctl.watching);
    await ctl.syncOnce();
    assert.deepStrictEqual(calls.filter((c) => c !== 'snapshot'), ['test_page'], 'ran once despite redelivery');
    assert.deepStrictEqual(posted.map((b) => b.results.map((r) => r.id)), [[], [5], [5], []], 'result re-sent until acked');
    assert.strictEqual(posted[0].snapshot.printers[0].name, 'P');
    // The journal survives a restart: a late redelivery is still not re-run.
    const again = createPrinterControl({ config: {}, postJson, log: () => {}, executor, journalPath: path.join(dir, 'j.json') });
    await again.runCommand({ id: 5, action: 'test_page', printer: 'P', params: {} }, Date.now());
    assert.strictEqual(calls.filter((c) => c === 'test_page').length, 1);
  });

  await test('snapshot attaches the device panel only for printers with a network address', async () => {
    const executor = { request: async () => [{ name: 'Net', host: '10.0.0.5', jobs: null }, { name: 'USB', host: '', jobs: [] }] };
    const seen = [];
    const ctl = createPrinterControl({ config: { printerAddresses: { USB: '10.0.0.7' } }, postJson: async () => ({ ok: true, body: {} }), log: () => {}, executor,
      journalPath: path.join(os.tmpdir(), `ctl-${process.pid}.json`), readDevice: async (host) => { seen.push(host); return { reachable: true, host }; } });
    const snap = await ctl.snapshot();
    assert.deepStrictEqual(seen, ['10.0.0.5', '10.0.0.7']);
    assert.deepStrictEqual(snap.printers[0].jobs, []);
    assert.strictEqual(snap.printers[1].device.host, '10.0.0.7');
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
