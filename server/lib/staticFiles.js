// ---------------------------------------------------------------
// Static files (the web app's pages, styles, scripts and fonts)
//
// Built for slow links (the phone app through the relay, a shop PC on a
// weak network):
//   * text files are gzipped once and kept in memory;
//   * pages link their CSS and JS with ?v=<content hash>, and those
//     versioned URLs are cached by the browser for a year, so after the
//     first visit a page load only revalidates the HTML; any change to a
//     file changes its hash, so nobody gets a stale script;
//   * everything else is revalidated with an ETag (a 304, no body); fonts
//     never change and are cached for 30 days.
// Files come from public/ on disk (re-read when they change) or from the
// assets embedded in the standalone .exe.
// ---------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);
const YEAR = 'public, max-age=31536000, immutable';

/**
 * source: { list(): string[] of relative paths, read(rel): Buffer, version(rel): string|number }
 * version() is a cheap change marker (mtime on disk); content is re-read when it changes.
 */
function createStatic(source) {
  const cache = new Map(); // rel -> { version, body, gzip, etag, type }

  function load(rel) {
    const version = source.version(rel);
    const hit = cache.get(rel);
    if (hit && hit.version === version) return hit;
    let body = source.read(rel);
    const ext = path.extname(rel);
    if (ext === '.html') body = Buffer.from(versionLinks(body.toString('utf8'), rel));
    const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
    const entry = {
      version,
      body,
      hash,
      etag: `"${hash}"`,
      type: TYPES[ext] || 'application/octet-stream',
      gzip: COMPRESSIBLE.has(ext) && body.length > 1024 ? zlib.gzipSync(body, { level: 9 }) : null
    };
    cache.set(rel, entry);
    return entry;
  }

  // css/x.css -> css/x.css?v=<hash of that file>, for local links in a page.
  // (Fonts keep their plain URL: style.css loads them by it, and a preload
  // under another URL would download them twice.)
  function versionLinks(html, rel) {
    const dir = path.posix.dirname(rel);
    return html.replace(/(href|src)="((?:css|js)\/[^"?#]+)"/g, (all, attr, link) => {
      const target = path.posix.normalize(path.posix.join(dir, link));
      if (!files().has(target)) return all;
      try { return `${attr}="${link}?v=${load(target).hash}"`; } catch { return all; }
    });
  }

  let fileSet = null;
  let listedAt = 0;
  function files() {
    // Re-list at most every few seconds (files can be added while developing).
    if (!fileSet || Date.now() - listedAt > 5000) { fileSet = new Set(source.list()); listedAt = Date.now(); }
    return fileSet;
  }

  return function serveStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch { return next(); }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some((p) => p === '..' || p.startsWith('.'))) return next();
    if (!files().has(rel)) return next();
    let f;
    try { f = load(rel); } catch { return next(); }

    const ext = path.extname(rel);
    res.setHeader('Content-Type', f.type);
    res.setHeader('ETag', f.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.query.v && req.query.v === f.hash) res.setHeader('Cache-Control', YEAR);
    else if (ext === '.woff2') res.setHeader('Cache-Control', 'public, max-age=2592000');
    else res.setHeader('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === f.etag) { res.statusCode = 304; return res.end(); }

    const gzip = f.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const body = gzip ? f.gzip : f.body;
    if (gzip) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

function diskSource(root) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  return {
    list: () => walk(root).map((f) => path.relative(root, f).split(path.sep).join('/')),
    read: (rel) => fs.readFileSync(path.join(root, rel)),
    version: (rel) => fs.statSync(path.join(root, rel)).mtimeMs
  };
}

function seaSource() {
  const sea = require('node:sea');
  const list = JSON.parse(sea.getAsset('public-manifest.json', 'utf8'));
  return {
    list: () => list,
    read: (rel) => Buffer.from(sea.getAsset(`public/${rel}`)),
    version: () => 1
  };
}

/**
 * Gzip JSON (and CSV) API answers over 1 KB for clients that accept it:
 * a report or the print log shrinks 5-10x, which is what makes the phone
 * app quick over a mobile network.
 */
function compressResponses(req, res, next) {
  if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();
  const send = res.send.bind(res);
  res.send = (body) => {
    if ((typeof body === 'string' || Buffer.isBuffer(body)) && !res.get('Content-Encoding') && Buffer.byteLength(body) > 1024
      && /json|csv|text/.test(String(res.get('Content-Type') || ''))) {
      res.set('Content-Encoding', 'gzip');
      res.append('Vary', 'Accept-Encoding');
      return send(zlib.gzipSync(body, { level: 6 }));
    }
    return send(body);
  };
  next();
}

module.exports = { createStatic, diskSource, seaSource, compressResponses };
