// ---------------------------------------------------------------
// Pulse: a small status snapshot for the admin's phone
//
// Sales so far today, printers, alerts and stock in one document of a few
// kilobytes. The shop pushes it to the relay every couple of minutes, so the
// phone app can show the latest picture (and raise notifications) even when
// the shop PC is switched off or offline.
//
// It is encrypted end to end with AES-256-GCM under a key that only the
// shop and paired phones know (it travels in the pairing QR code's #fragment,
// which browsers never send to a server). The relay stores ciphertext only.
//   { v: 1, alg: "A256GCM", iv: <base64 12 bytes>, data: <base64 ciphertext || 16-byte tag> }
// ---------------------------------------------------------------
const crypto = require('crypto');
const db = require('../db');
const { localDateString } = require('./dates');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function newKey() { return b64url(crypto.randomBytes(32)); }

function encrypt(obj, keyB64) {
  const key = fromB64url(keyB64);
  if (key.length !== 32) throw new Error('Pulse key must be 32 bytes');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, alg: 'A256GCM', iv: iv.toString('base64'), data: ct.toString('base64') };
}

function decrypt(blob, keyB64) {
  const key = fromB64url(keyB64);
  const raw = Buffer.from(blob.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
}

const keyOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/** Everything the phone shows when it can't reach the full app. */
function buildPulse(now = new Date()) {
  const settings = db.prepare('SELECT business_name, currency FROM settings WHERE id = 1').get() || {};
  const totals = (where) => db.prepare(`SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS count FROM sales WHERE voided = 0 AND ${where}`).get();
  const today = totals("date(created_at,'localtime') = date('now','localtime') AND created_at >= date('now','localtime','-1 day')");
  const yesterday = totals("date(created_at,'localtime') = date('now','localtime','-1 day') AND created_at >= date('now','localtime','-1 day','-1 day')");
  const week = totals("date(created_at,'localtime') >= date('now','localtime','-6 days') AND created_at >= date('now','localtime','-6 days','-1 day')");
  const month = totals("strftime('%Y-%m', created_at,'localtime') = strftime('%Y-%m','now','localtime') AND created_at >= date('now','localtime','start of month','-1 day')");

  const rawSeries = db.prepare(`
    SELECT date(created_at,'localtime') AS day, SUM(total) AS revenue FROM sales
    WHERE voided = 0 AND date(created_at,'localtime') >= date('now','localtime','-13 days') AND created_at >= date('now','localtime','-13 days','-1 day') GROUP BY day
  `).all();
  const byDay = Object.fromEntries(rawSeries.map((r) => [r.day, r.revenue]));
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const k = localDateString(d);
    series.push({ day: k, revenue: Math.round((byDay[k] || 0) * 100) / 100 });
  }

  const paymentMix = db.prepare(`
    SELECT payment_method AS method, COUNT(*) AS count, SUM(total) AS revenue FROM sales
    WHERE voided = 0 AND date(created_at,'localtime') = date('now','localtime') AND created_at >= date('now','localtime','-1 day') GROUP BY payment_method ORDER BY revenue DESC
  `).all();
  const lastSale = db.prepare('SELECT receipt_no, total, created_at FROM sales WHERE voided = 0 ORDER BY id DESC LIMIT 1').get() || null;
  const cashiers = db.prepare(`
    SELECT u.full_name AS name, COUNT(*) AS count, SUM(s.total) AS revenue FROM sales s JOIN users u ON u.id = s.user_id
    WHERE s.voided = 0 AND date(s.created_at,'localtime') = date('now','localtime') AND s.created_at >= date('now','localtime','-1 day') GROUP BY u.id ORDER BY revenue DESC LIMIT 8
  `).all();
  const lowStock = db.prepare(`
    SELECT name, stock_qty, reorder_level FROM products
    WHERE active = 1 AND track_stock = 1 AND stock_qty <= reorder_level ORDER BY stock_qty ASC LIMIT 10
  `).all();
  const closedToday = !!db.prepare('SELECT 1 FROM day_closings WHERE business_date = ?').get(localDateString(now));

  const printers = safe(() => require('./printerControl').listPrinters('admin', now.getTime()), []).map((p) => ({
    name: p.name,
    agent: p.agent_label,
    health: p.health,
    headline: p.headline,
    stale: p.stale,
    updated_at: p.updated_at,
    queue: Array.isArray(p.queue) ? p.queue.length : 0,
    issues: (p.issues || []).filter((i) => i.severity !== 'info').slice(0, 5).map((i) => ({ key: i.key, severity: i.severity, title: i.title }))
  }));

  const toner = safe(() => require('./insights/toner').tonerStatus(), []).map((t) => ({
    printer: t.printer,
    supplies: t.supplies.filter((s) => s.percent !== null).map((s) => ({ colorant: s.colorant || s.description, percent: s.percent, days_left: s.days_left, status: s.status }))
  })).filter((t) => t.supplies.length);

  let printing = null;
  safe(() => {
    const { reconcile } = require('../routes/reconciliation');
    const k = localDateString(now);
    const r = reconcile(k, k).rows[0];
    if (r) printing = { pages: r.color_printed + r.mono_printed + r.unknown_printed, pages_sold: r.color_sold + r.mono_sold, gap: r.gap, estimated_value: r.estimated_value };
  });

  // Alerts the phone can notify about. Keys are stable while the problem
  // lasts, so a phone only buzzes once for each.
  const alerts = [];
  for (const p of printers) {
    if (p.stale) continue;
    for (const i of p.issues) {
      if (i.severity === 'critical' || i.severity === 'warning') {
        alerts.push({ key: `printer:${keyOf(`${p.agent}:${p.name}:${i.key}`)}`, kind: 'printer', severity: i.severity === 'critical' ? 'high' : 'medium', title: `${p.name}: ${i.title}` });
      }
    }
  }
  const { riskAlerts } = require('./insights/risk');
  for (const a of safe(() => riskAlerts(require('../routes/reconciliation').reconcile, now), [])) {
    alerts.push({ key: `risk:${keyOf(`${a.type}:${a.title}`)}`, kind: 'risk', severity: a.severity, title: a.title, detail: a.detail });
  }
  // Toner and stock alerts: the same ones the admin sees under the bell.
  alerts.push(...safe(() => require('./notifications').forPulse(), []));

  const agents = db.prepare('SELECT label, last_seen_at FROM agents WHERE active = 1 ORDER BY label').all();

  return {
    v: 1,
    generated_at: now.toISOString(),
    business: settings.business_name || 'Shop',
    currency: settings.currency || 'GHS',
    today, yesterday, week, month,
    series,
    payment_mix: paymentMix,
    cashiers,
    last_sale: lastSale,
    closed_today: closedToday,
    printing,
    printers,
    toner,
    low_stock: lowStock,
    alerts: alerts.slice(0, 40),
    agents
  };
}

module.exports = { buildPulse, encrypt, decrypt, newKey, b64url, fromB64url };
