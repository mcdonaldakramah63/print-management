// ---------------------------------------------------------------
// Printer consumables
//
// For each printer, paper is tracked in sheets (duplex jobs use half as
// many) and toner in pages printed (impressions) since it was last refilled
// or replaced. Daily usage is an exponentially weighted average of the last
// 28 days of that printer's own printing (recent days weigh more), which
// gives the expected run-out date. Usage counts jobs by when they printed,
// so jobs that reach the server late are still attributed correctly.
// ---------------------------------------------------------------
const db = require('../../db');
const { localDateString } = require('../dates');

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateString(new Date(y, m - 1, d + n));
}

const usedSince = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN ? = 'paper' THEN COALESCE(sheets, pages) ELSE COALESCE(impressions, pages) END), 0) AS used
  FROM print_jobs WHERE printer_name = ? AND julianday(COALESCE(completed_at, submitted_at)) > julianday(?)
`);

function dailyUsage(printer, kind, today) {
  const rows = db.prepare(`
    SELECT substr(submitted_at, 1, 10) AS day,
           SUM(CASE WHEN ? = 'paper' THEN COALESCE(sheets, pages) ELSE COALESCE(impressions, pages) END) AS used
    FROM print_jobs WHERE printer_name = ? AND substr(submitted_at, 1, 10) >= ? AND substr(submitted_at, 1, 10) < ?
    GROUP BY day
  `).all(kind, printer, addDays(today, -28), today);
  if (rows.length === 0) return 0;
  const map = new Map(rows.map((r) => [r.day, r.used]));
  const first = rows.reduce((m, r) => (r.day < m ? r.day : m), today);
  let level = null;
  const alpha = 0.2;
  for (let d = first; d < today; d = addDays(d, 1)) {
    const x = map.get(d) || 0;
    level = level === null ? x : alpha * x + (1 - alpha) * level;
  }
  return level || 0;
}

function suppliesStatus() {
  const today = localDateString();
  const printers = db.prepare(`
    SELECT DISTINCT printer_name FROM print_jobs WHERE received_at >= datetime('now', '-60 days')
    UNION SELECT printer_name FROM printer_supplies
  `).all().map((r) => r.printer_name);
  const tracked = db.prepare('SELECT * FROM printer_supplies').all();

  return printers.sort().map((printer) => {
    const supplies = ['paper', 'toner'].map((kind) => {
      const s = tracked.find((t) => t.printer_name === printer && t.kind === kind);
      const rate = dailyUsage(printer, kind, today);
      if (!s) return { kind, tracked: false, daily_use: Math.round(rate) };
      const used = usedSince.get(kind, printer, s.refilled_at).used;
      const remaining = Math.max(0, s.capacity - used);
      const daysLeft = rate > 0 ? remaining / rate : null;
      return {
        kind,
        tracked: true,
        capacity: s.capacity,
        used,
        remaining,
        percent: Math.round((remaining / s.capacity) * 100),
        daily_use: Math.round(rate),
        days_left: daysLeft === null ? null : Math.round(daysLeft * 10) / 10,
        runs_out: daysLeft === null ? null : addDays(today, Math.floor(daysLeft)),
        refilled_at: s.refilled_at,
        status: remaining === 0 ? 'empty' : (daysLeft !== null && daysLeft < 1) || remaining / s.capacity < 0.1 ? 'low' : daysLeft !== null && daysLeft < 3 ? 'soon' : 'ok'
      };
    });
    return { printer, supplies };
  });
}

function recordRefill(printer, kind, capacity, userId) {
  const current = suppliesStatus().find((p) => p.printer === printer);
  const before = current ? current.supplies.find((s) => s.kind === kind) : null;
  db.transaction(() => {
    db.prepare(`INSERT INTO supply_refills (printer_name, kind, capacity, remaining_before, refilled_by) VALUES (?, ?, ?, ?, ?)`)
      .run(printer, kind, capacity, before && before.tracked ? before.remaining : null, userId);
    db.prepare(`
      INSERT INTO printer_supplies (printer_name, kind, capacity, refilled_at, refilled_by) VALUES (?, ?, ?, datetime('now'), ?)
      ON CONFLICT (printer_name, kind) DO UPDATE SET capacity = excluded.capacity, refilled_at = excluded.refilled_at, refilled_by = excluded.refilled_by
    `).run(printer, kind, capacity, userId);
  })();
}

module.exports = { suppliesStatus, recordRefill };
