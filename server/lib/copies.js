// ---------------------------------------------------------------
// Photocopies detected by the print agents (agent/copyMonitor.js finds
// page-counter growth that no spooled job explains).
//
// On arrival each event is checked against what the other agents saw, since
// one network printer is often shared by several PCs:
//   * Another agent printed to the same device (matched by IP address) in
//     the same window: those pages are print jobs this agent couldn't see,
//     so they're taken off the event (and it's dismissed if nothing is left).
//   * Another agent already reported the same copy run (overlapping window,
//     similar size): kept as a duplicate, never counted twice.
// ---------------------------------------------------------------
const db = require('../db');

const STATUSES = ['open', 'billed', 'dismissed', 'duplicate'];
const parse = (s) => { try { return JSON.parse(s); } catch (_) { return []; } };
const int = (v, max = 100000) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : 0);

function validTime(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v.slice(0, 40) : null;
}

// Pages other PCs printed to this device while the copy run was detected.
// Their spooler finishes up to 15 minutes before the paper comes out.
const otherAgentPages = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN ? = 'sheets' THEN COALESCE(pj.sheets, pj.impressions, pj.pages) ELSE COALESCE(pj.impressions, pj.pages) END), 0) AS pages
  FROM print_jobs pj
  WHERE pj.agent_id != ?
    AND EXISTS (SELECT 1 FROM device_counters dc WHERE dc.agent_id = pj.agent_id AND dc.printer_name = pj.printer_name AND dc.address = ?)
    AND julianday(COALESCE(pj.completed_at, pj.submitted_at)) BETWEEN julianday(?, '-15 minutes') AND julianday(?, '+5 minutes')
`);

const overlapping = db.prepare(`
  SELECT id, pages, detected_pages FROM copy_events
  WHERE address = ? AND agent_id != ? AND status != 'duplicate'
    AND julianday(started_at) <= julianday(?, '+2 minutes') AND julianday(ended_at) >= julianday(?, '-2 minutes')
  ORDER BY id LIMIT 1
`);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO copy_events (
    agent_id, event_key, printer_name, address, started_at, ended_at, detected_pages, pages,
    color_pages, mono_pages, unknown_pages, unit, source, confidence, evidence, status, duplicate_of, note
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Store a batch of copy runs from one agent. Returns { inserted, duplicates, explained }. */
function ingestCopyEvents(agentId, events) {
  const result = { inserted: 0, duplicates: 0, explained: 0 };
  db.transaction(() => {
    for (const e of Array.isArray(events) ? events.slice(0, 200) : []) {
      if (!e || !e.printer_name || !e.event_key) continue;
      const started = validTime(e.started_at);
      const ended = validTime(e.ended_at) || started;
      const detected = int(e.pages);
      if (!started || detected <= 0) continue;
      const unit = e.unit === 'sheets' ? 'sheets' : 'impressions';
      const address = String(e.address || '').slice(0, 100);
      let parts = { color: int(e.color_pages), mono: int(e.mono_pages), unknown: int(e.unknown_pages) };
      if (parts.color + parts.mono + parts.unknown !== detected) parts = { color: 0, mono: 0, unknown: detected };
      const evidence = Array.isArray(e.evidence) ? e.evidence.map((x) => String(x).slice(0, 40)).slice(0, 10) : [];
      let status = 'open';
      let duplicateOf = null;
      let note = '';
      let pages = detected;

      if (address) {
        const other = otherAgentPages.get(unit, agentId, address, started, ended).pages;
        if (other > 0) {
          const taken = Math.min(other, pages);
          pages -= taken;
          // Take explained pages from the least certain colour first.
          let left = taken;
          for (const k of ['unknown', 'mono', 'color']) { const t = Math.min(left, parts[k]); parts[k] -= t; left -= t; }
          evidence.push('other_pc_jobs');
          result.explained += taken;
          if (pages === 0) { status = 'dismissed'; note = 'Printed from another PC'; }
        }
        const dup = status === 'open' && overlapping.get(address, agentId, ended, started);
        if (dup && Math.abs(dup.pages - pages) <= Math.max(2, 0.25 * Math.max(dup.pages, pages))) {
          status = 'duplicate';
          duplicateOf = dup.id;
          note = 'Also reported by another agent';
        }
      }

      const confidence = ['high', 'medium', 'low'].includes(e.confidence) ? e.confidence : 'medium';
      const info = insertEvent.run(agentId, String(e.event_key).slice(0, 64), String(e.printer_name).slice(0, 200), address,
        started, ended, detected, pages, parts.color, parts.mono, parts.unknown, unit,
        e.source === 'copy_counter' ? 'copy_counter' : 'counter_gap', confidence, JSON.stringify(evidence), status, duplicateOf, note);
      if (info.changes) {
        result.inserted++;
        if (status === 'duplicate') result.duplicates++;
      }
    }
  })();
  return result;
}

const SELECT = `
  SELECT ce.*, a.label AS agent_label, s.receipt_no, u.full_name AS reviewed_by_name
  FROM copy_events ce
  JOIN agents a ON a.id = ce.agent_id
  LEFT JOIN sales s ON s.id = ce.sale_id
  LEFT JOIN users u ON u.id = ce.reviewed_by
