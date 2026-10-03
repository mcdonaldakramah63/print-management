#!/usr/bin/env node
'use strict';

/**
 * Builds the standalone apps as Node single-executable applications (SEA):
 *
 *   dist/ReceiptSystem-<target>/
 *     ReceiptSystem.exe        the whole system: server + web pages + database
 *     PrintMonitorAgent.exe    the print agent for printer PCs
 *     agent-config.example.json, .env.example, README.txt
 *   dist/ReceiptSystem-<target>.zip
 *
 * Usage:  node scripts/build-exe.js [--target win-x64|linux-x64]
 *
 * Works on Windows (uses the running node.exe) and cross-builds from Linux
 * or macOS (downloads the matching Windows Node runtime from nodejs.org).
 * The executable must be the exact Node version that builds the blob, so
 * the version is always taken from the Node running this script.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const args = process.argv.slice(2);
const targetArg = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'win-x64';
const [targetOs, targetArch] = targetArg.split('-');
const hostTarget = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const exe = (name) => (targetOs === 'win' ? `${name}.exe` : name);
const log = (msg) => console.log(`[build] ${msg}`);

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// ---------------------------------------------------------------
// Node runtime for the target
// ---------------------------------------------------------------
function download(url, file) {
  log(`Downloading ${url}`);
  // curl honours the system proxy settings; Node's fetch doesn't.
  const r = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', file, url], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Download failed: ${url}`);
}

/** Extract one file from a zip (central directory lookup, deflate or stored). */
function unzipEntry(zipFile, wantedSuffix) {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name.endsWith(wantedSuffix)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wantedSuffix} not found in ${zipFile}`);
}

function nodeBinary() {
  if (targetArg === hostTarget) return process.execPath;
  if (targetOs !== 'win') throw new Error(`Cross-building ${targetArg} isn't supported; build it on that platform.`);
  const v = process.version;
  const cacheDir = path.join(BUILD, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const exePath = path.join(cacheDir, `node-${v}-win-${targetArch}.exe`);
  if (!fs.existsSync(exePath)) {
    const zip = path.join(cacheDir, `node-${v}-win-${targetArch}.zip`);
    if (!fs.existsSync(zip)) download(`https://nodejs.org/dist/${v}/node-${v}-win-${targetArch}.zip`, zip);
    fs.writeFileSync(exePath, unzipEntry(zip, '/node.exe'));
  }
  return exePath;
}

// ---------------------------------------------------------------
// Bundle, blob, inject
// ---------------------------------------------------------------
function bundle(entry, outfile) {
  require('esbuild').buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['better-sqlite3'], // the exe uses the built-in node:sqlite
    logLevel: 'error'
  });
}

function makeBlob(name, main, assets) {
  const config = path.join(BUILD, `${name}.sea.json`);
  const blob = path.join(BUILD, `${name}.blob`);
  fs.writeFileSync(config, JSON.stringify({
    main,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false, // keeps the blob portable across operating systems
    assets
  }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', config], { cwd: ROOT, stdio: 'inherit' });
  return blob;
}

async function inject(base, out, blob) {
  fs.copyFileSync(base, out);
  fs.chmodSync(out, 0o755);
  const { inject: postject } = require('postject');
  await postject(out, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: FUSE,
    machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined
  });
}

// ---------------------------------------------------------------
// Zip the result (deflate, standard PKZIP layout)
// ---------------------------------------------------------------
function zipDir(dir, zipFile) {
  const files = walk(dir);
  const parts = [];
  const central = [];
  let offset = 0;
  const base = path.basename(dir);
  for (const file of files) {
    const name = Buffer.from(`${base}/${path.relative(dir, file).split(path.sep).join('/')}`);
    const data = fs.readFileSync(file);
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipFile, Buffer.concat([...parts, cdBuf, end]));
}

const README = `Receipt System — Windows app
============================

1. Start ReceiptSystem.exe (double-click). A console window opens and your
   browser opens at http://localhost:3000. Keep the window open while you work.
   Windows may show a SmartScreen warning the first time: choose
   "More info" > "Run anyway" (the app isn't code-signed).
2. Sign in with admin / admin123 and change the password straight away
   (My account). Your data is kept in the "data" folder next to the .exe:
   back that folder up.
3. Other PCs, tablets and phones on the same network can use the address the
   console window prints (http://<this PC's IP>:3000). Allow ReceiptSystem
   through Windows Firewall on private networks when asked.

Optional settings: copy .env.example to .env next to the .exe (e.g. PORT).

Print monitoring (on each PC that has a printer)
------------------------------------------------
1. In the app: Print monitor > Register agent, copy the key.
2. Copy PrintMonitorAgent.exe and agent-config.example.json to that PC,
   rename the example to config.json, set "backendUrl" (the address above)
   and "agentApiKey".
3. Run PrintMonitorAgent.exe (or add it to Task Scheduler "At log on").
   Network printers with SNMP enabled also report their toner levels and
   photocopies (from the printer's own page counter).
`;

function checkNode() {
  // The exe embeds this Node; it must have SEA assets and unflagged node:sqlite.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node ${process.version} is too old to build the apps. Install Node.js 22.13 or newer (LTS) and try again.`);
  }
}

async function main() {
  checkNode();
  const name = `ReceiptSystem-${targetArg}`;
  const out = path.join(DIST, name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });

  log(`Target ${targetArg}, Node ${process.version}`);
  const base = nodeBinary();

  // Server: bundle + embed every file under public/
  bundle(path.join(ROOT, 'server/server.js'), path.join(BUILD, 'server.cjs'));
  const publicFiles = walk(path.join(ROOT, 'public')).map((f) => rel(f));
  const manifest = path.join(BUILD, 'public-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify(publicFiles.map((f) => f.replace(/^public\//, ''))));
  const serverAssets = { 'public-manifest.json': rel(manifest) };
  for (const f of publicFiles) serverAssets[f] = f;
  const serverBlob = makeBlob('server', 'build/server.cjs', serverAssets);
  await inject(base, path.join(out, exe('ReceiptSystem')), serverBlob);
  log(`Built ${exe('ReceiptSystem')}`);

  // Agent: bundle + embed the PowerShell watcher
  bundle(path.join(ROOT, 'agent/agent.js'), path.join(BUILD, 'agent.cjs'));
  const agentBlob = makeBlob('agent', 'build/agent.cjs', { 'watch-print-jobs.ps1': 'agent/watch-print-jobs.ps1' });
  await inject(base, path.join(out, exe('PrintMonitorAgent')), agentBlob);
  log(`Built ${exe('PrintMonitorAgent')}`);

  fs.copyFileSync(path.join(ROOT, 'agent/config.example.json'), path.join(out, 'agent-config.example.json'));
  fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(out, '.env.example'));
  fs.writeFileSync(path.join(out, 'README.txt'), README.replace(/\n/g, targetOs === 'win' ? '\r\n' : '\n'));

  zipDir(out, path.join(DIST, `${name}.zip`));
  const size = (f) => `${(fs.statSync(f).size / 1048576).toFixed(1)} MB`;
  log(`Done: dist/${name}/ and dist/${name}.zip (${size(path.join(DIST, `${name}.zip`))})`);
}

main().catch((err) => {
  console.error(`[build] ${err.message}`);
  process.exit(1);
});
