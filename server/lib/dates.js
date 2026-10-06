// The server's local calendar date as YYYY-MM-DD (toISOString() gives the UTC
// date, which is wrong for part of every day outside UTC).
function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ISO-8601 in the server's local time with its UTC offset, like the print
// agents stamp jobs and copy runs ("2026-10-06T17:45:00.000+01:00").
function localIso(d = new Date()) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 23);
  return `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateString(d);
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// sales.created_at is stored in UTC by datetime('now'); this SQL expression
// gives the local business date it belongs to.
const SALE_DAY = "date(s.created_at, 'localtime')";

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * An index-friendly superset of the local days [from, to] for a UTC
 * created_at column, to AND with an exact SALE_DAY condition. Wrapping the
 * column in date(..., 'localtime') stops SQLite using its index, so every
 * report scanned every sale ever made; UTC offsets are within ±14 h, so a
 * day either side is always enough. The dates are validated YYYY-MM-DD, so
 * inlining them is safe. Either end may be null (open).
 */
function saleSpan(from, to, col = 's.created_at') {
  const parts = [];
  if (isDateString(from)) parts.push(`${col} >= '${addDays(from, -1)}'`);
  if (isDateString(to)) parts.push(`${col} < '${addDays(to, 2)}'`);
  return parts.length ? `(${parts.join(' AND ')})` : '1';
}

/**
 * Print jobs carry the agent's local wall-clock time ("2026-10-03T14:05…"),
 * so a lexical range on the raw column selects exactly the days [from, to]
 * and can use its index (substr() can't).
 */
function jobSpan(from, to, col = 'submitted_at') {
  if (!isDateString(from) || !isDateString(to)) return '1';
  return `(${col} >= '${from}' AND ${col} < '${addDays(to, 1)}')`;
}

module.exports = { localDateString, daysAgo, isDateString, SALE_DAY, saleSpan, jobSpan, addDays, localIso };
