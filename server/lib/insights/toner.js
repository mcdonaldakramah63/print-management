// ---------------------------------------------------------------
// Toner / ink levels (measured by the printer, read over SNMP)
//
// Printers report each cartridge's level, but only in coarse steps and with
// no idea how fast it's going. This turns the readings into answers:
//
//   * Cartridge replacements are detected automatically: a jump up of 15+
//     points starts a new cartridge (no button to press).
//   * Pages per 1% is learned for the current cartridge with a Theil-Sen
//     fit (the median of all pairwise slopes) of level against pages
//     printed. Theil-Sen ignores the stair-steps and odd readings that a
//     least-squares line would chase. Black toner is matched to all pages;
//     cyan / magenta / yellow only to colour pages.
//   * Pages left = level × pages-per-1%; days left = pages left ÷ that
//     printer's recent daily pages (exponentially weighted).
//   * Too few pages since the change? Falls back to a level-over-time fit.
//   * Each finished cartridge's yield is remembered, so a cartridge running
//     much faster than the last one is flagged (heavy coverage, leaks).
//   * The printer's own page counter is compared with the pages the agent
//     saw: a gap means copies or prints that never went through Windows.
// ---------------------------------------------------------------
const db = require('../../db');
const { median } = require('./stats');

const REFILL_JUMP = 15;     // percentage points
const DAY = 86400000;

function theilSen(points) {
  // points: [{x, y}] — returns slope (median of pairwise slopes) and intercept.
  const pts = points.length > 80 ? points.filter((_, i) => i % Math.ceil(points.length / 80) === 0 || i === points.length - 1) : points;
  const slopes = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (dx > 0) slopes.push((pts[j].y - pts[i].y) / dx);
    }
  }
  if (slopes.length === 0) return null;
  const slope = median(slopes);
  const intercept = median(pts.map((p) => p.y - slope * p.x));
  return { slope, intercept, n: pts.length };
}

/** Cumulative pages printed on a printer up to any moment (binary search over its jobs). */
function pageClock(printer, colourOnly) {
  const jobs = db.prepare(`
    SELECT julianday(COALESCE(completed_at, submitted_at)) AS jd, COALESCE(impressions, pages, 0) AS pages
    FROM print_jobs WHERE printer_name = ? ${colourOnly ? "AND color_mode = 'color'" : ''}
      AND received_at >= datetime('now', '-200 days')
    ORDER BY jd
  `).all(printer);
  const times = jobs.map((j) => (j.jd - 2440587.5) * DAY);
  const cum = [];
  let total = 0;
  for (const j of jobs) { total += j.pages; cum.push(total); }
  return (ms) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= ms) lo = mid + 1; else hi = mid; }
    return lo === 0 ? 0 : cum[lo - 1];
  };
}

function dailyPages(printer, colourOnly) {
  const rows = db.prepare(`
    SELECT substr(submitted_at, 1, 10) AS day, SUM(COALESCE(impressions, pages, 0)) AS pages
    FROM print_jobs WHERE printer_name = ? ${colourOnly ? "AND color_mode = 'color'" : ''}
      AND received_at >= datetime('now', '-28 days')
    GROUP BY day ORDER BY day
  `).all(printer);
  if (rows.length === 0) return 0;
  // Exponentially weighted over calendar days (zero days count).
  const map = new Map(rows.map((r) => [r.day, r.pages]));
  const start = Date.parse(rows[0].day);
  let level = null;
  for (let t = start; t < Date.now() - DAY / 2; t += DAY) {
    const x = map.get(new Date(t).toISOString().slice(0, 10)) || 0;
    level = level === null ? x : 0.2 * x + 0.8 * level;
  }
  return level || 0;
}

const isColour = (c) => /cyan|magenta|yellow/i.test(c || '');

