// ---------------------------------------------------------------
// Busy hours, staffing and opening hours
//
// Arrival rate per weekday × hour = average sales in that slot over the last
// 8 weeks (counting only weeks the shop was trading). Service time is
// measured, not assumed: the median gap between back-to-back sales by the
// same cashier (gaps over 10 minutes are idle time and ignored).
//
// Staffing uses the Erlang C queueing model (M/M/c): for each slot it finds
// the smallest number of cashiers that serves 80% of customers within
// 2 minutes. Opening hours are learned from when sales actually happen
// (the 2nd-98th percentile of sale times per weekday).
// ---------------------------------------------------------------
const db = require('../../db');
const { median, quantile } = require('./stats');

const WEEKS = 8;
const TARGET_WAIT_MIN = 2;
const SERVICE_LEVEL = 0.8;

/** Probability an arriving customer has to wait (Erlang C), computed stably. */
function erlangC(c, a) {
  if (a <= 0) return 0;
  if (c <= a) return 1;
  // Erlang B by recursion, then convert to C.
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return b / (1 - (a / c) * (1 - b));
}

/** Smallest number of servers meeting the service level for arrival rate λ/h and service time s min. */
function staffNeeded(lambdaPerHour, serviceMin) {
  if (lambdaPerHour <= 0) return 0;
  const mu = 60 / serviceMin;             // customers per hour per cashier
  const a = lambdaPerHour / mu;           // offered load (Erlangs)
  for (let c = Math.max(1, Math.ceil(a)); c < 50; c++) {
    if (c <= a) continue;
    const pw = erlangC(c, a);
    const serviceLevel = 1 - pw * Math.exp(-(c * mu - lambdaPerHour) * (TARGET_WAIT_MIN / 60));
    if (serviceLevel >= SERVICE_LEVEL) return c;
  }
  return 50;
}

function measuredServiceMinutes() {
  const rows = db.prepare(`
    SELECT user_id, created_at FROM sales
    WHERE created_at >= datetime('now', '-56 days') ORDER BY user_id, created_at
  `).all();
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].user_id !== rows[i - 1].user_id) continue;
    const g = (Date.parse(`${rows[i].created_at.replace(' ', 'T')}Z`) - Date.parse(`${rows[i - 1].created_at.replace(' ', 'T')}Z`)) / 60000;
    if (g > 0.25 && g <= 10) gaps.push(g);
  }
  // Back-to-back gaps in a busy spell approximate time per customer.
  return gaps.length >= 30 ? Math.max(0.5, Math.round(quantile(gaps, 0.4) * 10) / 10) : 3;
}

function trafficAnalysis() {
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) AS wd,
           CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hr,
           CAST(strftime('%M', created_at, 'localtime') AS INTEGER) AS mi,
           date(created_at, 'localtime') AS day
    FROM sales WHERE voided = 0 AND created_at >= datetime('now', ?)
  `).all(`-${WEEKS * 7} days`);

  // Weeks actually trading per weekday (don't divide by weeks before the shop opened).
  const tradingDays = new Map();
  for (const r of rows) {
    if (!tradingDays.has(r.wd)) tradingDays.set(r.wd, new Set());
    tradingDays.get(r.wd).add(r.day);
  }
  const firstDay = rows.reduce((m, r) => (r.day < m ? r.day : m), '9999');
  const weeksFor = (wd) => {
    if (!rows.length) return 1;
    const spanDays = Math.max(1, Math.round((Date.now() - Date.parse(firstDay)) / 86400000));
    return Math.max(1, Math.min(WEEKS, Math.round(spanDays / 7)), tradingDays.get(wd)?.size || 0);
  };

  const counts = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) counts[r.wd][r.hr]++;
  const serviceMin = measuredServiceMinutes();
  const rate = counts.map((hrs, wd) => hrs.map((n) => n / weeksFor(wd)));
  const staff = rate.map((hrs) => hrs.map((lambda) => staffNeeded(lambda, serviceMin)));

  // Opening hours per weekday from the spread of sale times.
  const opening = Array.from({ length: 7 }, (_, wd) => {
    const mins = rows.filter((r) => r.wd === wd).map((r) => r.hr * 60 + r.mi);
    if (mins.length < 20) return null;
    return { open: Math.floor(quantile(mins, 0.02)), close: Math.ceil(quantile(mins, 0.98)) };
  });

  // Busiest slots and a plain-language staffing summary.
  const slots = [];
  rate.forEach((hrs, wd) => hrs.forEach((lambda, hr) => { if (lambda > 0) slots.push({ wd, hr, per_hour: Math.round(lambda * 10) / 10, cashiers: staff[wd][hr] }); }));
  slots.sort((a, b) => b.per_hour - a.per_hour);

  const activeHours = [];
  rate.forEach((hrs) => hrs.forEach((v, h) => { if (v >= 0.5) activeHours.push(h); }));
  const range = activeHours.length ? [Math.min(...activeHours), Math.max(...activeHours)] : [8, 18];

  return {
    service_minutes: serviceMin,
    target: { wait_minutes: TARGET_WAIT_MIN, service_level: SERVICE_LEVEL },
    hours: Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i),
    rate: rate.map((hrs) => hrs.map((v) => Math.round(v * 10) / 10)),
    staff,
    peak: slots.slice(0, 5),
    max_cashiers: Math.max(0, ...staff.flat()),
    opening
  };
}

let openingCache = null;
/** Learned opening hours (cached 1 h) — used to flag after-hours printing. */
function openingHours() {
  if (!openingCache || Date.now() - openingCache.at > 3600 * 1000) {
    const rows = db.prepare(`
      SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) AS wd,
             CAST(strftime('%H', created_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', created_at, 'localtime') AS INTEGER) AS m
      FROM sales WHERE voided = 0 AND created_at >= datetime('now', '-56 days')
    `).all();
    const byDay = Array.from({ length: 7 }, (_, wd) => rows.filter((r) => r.wd === wd).map((r) => r.m));
    const all = rows.map((r) => r.m);
    openingCache = {
      at: Date.now(),
      days: byDay.map((mins) => (mins.length >= 20 ? { open: quantile(mins, 0.02), close: quantile(mins, 0.98), samples: mins.length } : null)),
      overall: all.length >= 50 ? { open: quantile(all, 0.02), close: quantile(all, 0.98) } : null,
      dayCounts: byDay.map((m) => m.length),
      totalDays: new Set(rows.map((r) => r.wd)).size
    };
  }
  return openingCache;
}

/**
 * Is a moment outside the shop's usual hours? Allows 45 minutes of slack
 * either side. A weekday with almost no sales in the history (a closed day)
 * counts as closed all day once there's enough history overall.
 */
function isOffHours(date) {
  const oh = openingHours();
  if (!oh.overall) return false;
  const wd = date.getDay();
  const minute = date.getHours() * 60 + date.getMinutes();
  const day = oh.days[wd];
  const medianDayCount = median(oh.dayCounts.filter((n) => n > 0));
  if (!day) return oh.dayCounts[wd] < 0.05 * medianDayCount;
  return minute < day.open - 45 || minute > day.close + 45;
}

module.exports = { trafficAnalysis, erlangC, staffNeeded, openingHours, isOffHours };
