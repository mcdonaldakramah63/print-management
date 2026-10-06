'use strict';
// Photocopy detection beyond Standard TCP/IP network printers: USB printers
// read through the cable (PJL), WSD / IPP / shared printers traced to their
// address, and a clear reason for any printer that can't be watched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePjl, parseDeviceId, createDeviceMap } = require('../devices');
const { createCopyMonitor } = require('../copyMonitor');
const { startFakePrinter } = require('./fakePrinter');

const MIN = 60 * 1000;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

test('PJL replies: page count in both styles, printing vs ready', () => {
  const r = parsePjl('@PJL INFO PAGECOUNT\r\n48213\r\n\f@PJL INFO STATUS\r\nCODE=10023\r\nDISPLAY="Printing"\r\nONLINE=TRUE\r\n\f');
  assert.deepStrictEqual([r.count, r.status], [48213, 'printing']);
  const k = parsePjl('@PJL INFO PAGECOUNT\r\nPAGECOUNT=901\r\n\f@PJL INFO STATUS\r\nCODE=10001\r\nDISPLAY="Ready to print"\r\n\f');
  assert.deepStrictEqual([k.count, k.status], [901, 'idle'], '"Ready to print" is not printing');
  assert.strictEqual(parsePjl('').count, null);
  assert.strictEqual(parsePjl('@PJL INFO PAGECOUNT\r\n?\r\n\f').count, null);
});

test('IEEE 1284 device ID: long and short keys', () => {
  const id = parseDeviceId('MANUFACTURER:Brother;COMMAND SET:PJL,PCL,PCLXL;MODEL:DCP-L2540DW;SN:E7*123;');
  assert.deepStrictEqual([id.MFG, id.MDL, id.CMD, id.SN], ['Brother', 'DCP-L2540DW', 'PJL,PCL,PCLXL', 'E7*123']);
});