`;

function shape(row) {
  return row && { ...row, evidence: parse(row.evidence) };
}

function listCopies(date, status) {
  const params = [date];
  let sql = `${SELECT} WHERE substr(ce.started_at, 1, 10) = ?`;
  if (STATUSES.includes(status)) { sql += ' AND ce.status = ?'; params.push(status); }
  sql += ' ORDER BY ce.started_at DESC LIMIT 300';
  return db.prepare(sql).all(...params).map(shape);
}

function getCopy(id) {
  return shape(db.prepare(`${SELECT} WHERE ce.id = ?`).get(id));
}

/**
 * Cart lines for a copy run: a photocopy service of the right colour,
 * one-sided, else the matching print service. Copies of unknown colour
 * (colour device, no copy counter) are suggested as B&W, flagged.
 */
function suggestCopyLines(event) {
  const services = db.prepare(`
    SELECT id, name, price, print_color_mode, print_kind, print_sides FROM products
    WHERE active = 1 AND print_color_mode IS NOT NULL ORDER BY price ASC, id ASC
  `).all();
  const pick = (mode) => {
    const oneSided = services.filter((p) => p.print_color_mode === mode && p.print_sides === 1);
    return oneSided.find((p) => p.print_kind === 'copy') || oneSided.find((p) => !/\b(A3|A5|Letter|Legal)\b/i.test(p.name)) || oneSided[0];
  };
  const lines = new Map();
  const unmatched = [];
  const add = (mode, pages, note) => {
    if (pages <= 0) return;
    const product = pick(mode);
    if (!product) { unmatched.push({ reason: 'no_product', color_mode: mode, pages }); return; }
    const line = lines.get(product.id) || { product_id: product.id, name: product.name, unit_price: product.price, qty: 0 };
    line.qty += pages;
    if (note) line.note = note;
    lines.set(product.id, line);
  };
  add('color', event.color_pages);
  add('mono', event.mono_pages);
  add('mono', event.unknown_pages, 'colour_unknown');
  return { lines: [...lines.values()], unmatched };
}

/** Recent copy runs waiting at the till, with suggested lines. */
function openCopies(hours) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return db.prepare(`${SELECT} WHERE ce.status = 'open' AND ce.pages > 0 AND julianday(ce.ended_at) >= julianday(?) ORDER BY ce.ended_at DESC LIMIT 30`)
    .all(since).map(shape).map((e) => ({ ...e, suggestion: suggestCopyLines(e) }));
}

/**
 * Copied pages per local day and colour, for printed-vs-sold. Unsure runs
 * (a single page, or likely a late print job) count only once billed.
 */
function copyPagesByDay(from, to) {
  return db.prepare(`
    SELECT substr(started_at, 1, 10) AS day,
      COALESCE(SUM(color_pages), 0) AS color, COALESCE(SUM(mono_pages), 0) AS mono, COALESCE(SUM(unknown_pages), 0) AS unknown,
      COUNT(*) AS runs
    FROM copy_events
    WHERE (status = 'billed' OR (status = 'open' AND confidence != 'low')) AND substr(started_at, 1, 10) BETWEEN ? AND ?
    GROUP BY day
  `).all(from, to);
}

/** Copy runs nobody rang up: confident ones only. */
function unbilledCopies(from, to) {
  return db.prepare(`${SELECT}
    WHERE ce.status = 'open' AND ce.pages > 0 AND ce.confidence != 'low' AND substr(ce.started_at, 1, 10) BETWEEN ? AND ?
    ORDER BY ce.started_at DESC`).all(from, to).map(shape);
}

function setStatus(id, status, note, userId) {
  return db.prepare(`
    UPDATE copy_events SET status = ?, note = ?, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ? AND status IN ('open','dismissed')
  `).run(status, note, userId, id).changes;
}

module.exports = {
  ingestCopyEvents, listCopies, getCopy, openCopies, suggestCopyLines, copyPagesByDay, unbilledCopies, setStatus
};
