// The server's local calendar date as YYYY-MM-DD (toISOString() gives the UTC
// date, which is wrong for part of every day outside UTC).
function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

module.exports = { localDateString, daysAgo, isDateString, SALE_DAY };