(async () => {
  // Device map: Windows' list, overridden and completed by config.json.
  const fakeHost = { alwaysAvailable: true, calls: 0, async request(action) { this.calls++; assert.strictEqual(action, 'devices'); return [
    { name: 'Front MFP', port: 'WSD-1234', kind: 'wsd', host: '192.168.1.40' },
    { name: 'Back Laser', port: 'WSD-9999', kind: 'wsd', host: null },
    { name: 'Microsoft Print to PDF', port: 'PORTPROMPT:', kind: 'virtual' }
  ]; } };
  const map = createDeviceMap({ host: fakeHost, config: { printerAddresses: { 'Back Laser': '192.168.1.41', 'Old Copier': { host: '10.0.0.9', community: 'shop' } } } });
  const list = await map.list();
  const byName = Object.fromEntries(list.map((d) => [d.name, d]));
  assert.strictEqual(byName['Front MFP'].host, '192.168.1.40');
  assert.strictEqual(byName['Back Laser'].host, '192.168.1.41', 'config fills in a WSD printer Windows could not trace');
  assert.strictEqual(byName['Old Copier'].community, 'shop');
  assert.deepStrictEqual(await map.addresses(), {
    'Front MFP': { host: '192.168.1.40', community: null },
    'Back Laser': { host: '192.168.1.41', community: null },
    'Old Copier': { host: '10.0.0.9', community: 'shop' }
  });
  await map.list();
  assert.strictEqual(fakeHost.calls, 1, 'the device list is cached');
  passed++;
  console.log('ok - device map: WSD addresses from Windows, gaps and overrides from config.json');

  // A WSD network printer (SNMP), a USB laser (PJL), a USB inkjet (no PJL),
  // a printer shared from a PC where it's on USB, and a PDF printer.
  const life = '1.3.6.1.2.1.43.10.2.1.4.1.1';
  const fake = await startFakePrinter({
    '1.3.6.1.2.1.43.10.2.1.3.1.1': 7,
    [life]: { counter: 5000 },
    '1.3.6.1.2.1.25.3.5.1.1.1': 3,
    '1.3.6.1.2.1.43.12.1.1.4.1.1': 'black'
  });
  const usb = {
    count: 20000,
    code: 10001,
    busy: false,
    reads: 0,
    async request(action, printer, params) {
      assert.strictEqual(action, 'usb_counter');
      if (params.path.includes('INKJET')) return { device_id: 'MFG:EPSON;MDL:L3250 Series;CMD:ESCPL2,BDC,D4,D4PX,ESCPR7;', pjl: false };
      if (this.busy) return { busy: true };
      this.reads++;
      return { device_id: 'MFG:HP;MDL:LaserJet MFP M28w;CMD:PJL,PCLm,PWGRaster;SN:VNC123;', pjl: true,
        reply: `@PJL INFO PAGECOUNT\r\n${this.count}\r\n\f@PJL INFO STATUS\r\nCODE=${this.code}\r\n\f` };
    }
  };
  const devices = [
    { name: 'Front MFP', port: 'WSD-1234', kind: 'wsd', host: '127.0.0.1', snmp_port: fake.port },
    { name: 'Counter Laser', port: 'USB001', kind: 'usb', usb_path: '\\\\?\\USB#VID_03F0&PID_LASER#VNC123#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}', color_capable: false },
    { name: 'EPSON L3250', port: 'USB002', kind: 'usb', usb_path: '\\\\?\\USB#VID_04B8&PID_INKJET#X#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}', color_capable: true },
    { name: '\\\\OFFICE-PC\\Canon', port: 'USB001', kind: 'shared', server: 'OFFICE-PC', note: 'usb_on_server' },
    { name: 'Microsoft Print to PDF', port: 'PORTPROMPT:', kind: 'virtual' }
  ];
  const posted = [];
  const monitor = createCopyMonitor({
    config: { copyPollSeconds: 60 },
    postJson: async (url, body) => { posted.push({ url, body }); return { ok: true, status: 200 }; },
    log: () => {},
    queuePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'copies-')), 'q.json'),
    listDevices: async () => devices,
    usbHost: usb
  });
  await monitor.refreshTargets();
  const now = Date.now();
  await monitor.pollOnce(now - MIN);

  // A print job to the USB laser is spooling: the cable is left alone.
  monitor.jobSpooling({ printer_name: 'Counter Laser', external_job_id: '7' });
  const before = usb.reads;
  await monitor.pollOnce(now - MIN / 2);
  assert.strictEqual(usb.reads, before, 'no USB read while a job is on its way');
  monitor.jobPrinted({ printer_name: 'Counter Laser', external_job_id: '7', pages: 2, copies: 1, submitted_at: new Date(now - MIN).toISOString(), completed_at: new Date(now - MIN / 2).toISOString() });

  // 2 printed pages + 9 photocopied, the printer saying "printing".
  usb.count += 2 + 9;
  usb.code = 10023;
  fake.table[life] = { counter: 5000 + 4 };   // 4 copies on the network MFP
  await monitor.pollOnce(now);
  usb.code = 10001;
  usb.busy = true;                            // the spooler holds it for one poll
  await monitor.pollOnce(now + MIN);
  usb.busy = false;
  for (let m = 2; m <= 12; m++) await monitor.pollOnce(now + m * MIN);

  const events = posted.filter((p) => p.url === '/api/print-jobs/copies').flatMap((p) => p.body.events);
  const usbEvent = events.find((e) => e.printer_name === 'Counter Laser');
  const netEvent = events.find((e) => e.printer_name === 'Front MFP');
  assert.ok(usbEvent, 'USB photocopies detected');
  assert.strictEqual(usbEvent.pages, 9, 'the printed job is not counted as copies');
  assert.strictEqual(usbEvent.mono_pages, 9, 'driver without colour => B&W copies');
  assert.strictEqual(usbEvent.confidence, 'high', 'the printer said "printing" with nothing owed');
  assert.match(usbEvent.address, /^usb:.+:VNC123$/, 'USB devices get a stable address from their serial');
  assert.ok(netEvent && netEvent.pages === 4, 'WSD network printer detected over SNMP');
  passed++;
  console.log('ok - USB laser read through the cable: 9 copies, the printed job left out; WSD printer over SNMP');

  const cov = Object.fromEntries(posted.filter((p) => p.url === '/api/print-jobs/copy-coverage').pop().body.printers.map((c) => [c.printer_name, c]));
  assert.deepStrictEqual([cov['Front MFP'].method, cov['Front MFP'].state], ['snmp', 'ok']);
  assert.deepStrictEqual([cov['Counter Laser'].method, cov['Counter Laser'].state], ['usb', 'ok']);
  assert.match(cov['Counter Laser'].detail, /LaserJet MFP M28w/);
  assert.deepStrictEqual([cov['EPSON L3250'].method, cov['EPSON L3250'].state], ['none', 'unsupported']);
  assert.match(cov['EPSON L3250'].detail, /L3250.*network/);
  assert.match(cov['\\\\OFFICE-PC\\Canon'].detail, /Run the print agent on \\\\OFFICE-PC/);
  assert.ok(!cov['Microsoft Print to PDF'], 'virtual printers are left out');
  passed++;
  console.log('ok - each printer reports how it is watched, or why it can\'t be');

  // Nothing printed or copied for half an hour: the USB printer is asked
  // every 5 minutes, so it can sleep; activity brings back every minute.
  const r0 = usb.reads;
  for (let m = 13; m <= 42; m++) await monitor.pollOnce(now + m * MIN);
  const quietReads = usb.reads - r0;
  const r1 = usb.reads;
  for (let m = 43; m <= 72; m++) await monitor.pollOnce(now + m * MIN);
  assert.ok(usb.reads - r1 <= 7, `about every 5 minutes once quiet (${usb.reads - r1} reads in 30 min)`);
  assert.ok(quietReads >= 15, 'every minute while recently active');
  usb.count += 3;
  await monitor.pollOnce(now + 77 * MIN);
  const r2 = usb.reads;
  await monitor.pollOnce(now + 78 * MIN);
  assert.strictEqual(usb.reads - r2, 1, 'back to every minute after a change');
  fake.close();
  passed++;
  console.log('ok - a quiet USB printer is asked every 5 minutes, so it can sleep');

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
