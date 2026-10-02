'use strict';

/**
 * Count the pages of a source document without reading its content:
 *   - PDF: the page tree's /Count (also inside compressed object streams),
 *          falling back to counting /Type /Page objects.
 *   - DOCX / PPTX: the page / slide count Word and PowerPoint store in
 *          docProps/app.xml when the file is saved.
 *   - Images: 1.
 * Returns { pages, source } or null when the length can't be determined.
 * Only used when the agent's opt-in "inspectDocuments" setting is on.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);

function countDocumentPages(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return null;

  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') return pdfPages(fs.readFileSync(filePath));
    if (ext === '.docx' || ext === '.docm') return ooxmlCount(fs.readFileSync(filePath), 'Pages', 'docx');
    if (ext === '.pptx' || ext === '.pptm') return ooxmlCount(fs.readFileSync(filePath), 'Slides', 'pptx');
    if (IMAGE_EXTS.has(ext)) return { pages: 1, source: 'image' };
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------
// PDF
// ---------------------------------------------------------------
// A /Type /Pages dictionary with no nested << >> inside it.
const PAGES_DICT = /<<(?:(?!<<|>>)[\s\S]){0,4000}?\/Type\s*\/Pages\b(?:(?!<<|>>)[\s\S]){0,4000}?>>/g;

function maxPagesCount(text) {
  let max = 0;
  for (const m of text.matchAll(PAGES_DICT)) {
    const c = /\/Count\s+(\d+)/.exec(m[0]);
    if (c) max = Math.max(max, Number(c[1]));
  }
  return max;
}

function pdfPages(buffer) {
  if (buffer.subarray(0, 1024).indexOf('%PDF') === -1) return null;
  const text = buffer.toString('latin1');

  // The root of the page tree has the largest /Count.
  let max = maxPagesCount(text);
  if (max > 0) return { pages: max, source: 'pdf' };

  // PDF 1.5+ often hides the page tree inside compressed object streams.
  const objStm = /\/Type\s*\/ObjStm\b/g;
  let m;
  while ((m = objStm.exec(text))) {
    const streamAt = text.indexOf('stream', m.index);
    if (streamAt === -1) continue;
    let start = streamAt + 'stream'.length;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;
    try {
      const inflated = zlib.inflateSync(buffer.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
      max = Math.max(max, maxPagesCount(inflated));
    } catch { /* not Flate, or damaged: skip */ }
  }
  if (max > 0) return { pages: max, source: 'pdf' };

  const pageObjects = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  return pageObjects > 0 ? { pages: pageObjects, source: 'pdf' } : null;
}

// ---------------------------------------------------------------
// Office Open XML (.docx / .pptx): read docProps/app.xml from the zip
// ---------------------------------------------------------------
function readZipEntry(buffer, wanted) {
  // End of central directory record: scan backwards for its signature.
  const eocdMin = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= eocdMin; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return null;
  const entries = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries && p + 46 <= buffer.length; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function ooxmlCount(buffer, tag, source) {
  const xml = readZipEntry(buffer, 'docProps/app.xml');
  if (!xml) return null;
  const m = new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(xml.toString('utf8'));
  const pages = m ? Number(m[1]) : 0;
  return pages > 0 ? { pages, source } : null;
}

module.exports = { countDocumentPages, pdfPages, ooxmlCount };
