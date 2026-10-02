// ---------------------------------------------------------------
// Revenue forecast
//
// Damped additive Holt-Winters with a 7-day season (shops have weekly
// rhythms: busy Mondays, quiet Sundays). Smoothing parameters are chosen by
// grid search on one-step-ahead error, the history is winsorised first so a
// single huge order can't bend the model, and prediction intervals come
// from the robust spread (MAD) of the in-sample residuals. With under three
// weeks of history it falls back to a weekday-median model.
//
// "Today" is projected from the shop's own intraday profile: the share of a
// day's revenue normally earned by this time of day.
// ---------------------------------------------------------------
const db = require('../../db');
const { localDateString } = require('../dates');
const { mean, median, mad, winsorize } = require('./stats');

const SEASON = 7;
const HISTORY_DAYS = 84;
const HORIZON = 7;
const PHI = 0.9; // trend damping: trends fade rather than run forever
const Z80 = 1.2816;

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateString(new Date(y, m - 1, d + n));
}

function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Daily revenue (non-voided) from the first sale day up to yesterday, zero-filled. */
function dailyHistory(today) {
  const from = addDays(today, -HISTORY_DAYS);
  const rows = db.prepare(`
    SELECT date(created_at, 'localtime') AS day, SUM(total) AS revenue
    FROM sales WHERE voided = 0 AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
    GROUP BY day ORDER BY day
  `).all(from, today);
  if (rows.length === 0) return [];
  const map = new Map(rows.map((r) => [r.day, r.revenue]));
  const series = [];
  for (let d = rows[0].day; d < today; d = addDays(d, 1)) series.push({ day: d, revenue: map.get(d) || 0 });
  return series;
}

/** Fit damped additive Holt-Winters; returns state and one-step residuals. */
function holtWinters(y, alpha, beta, gamma) {
  const first = y.slice(0, SEASON);
  const second = y.slice(SEASON, 2 * SEASON);
  let level = mean(first);
  let trend = second.length === SEASON ? (mean(second) - mean(first)) / SEASON : 0;
  const season = first.map((v) => v - level);
  const residuals = [];
  for (let t = 0; t < y.length; t++) {
    const s = season[t % SEASON];
    const fitted = level + PHI * trend + s;
    if (t >= SEASON) residuals.push(y[t] - fitted);
    const prevLevel = level;
    level = alpha * (y[t] - s) + (1 - alpha) * (prevLevel + PHI * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * PHI * trend;
    season[t % SEASON] = gamma * (y[t] - level) + (1 - gamma) * s;
  }
  return { level, trend, season, residuals, n: y.length };
}

function hwForecast(state, h) {
  let damp = 0;
  for (let i = 1; i <= h; i++) damp += PHI ** i;
  return state.level + damp * state.trend + state.season[(state.n + h - 1) % SEASON];
}

function fitBest(y) {
  let best = null;
  for (const alpha of [0.05, 0.1, 0.2, 0.3, 0.5]) {
    for (const beta of [0, 0.02, 0.05, 0.1]) {
      for (const gamma of [0.05, 0.1, 0.2, 0.3]) {
        const state = holtWinters(y, alpha, beta, gamma);
        // Absolute error is less swayed by the odd extreme day than squared error.
        const score = mean(state.residuals.map(Math.abs));
        if (!best || score < best.score) best = { alpha, beta, gamma, state, score };
      }
    }
  }
  return best;
}

/** Share of a day's revenue normally taken by a given minute of the day. */
function intradayShare(today, now) {
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', created_at, 'localtime') AS INTEGER) AS minute,
           total
    FROM sales
    WHERE voided = 0 AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
  `).all(addDays(today, -56), today);
  if (rows.length < 30) return null; // not enough history to trust a profile
  const total = rows.reduce((s, r) => s + r.total, 0);
  if (total <= 0) return null;
  const minuteNow = now.getHours() * 60 + now.getMinutes();
  const before = rows.filter((r) => r.minute <= minuteNow).reduce((s, r) => s + r.total, 0);
  return before / total;
}

function forecastRevenue(now = new Date()) {
  const today = localDateString(now);
  const history = dailyHistory(today);
  const actualToday = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS revenue FROM sales WHERE voided = 0 AND date(created_at, 'localtime') = ?
  `).get(today).revenue;

  const futureDays = Array.from({ length: HORIZON }, (_, i) => addDays(today, i)); // includes today
  let model;
  let points;
  let accuracy = null;

  if (history.length >= 3 * SEASON) {
    const y = winsorize(history.map((h) => h.revenue));
    const best = fitBest(y);
    const sigma = Math.max(mad(best.state.residuals), 0.05 * Math.max(median(y), 1));
    points = futureDays.map((day, i) => {
      const h = i + 1;
      const value = Math.max(0, hwForecast(best.state, h));
      // Uncertainty grows with the horizon (random-walk style approximation).
      const spread = Z80 * sigma * Math.sqrt(1 + (h - 1) * best.alpha ** 2);
      return { day, value, low: Math.max(0, value - spread), high: value + spread };
    });
    // Typical error over the last two weeks of one-step-ahead fits.
    const recent = best.state.residuals.slice(-14);
    const recentActual = y.slice(-14);
    const scale = mean(recentActual.map(Math.abs));
    accuracy = scale > 0 ? Math.round((mean(recent.map(Math.abs)) / scale) * 100) : null;
    model = { name: 'holt-winters', alpha: best.alpha, beta: best.beta, gamma: best.gamma };
  } else if (history.length >= SEASON) {
    // Short history: median of each weekday seen so far, overall median as a fallback.
    const byDay = new Map();
    for (const h of history) {
      const w = weekday(h.day);
      if (!byDay.has(w)) byDay.set(w, []);
      byDay.get(w).push(h.revenue);
    }
    const all = history.map((h) => h.revenue);
    const sigma = Math.max(mad(all), 0.1 * Math.max(median(all), 1));
    points = futureDays.map((day) => {
      const sample = byDay.get(weekday(day)) || all;
      const value = median(sample);
      return { day, value, low: Math.max(0, value - Z80 * sigma), high: value + Z80 * sigma };
    });
    model = { name: 'weekday-median' };
  } else {
    return { model: { name: 'insufficient' }, historyDays: history.length, history, forecast: [], today: { actual: actualToday } };
  }

  const todayPoint = points[0];
  const share = intradayShare(today, now);
  let projected = null;
  let pace = null;
  if (share !== null && share > 0.02) {
    // What's still to come today, at the forecast's level.
    projected = actualToday + todayPoint.value * (1 - share);
    const expectedSoFar = todayPoint.value * share;
    const tolerance = (todayPoint.high - todayPoint.value) * Math.sqrt(share);
    pace = actualToday > expectedSoFar + tolerance ? 'ahead' : actualToday < expectedSoFar - tolerance ? 'behind' : 'on_track';
  }

  const round = (n) => Math.round(n * 100) / 100;
  return {
    model,
    accuracy,                       // typical one-day error, % of an average day
    historyDays: history.length,
    history: history.slice(-28),
    forecast: points.map((p) => ({ day: p.day, value: round(p.value), low: round(p.low), high: round(p.high) })),
    today: {
      actual: round(actualToday),
      forecast: round(todayPoint.value),
      share: share === null ? null : Math.round(share * 100) / 100,
      projected: projected === null ? null : round(projected),
      pace
    }
  };
}

module.exports = { forecastRevenue, holtWinters, fitBest, hwForecast };