function analyseSupply(printer, readings, clocks) {
  const latest = readings[readings.length - 1];
  const out = {
    index: latest.supply_index,
    description: latest.description,
    colorant: latest.colorant,
    kind: latest.kind,
    receptacle: !!latest.receptacle,
    percent: latest.percent,
    some_remaining: !!latest.some_remaining,
    read_at: latest.read_at,
    method: null,
    pages_left: null,
    days_left: null,
    pages_per_percent: null,
    yield_estimate: null,
    previous_yield: null,
    replaced_at: null,
    status: 'ok',
    notes: []
  };

  // Waste bins fill up instead of running out; just report how full.
  if (out.receptacle || /waste/.test(out.kind)) {
    out.status = out.percent !== null && out.percent <= 10 ? 'replace_now' : out.percent !== null && out.percent <= 20 ? 'low' : 'ok';
    return out;
  }

  // Split readings into cartridges at upward jumps.
  const segments = [[]];
  let prev = null;
  for (const r of readings) {
    if (r.percent === null) continue;
    if (prev !== null && r.percent - prev >= REFILL_JUMP) segments.push([]);
    segments[segments.length - 1].push(r);
    prev = r.percent;
  }
  const current = segments[segments.length - 1];
  if (segments.length > 1 && current.length) out.replaced_at = current[0].read_at;

  const clock = isColour(out.colorant) ? clocks.colour : clocks.all;
  const usage = isColour(out.colorant) ? clocks.colourDaily : clocks.allDaily;
  const toPoints = (seg) => seg.map((r) => ({ t: Date.parse(r.read_at), y: r.percent })).map((p) => ({ ...p, x: clock(p.t) }));

  // Yield of earlier, finished cartridges (pages per 100%).
  const yields = segments.slice(0, -1).map((seg) => {
    const pts = toPoints(seg);
    const fit = pts.length >= 3 ? theilSen(pts) : null;
    return fit && fit.slope < 0 ? -100 / fit.slope : null;
  }).filter(Boolean);
  if (yields.length) out.previous_yield = Math.round(median(yields));

  if (out.percent === null) {
    out.status = out.some_remaining ? 'ok' : 'unknown';
    if (out.some_remaining) out.notes.push('The printer only says "some remaining" for this supply.');
    return out;
  }

  const pts = toPoints(current);
  const pagesSpan = pts.length ? pts[pts.length - 1].x - pts[0].x : 0;
  const levelDrop = pts.length ? pts[0].y - pts[pts.length - 1].y : 0;
  const pageFit = pts.length >= 3 && pagesSpan >= 50 && levelDrop >= 2 ? theilSen(pts) : null;

  if (pageFit && pageFit.slope < 0) {
    const perPercent = -1 / pageFit.slope;
    out.method = 'pages';
    out.pages_per_percent = Math.round(perPercent * 10) / 10;
    out.yield_estimate = Math.round(perPercent * 100);
    out.pages_left = Math.round(out.percent * perPercent);
    if (usage > 0) out.days_left = Math.round((out.pages_left / usage) * 10) / 10;
    if (out.previous_yield && out.yield_estimate < out.previous_yield * 0.7) {
      out.notes.push(`Running faster than the last cartridge (about ${out.yield_estimate} pages per cartridge vs ${out.previous_yield}). Heavier coverage or a leak?`);
    }
  } else {
    // Not enough printing since the change: fit level over time instead.
    const timePts = pts.map((p) => ({ x: (p.t - (pts[0] ? pts[0].t : 0)) / DAY, y: p.y }));
    const timeFit = timePts.length >= 3 && levelDrop >= 2 ? theilSen(timePts) : null;
    if (timeFit && timeFit.slope < 0) {
      out.method = 'time';
      out.days_left = Math.round((out.percent / -timeFit.slope) * 10) / 10;
    } else {
      out.method = 'learning';
      out.notes.push('Still learning how fast this cartridge empties.');
      if (out.previous_yield && usage > 0) {
        out.pages_left = Math.round((out.percent / 100) * out.previous_yield);
        out.days_left = Math.round((out.pages_left / usage) * 10) / 10;
      }
    }
  }

  out.status = out.percent <= 5 ? 'replace_now' : out.percent <= 15 || (out.days_left !== null && out.days_left <= 5) ? 'low' : 'ok';
  return out;
}

/** Device page counter vs pages the agent reported, over the last 24 hours. */
function deviceGap(printer) {
  const rows = db.prepare(`
    SELECT life_count, read_at FROM device_counters
    WHERE printer_name = ? AND life_count IS NOT NULL AND read_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
    ORDER BY read_at
  `).all(printer);
  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const device = last.life_count - first.life_count;
  if (device < 0) return null; // counter reset
  const jobs = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(impressions, pages, 0)), 0) AS pages FROM print_jobs
    WHERE printer_name = ? AND julianday(COALESCE(completed_at, submitted_at)) > julianday(?)
      AND julianday(COALESCE(completed_at, submitted_at)) <= julianday(?)
  `).get(printer, first.read_at, last.read_at).pages;
  const gap = device - jobs;
  return {
    from: first.read_at,
    to: last.read_at,
    device_pages: device,
    reported_pages: jobs,
    gap,
    significant: gap > Math.max(10, device * 0.05)
  };
}

function tonerStatus() {
  const printers = db.prepare(`
    SELECT printer_name, MAX(read_at) AS last FROM supply_readings GROUP BY printer_name
  `).all();
  return printers.map(({ printer_name: printer }) => {
    const readings = db.prepare(`
      SELECT * FROM supply_readings WHERE printer_name = ? ORDER BY supply_index, read_at
    `).all(printer);
    const device = db.prepare('SELECT model, address, life_count, read_at FROM device_counters WHERE printer_name = ? ORDER BY read_at DESC LIMIT 1').get(printer);
    const clocks = {
      all: pageClock(printer, false),
      colour: pageClock(printer, true),
      allDaily: dailyPages(printer, false),
      colourDaily: dailyPages(printer, true)
    };
    const bySupply = new Map();
    for (const r of readings) {
      if (!bySupply.has(r.supply_index)) bySupply.set(r.supply_index, []);
      bySupply.get(r.supply_index).push(r);
    }
    const order = { black: 0, cyan: 1, magenta: 2, yellow: 3 };
    const supplies = [...bySupply.values()].map((rs) => analyseSupply(printer, rs, clocks))
      .sort((a, b) => (a.receptacle - b.receptacle) || ((order[a.colorant] ?? 9) - (order[b.colorant] ?? 9)));
    const stale = device ? Date.now() - Date.parse(device.read_at) > 2 * 3600 * 1000 : true;
    return {
      printer,
      model: device ? device.model : '',
      address: device ? device.address : '',
      life_count: device ? device.life_count : null,
      read_at: device ? device.read_at : null,
      stale,
      supplies,
      device_gap: deviceGap(printer)
    };
  });
}

module.exports = { tonerStatus, theilSen };
