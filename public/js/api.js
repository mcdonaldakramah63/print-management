// Running inside the Receipt Admin phone app (its WebView adds this).
const IN_APP = /\bReceiptAdmin\//.test(navigator.userAgent);

async function api(method, url, body) {
  // Relative URLs, so the app also works under a relay's /s/<shop>/ path.
  const res = await fetch(String(url).replace(/^\/+/, ''), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });

  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }

  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

function money(amount, currency) {
  const n = Number(amount || 0);
  return `${currency ? currency + ' ' : ''}${n.toFixed(2)}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// SQLite's datetime('now') values look like "2026-09-19 12:00:00" and are UTC,
// but browsers parse that format as local time (or reject it outright, in
// Safari). Normalise to ISO-8601 UTC before handing it to Date.
function parseDbDate(value) {
  if (!value) return null;
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(str)) {
    return new Date(str.replace(' ', 'T') + 'Z');
  }
  return new Date(str);
}

function formatDbDate(value) {
  const d = parseDbDate(value);
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : '';
}

// Today's date as YYYY-MM-DD in the browser's local timezone (unlike
// toISOString(), which gives the UTC date and is off near midnight).
function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
