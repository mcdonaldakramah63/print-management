// ---------------------------------------------------------------
// Photocopies from counter readings typed in by staff
//
// Some printers can't report their page counter to the PC at all: USB
// inkjets that don't speak PJL (Epson EcoTank, Canon Pixma…), host-based
// lasers, and copiers that aren't connected to any PC. Their counter is still
// on the printer's screen, its status sheet or the maker's utility, so staff
// type it in (at closing, or before and after a customer's copies):
//
//   photocopies = counter growth since the last reading
//               - pages printed to it from the PCs in that time (print jobs)
//               - photocopies already detected on it automatically
//
// With a separate colour counter the colour copies are worked out the same
// way. The result is an ordinary copy run: billed at the till, dismissed,
// counted in Printed vs sold, like the ones the agents find.
// ---------------------------------------------------------------
const crypto = require('crypto');
const db = require('../db');
const { localIso } = require('./dates');

const MAX_COUNT = 2e9;

/** The built-in "agent" typed-in copy runs belong to (can never sign in). */
function manualAgentId() {
  const row = db.prepare("SELECT id FROM agents WHERE kind = 'manual'").get();
  if (row) return row.id;
  return db.prepare("INSERT INTO agents (label, api_key_hash, active, kind) VALUES ('Typed-in counter readings', ?, 0, 'manual')")
    .run(`manual:${crypto.randomBytes(24).toString('hex')}`).lastInsertRowid;
}

const lastReading = db.prepare('SELECT * FROM counter_readings WHERE counter_printer_id = ? ORDER BY id DESC LIMIT 1');

function listPrinters({ includeInactive = false } = {}) {
  return db.prepare(`SELECT * FROM counter_printers ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`).all().map((p) => {
    const last = lastReading.get(p.id);
    return { ...p, last_reading: last ? { count: last.count, color_count: last.color_count, read_at: last.read_at, copy_pages: last.copy_pages } : null };
  });
}

function getPrinter(id) {
  return db.prepare('SELECT * FROM counter_printers WHERE id = ?').get(Number(id));
}

/** Add a printer to typed-in counter readings (or turn it back on). */
function addPrinter({ name, unit, color, userId }) {
  const clean = String(name || '').trim().slice(0, 200);
  if (!clean) throw new Error('Give the printer a name.');
  const u = unit === 'sheets' ? 'sheets' : 'impressions';
  const c = ['mono', 'color', 'split'].includes(color) ? color : 'mono';
  const existing = db.prepare('SELECT id FROM counter_printers WHERE name = ?').get(clean);
  if (existing) {
    db.prepare('UPDATE counter_printers SET active = 1, unit = ?, color = ? WHERE id = ?').run(u, c, existing.id);
    return getPrinter(existing.id);
  }
  const id = db.prepare('INSERT INTO counter_printers (name, unit, color, created_by) VALUES (?, ?, ?, ?)').run(clean, u, c, userId || null).lastInsertRowid;
  return getPrinter(id);
}

function updatePrinter(id, { unit, color, active }) {
  const p = getPrinter(id);
  if (!p) throw new Error('Printer not found');
  db.prepare('UPDATE counter_printers SET unit = ?, color = ?, active = ? WHERE id = ?').run(
    unit === undefined ? p.unit : (unit === 'sheets' ? 'sheets' : 'impressions'),
    color === undefined ? p.color : (['mono', 'color', 'split'].includes(color) ? color : p.color),
    active === undefined ? p.active : (active ? 1 : 0),
    p.id
  );
  return getPrinter(p.id);
}

// Pages the PCs printed to this printer between two readings (by any agent).
const printedBetween = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN ? = 'sheets' THEN COALESCE(sheets, impressions, pages) ELSE COALESCE(impressions, pages) END), 0) AS pages,
    COALESCE(SUM(CASE WHEN color_mode = 'color' THEN (CASE WHEN ? = 'sheets' THEN COALESCE(sheets, impressions, pages) ELSE COALESCE(impressions, pages) END) ELSE 0 END), 0) AS color
  FROM print_jobs
  WHERE printer_name = ?
    AND julianday(COALESCE(completed_at, submitted_at)) > julianday(?) AND julianday(COALESCE(completed_at, submitted_at)) <= julianday(?)
`);

// Copies the agents already found on it automatically in that time.
const autoCopiesBetween = db.prepare(`
  SELECT COALESCE(SUM(detected_pages), 0) AS pages FROM copy_events
  WHERE printer_name = ? AND source != 'manual_counter' AND status != 'duplicate'
    AND julianday(ended_at) > julianday(?) AND julianday(started_at) <= julianday(?)
