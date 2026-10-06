'use strict';
// On real Windows (CI): the PowerShell host traces printers to their devices
// and the USB counter reader compiles and answers. Skipped elsewhere.
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { PowerShellHost } = require('../printerControl');

if (process.platform !== 'win32') {
  console.log('skip - Windows only (printer discovery through PowerShell)');
  process.exit(0);
}

const PRINTER = 'Copy Detection Test Printer';
const PORT = 'IP_10.123.45.67';
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' });

(async () => {
  // A printer on a Standard TCP/IP port, using any driver Windows has.
  let added = false;
  try {
    ps(`$ErrorActionPreference='Stop'
      $driver = (Get-PrinterDriver | Select-Object -First 1).Name
      if (-not $driver) { throw 'no printer driver installed' }
      if (-not (Get-PrinterPort -Name '${PORT}' -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name '${PORT}' -PrinterHostAddress '10.123.45.67' }
      if (-not (Get-Printer -Name '${PRINTER}' -ErrorAction SilentlyContinue)) { Add-Printer -Name '${PRINTER}' -DriverName $driver -PortName '${PORT}' }`);
    added = true;
  } catch (err) {
    console.log(`note - could not add a test printer (${err.message.split('\n')[0]}); checking discovery only`);
  }

  const host = new PowerShellHost({ scriptPath: path.join(__dirname, '..', 'printer-control.ps1'), log: (m) => console.log(m) });
  let passed = 0;
  try {
    const devices = await host.request('devices', null, { fresh: true }, 180000);
    assert.ok(Array.isArray(devices), 'devices answers a list');
    for (const d of devices) assert.ok(d.name && d.kind, `every device has a name and kind: ${JSON.stringify(d)}`);
    console.log(devices.map((d) => `  ${d.name} [${d.port}] -> ${d.kind}${d.host ? ` ${d.host}` : ''}${d.usb_path ? ` ${d.usb_path}` : ''}${d.note ? ` (${d.note})` : ''}`).join('\n'));
    if (added) {
      const t = devices.find((d) => d.name === PRINTER);
      assert.ok(t, 'the test printer is listed');
      assert.strictEqual(t.kind, 'tcpip');
      assert.strictEqual(t.host, '10.123.45.67');
    }
    for (const d of devices.filter((x) => /Print to PDF|XPS|OneNote/i.test(x.name))) assert.strictEqual(d.kind, 'virtual', `${d.name} is virtual`);
    passed++;
    console.log('ok - printers traced to their devices');

    // Compiles the USB reader; a device that isn't there answers "not connected".
    await assert.rejects(
      host.request('usb_counter', null, { path: '\\\\?\\USB#VID_0000&PID_0000#NOPE#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}', port: '' }, 60000),
      /not connected|can't open/
    );
    passed++;
    console.log('ok - USB counter reader compiles and reports a missing device');

    const snap = await host.request('snapshot', null, {}, 60000);
    if (added) assert.strictEqual(snap.find((p) => p.name === PRINTER).host, '10.123.45.67');
    passed++;
    console.log('ok - printer panel snapshot still works');
  } finally {
    host.stop();
    if (added) {
      try { ps(`Remove-Printer -Name '${PRINTER}' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; Remove-PrinterPort -Name '${PORT}' -ErrorAction SilentlyContinue`); } catch { /* best effort */ }
    }
  }
  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
