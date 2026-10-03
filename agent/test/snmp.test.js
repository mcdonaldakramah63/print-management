'use strict';
const assert = require('assert');
const { readPrinter, readDeviceStatus, encOid, decOid } = require('../snmp');
const { startFakePrinter } = require('./fakePrinter');

(async () => {
  for (const oid of ['1.3.6.1.2.1.43.11.1.1.9.1.1', '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.10.1.1.18.1.0', '1.3.300.16384.2097152']) {
    const buf = encOid(oid);
    assert.strictEqual(decOid(buf, 2, buf.length), oid);
  }
  const S = '1.3.6.1.2.1.43.11.1.1';
  const t = {
    '1.3.6.1.2.1.25.3.2.1.3.1': 'HP Color LaserJet MFP M479fdw',
    '1.3.6.1.2.1.43.10.2.1.4.1.1': { counter: 48213 },
    '1.3.6.1.2.1.43.12.1.1.4.1.1': 'black', '1.3.6.1.2.1.43.12.1.1.4.1.2': 'cyan',
    '1.3.6.1.2.1.43.12.1.1.4.1.3': 'magenta', '1.3.6.1.2.1.43.12.1.1.4.1.4': 'yellow'
  };
  const supplies = [
    [1, 3, 'Black Cartridge HP W2030X', 1, 100, 42], [2, 3, 'Cyan Cartridge HP W2031X', 2, 100, 7],
    [3, 3, 'Magenta Cartridge', 3, 100, -3], [4, 3, 'Yellow Cartridge', 4, 6000, 4800],
    [5, 9, 'Imaging Drum', 0, 100, 63], [6, 4, 'Toner Collection Unit', 0, 100, 90]
  ];
  for (const [i, type, desc, colorant, max, level] of supplies) {
    t[`${S}.3.1.${i}`] = colorant; t[`${S}.4.1.${i}`] = type === 4 ? 4 : 3; t[`${S}.5.1.${i}`] = type;
    t[`${S}.6.1.${i}`] = desc + '\0'; t[`${S}.8.1.${i}`] = max; t[`${S}.9.1.${i}`] = level;
  }
  const printer = await startFakePrinter(t);
  const r = await readPrinter('127.0.0.1', { port: printer.port, timeoutMs: 500 });
  printer.close();
  console.log(JSON.stringify(r, null, 1));
  assert.strictEqual(r.model, 'HP Color LaserJet MFP M479fdw');
  assert.strictEqual(r.life_count, 48213);
  assert.strictEqual(r.supplies.length, 6);
  const by = Object.fromEntries(r.supplies.map((s) => [s.description.split(' ')[0], s]));
  assert.strictEqual(by.Black.percent, 42); assert.strictEqual(by.Black.colorant, 'black');
  assert.strictEqual(by.Cyan.percent, 7);
  assert.strictEqual(by.Magenta.percent, null); assert.strictEqual(by.Magenta.some_remaining, true);
  assert.strictEqual(by.Yellow.percent, 80);
  assert.strictEqual(by.Imaging.kind, 'drum');
  assert.strictEqual(by.Toner.receptacle, true); assert.strictEqual(by.Toner.kind, 'waste_toner');
  // Front panel: status, error bits, screen text, trays, covers, alerts
  const panel = await startFakePrinter({
    '1.3.6.1.2.1.25.3.5.1.1.1': 3, '1.3.6.1.2.1.25.3.2.1.5.1': 3, '1.3.6.1.2.1.25.3.5.1.2.1': '\x40\x04',
    '1.3.6.1.2.1.43.16.5.1.2.1.1': 'Load Tray 1', '1.3.6.1.2.1.43.16.5.1.2.1.2': 'A4 Plain',
    '1.3.6.1.2.1.43.8.2.1.9.1.1': 250, '1.3.6.1.2.1.43.8.2.1.10.1.1': 0, '1.3.6.1.2.1.43.8.2.1.12.1.1': 'A4 Plain', '1.3.6.1.2.1.43.8.2.1.13.1.1': 'Tray 1',
    '1.3.6.1.2.1.43.8.2.1.9.1.2': 500, '1.3.6.1.2.1.43.8.2.1.10.1.2': -3, '1.3.6.1.2.1.43.8.2.1.13.1.2': 'Tray 2',
    '1.3.6.1.2.1.43.6.1.1.2.1.1': 'Front Door', '1.3.6.1.2.1.43.6.1.1.3.1.1': 4,
    '1.3.6.1.2.1.43.18.1.1.2.1.7': 4, '1.3.6.1.2.1.43.18.1.1.8.1.7': 'Tray 1 empty'
  });
  const st = await readDeviceStatus('127.0.0.1', { port: panel.port, timeoutMs: 500 });
  panel.close();
  assert.deepStrictEqual([st.status, st.device_status], ['idle', 'warning']);
  assert.deepStrictEqual(st.errors, ['no_paper', 'input_tray_empty']);
  assert.deepStrictEqual(st.display, ['Load Tray 1', 'A4 Plain']);
  assert.deepStrictEqual(st.trays.map((x) => [x.name, x.level, x.percent, x.empty]), [['Tray 1', 0, 0, true], ['Tray 2', -3, null, false]]);
  assert.deepStrictEqual(st.covers, [{ name: 'Front Door', status: 'closed' }]);
  assert.deepStrictEqual(st.alerts, [{ severity: 'warning', code: null, description: 'Tray 1 empty' }]);
  // Unreachable printer times out cleanly
  await assert.rejects(readPrinter('127.0.0.1', { port: 9, timeoutMs: 200, retries: 0 }));
  console.log('SNMP tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