`);

const count = (v, label) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) throw new Error(`${label} must be a whole number, as the printer shows it.`);
  return n;
};

/**
 * Record a reading. Returns what it found:
 *   { first } on the first reading (it is the starting point), else
 *   { growth, printed, auto, copies, color, mono, event_id, warning }.
 * reset: the counter went back (new printer, mainboard replaced): start again.
 */
function recordReading(printerId, { count: rawCount, color_count: rawColor, reset = false, userId = null, now = new Date() } = {}) {
  const p = getPrinter(printerId);
  if (!p || !p.active) throw new Error('Printer not found');
  const total = count(rawCount, 'The counter');
  if (total === null) throw new Error('Type in the number the printer\'s counter shows.');
  const colorCount = p.color === 'split' ? count(rawColor, 'The colour counter') : null;
  if (colorCount !== null && colorCount > total) throw new Error('The colour counter can\'t be more than the total counter.');
  const readAt = localIso(now);
  const prev = lastReading.get(p.id);

  const result = db.transaction(() => {
    const insert = (fields) => db.prepare(`
      INSERT INTO counter_readings (counter_printer_id, count, color_count, read_at, baseline, printed_pages, copy_pages, copy_event_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(p.id, total, colorCount, readAt, fields.baseline ? 1 : 0, fields.printed || 0, fields.copies || 0, fields.eventId || null, userId).lastInsertRowid;

    if (!prev || reset) {
      const id = insert({ baseline: true });
      return { reading_id: id, first: true, reset: !!prev };
    }
    if (total < prev.count) {
      throw new Error(`That is lower than the last reading (${prev.count}). Check the number; if the counter really went back (printer replaced or reset), tick "The counter was reset".`);
    }
    if (Date.parse(readAt) - Date.parse(prev.read_at) < 0) throw new Error('The last reading is in the future: check the PC\'s clock.');
    const growth = total - prev.count;
    const printed = printedBetween.get(p.unit, p.unit, p.name, prev.read_at, readAt);
    const auto = autoCopiesBetween.get(p.name, prev.read_at, readAt).pages;
    const copies = Math.max(0, growth - printed.pages - auto);
    let warning = '';
    if (growth - printed.pages - auto < 0) {
      warning = `The PCs sent ${printed.pages} ${p.unit === 'sheets' ? 'sheets' : 'pages'} to it but the counter only went up by ${growth}: some jobs may have been cancelled${p.unit === 'impressions' ? ', or this printer counts sheets rather than pages' : ''}.`;
    }

    let colorCopies = 0;
    let mono = 0;
    let unknown = 0;
    if (p.color === 'split' && colorCount !== null && prev.color_count !== null && prev.color_count !== undefined) {
      colorCopies = Math.min(copies, Math.max(0, (colorCount - prev.color_count) - printed.color));
      mono = copies - colorCopies;
    } else if (p.color === 'mono') {
      mono = copies;
    } else {
      unknown = copies; // colour printer with one counter: asked at the till
    }

    let eventId = null;
    if (copies > 0) {
      // Shown under the day of the reading; the real span is kept in counter_from.
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const started = Date.parse(prev.read_at) > dayStart.getTime() ? prev.read_at : localIso(dayStart);
      const evidence = ['typed_counter'];
      if (printed.pages > 0) evidence.push('pc_jobs_subtracted');
      if (auto > 0) evidence.push('auto_copies_subtracted');
      eventId = db.prepare(`
        INSERT INTO copy_events (agent_id, event_key, printer_name, address, started_at, ended_at, detected_pages, pages,
          color_pages, mono_pages, unknown_pages, unit, source, confidence, evidence, status, counter_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_counter', 'medium', ?, 'open', ?)
      `).run(manualAgentId(), `manual:${p.id}:${crypto.randomBytes(6).toString('hex')}`, p.name, `counter:${p.id}`, started, readAt,
        copies, copies, colorCopies, mono, unknown, p.unit, JSON.stringify(evidence), prev.read_at).lastInsertRowid;
    }
    const id = insert({ printed: printed.pages, copies, eventId });
    return {
      reading_id: id, first: false, since: prev.read_at, growth, printed: printed.pages, auto, copies,
      color: colorCopies, mono, unknown, event_id: eventId, warning
    };
  })();
  require('./notifications').soon(); // clears the "type in the counter" reminder
  return result;
}

function readings(printerId, limit = 30) {
  return db.prepare(`
    SELECT r.*, u.full_name AS user_name FROM counter_readings r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.counter_printer_id = ? ORDER BY r.id DESC LIMIT ?
  `).all(Number(printerId), limit);
}

/** Printers with no reading for over a day (for the admin's alerts). */
function overdue(hours = 26) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  return listPrinters().filter((p) => !p.last_reading || Date.parse(p.last_reading.read_at) < cutoff);
}

module.exports = { listPrinters, getPrinter, addPrinter, updatePrinter, recordReading, readings, overdue, manualAgentId };
