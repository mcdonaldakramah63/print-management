// ---------------------------------------------------------------
// Alerts for the admin: toner running low, stock running out
//
// Conditions are worked out from what the system already measures:
//   * toner and ink: each supply's level from the printers (SNMP) and the
//     learned pages-per-percent forecast. Warning at the shop's "low" level
//     (default 20 %) or when it will run out within 5 days; critical at the
//     "replace" level (default 10 %). Waste boxes, drums and fusers too.
//   * stock: every tracked product. Critical when out; warning when at or
//     under its alert level, or when the sales forecast says it runs out
//     before a new order could arrive (supplier lead time).
//
// Each condition has a stable key (one cartridge, one product). An alert is
// raised once, raised again (unread, a new desktop and phone notification)
// only when it gets worse, and resolved by itself when the condition clears
// (toner replaced, stock received). A printer that stops reporting keeps its
// alerts as they were rather than looking fixed.
// ---------------------------------------------------------------
const db = require('../db');

const WARNING = 1;
const CRITICAL = 2;
const iso = () => new Date().toISOString();

const SUPPLY_NAMES = {
  toner: 'toner', ink: 'ink', drum: 'drum unit', developer: 'developer', fuser: 'fuser',
  transfer_unit: 'transfer unit', staples: 'staples', waste_toner: 'waste toner box', waste_ink: 'waste ink box'
};

function settings() {
  const s = db.prepare('SELECT toner_warn_pct, toner_critical_pct, reorder_lead_days FROM settings WHERE id = 1').get() || {};
  return {
    warn: Number.isFinite(s.toner_warn_pct) ? s.toner_warn_pct : 20,
    critical: Number.isFinite(s.toner_critical_pct) ? s.toner_critical_pct : 10,
    lead: Math.max(1, s.reorder_lead_days || 3)
  };
}

function supplyLabel(s) {
  const what = SUPPLY_NAMES[s.kind] || 'supply';
  const colour = s.colorant && !/^(unknown|other)$/i.test(s.colorant) && !/waste/.test(s.kind || '') ? `${String(s.colorant).toLowerCase()} ` : '';
  return `${colour}${what}`;
}

const days = (n) => (n < 1 ? 'less than a day' : `about ${Math.round(n)} day${Math.round(n) === 1 ? '' : 's'}`);

/** Every condition that should be alerting now: Map(key -> alert), plus keys to leave untouched. */
function currentConditions() {
  const cfg = settings();
  const out = new Map();
  const keep = new Set(); // keys whose source is stale: don't resolve or change them

  const { tonerStatus } = require('./insights/toner');
  for (const printer of tonerStatus()) {
    for (const s of printer.supplies) {
      const key = `toner:${printer.printer}:${s.index}`;
      if (printer.stale) { keep.add(key); continue; }
      if (s.percent === null || s.percent === undefined) continue;
      const waste = /waste/.test(s.kind || '');
      const label = supplyLabel(s);
      const soon = s.days_left !== null && s.days_left !== undefined && s.days_left <= 5;
      let level = 0;
      if (s.percent <= cfg.critical || s.status === 'replace_now') level = CRITICAL;
      else if (s.percent <= cfg.warn || soon) level = WARNING;
      if (!level) continue;
      const left = waste ? `${Math.round(100 - s.percent)}% full` : `${Math.round(s.percent)}% left`;
      const forecast = s.days_left !== null && s.days_left !== undefined ? ` · ${days(s.days_left)} at the current rate` : '';
      out.set(key, {
        kind: 'toner',
        level,
        title: level === CRITICAL
          ? (waste ? `Empty the ${label} in ${printer.printer}` : `Replace the ${label} in ${printer.printer}`)
          : (waste ? `${printer.printer}: ${label} filling up` : `${printer.printer}: ${label} running low`),
        detail: `${left}${forecast}`,
        link: 'dashboard'
      });
    }
  }

  const { stockOutlook } = require('./insights/stock');
  for (const p of stockOutlook()) {
    const key = `stock:${p.id}`;
    let level = 0;
    let title = '';
    let detail = '';
    const order = p.suggested_order > 0 ? ` Order about ${p.suggested_order}.` : '';
    if (p.stock_qty <= 0) {
      level = CRITICAL;
      title = `${p.name} is out of stock`;
      detail = `None left.${order}`;
    } else if (p.status === 'order_now' || (p.days_left !== null && p.days_left <= cfg.lead)) {
      level = WARNING;
      title = `${p.name} will run out soon`;
      detail = `${p.stock_qty} left, ${days(p.days_left ?? 0)} at the current rate, and a new order takes ${cfg.lead} day${cfg.lead === 1 ? '' : 's'}.${order}`;
    } else if (p.stock_qty <= p.reorder_level) {
      level = WARNING;
      title = `${p.name} is running low`;
      detail = `${p.stock_qty} left (alert level ${p.reorder_level}).${order}`;
    }
    if (level) out.set(key, { kind: 'stock', level, title, detail: detail.trim(), link: 'products' });
  }
  return { conditions: out, keep };
}

/**
 * Bring the notifications table in line with the current conditions.
 * Returns the alerts raised or escalated by this pass.
 */
function evaluate() {
  const { conditions, keep } = currentConditions();
  const now = iso();
  const raised = [];
  db.transaction(() => {
    const rows = db.prepare('SELECT * FROM notifications').all();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const insert = db.prepare(`INSERT INTO notifications (key, kind, level, title, detail, link, raised_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const reraise = db.prepare(`UPDATE notifications SET level = ?, title = ?, detail = ?, link = ?, raised_at = ?, updated_at = ?, read_at = NULL, resolved_at = NULL WHERE id = ?`);
    const refresh = db.prepare(`UPDATE notifications SET level = ?, title = ?, detail = ?, link = ?, updated_at = ? WHERE id = ?`);
    const resolve = db.prepare(`UPDATE notifications SET resolved_at = ?, updated_at = ? WHERE id = ?`);

    for (const [key, c] of conditions) {
      const row = byKey.get(key);
      if (!row) {
        const info = insert.run(key, c.kind, c.level, c.title, c.detail, c.link, now, now);
        raised.push({ id: info.lastInsertRowid, ...c });
      } else if (row.resolved_at || c.level > row.level) {
        // Came back, or got worse: alert again.
        reraise.run(c.level, c.title, c.detail, c.link, now, now, row.id);
        raised.push({ id: row.id, ...c });
      } else if (row.title !== c.title || row.detail !== c.detail || row.level !== c.level) {
        refresh.run(c.level, c.title, c.detail, c.link, now, row.id);
      }
    }
    for (const row of rows) {
      if (row.resolved_at || conditions.has(row.key) || keep.has(row.key)) continue;
      resolve.run(now, now, row.id);
    }
  })();
  return raised;
}

// Run after anything that can change stock or toner, a moment later and
// at most once per burst (a sale of ten items is one evaluation).
let timer = null;
function soon(delayMs = 1500) {
  clearTimeout(timer);
  timer = setTimeout(() => { try { evaluate(); } catch (err) { console.error('Alerts:', err.message); } }, delayMs);
  if (timer.unref) timer.unref();
}

let interval = null;
function start(everyMs = 5 * 60 * 1000) {
  soon(10000);
  interval = setInterval(() => { try { evaluate(); } catch (err) { console.error('Alerts:', err.message); } }, everyMs);
  if (interval.unref) interval.unref();
}

function shape(r) {
  return {
    id: r.id, key: r.key, kind: r.kind, level: r.level, severity: r.level === CRITICAL ? 'critical' : 'warning',
    title: r.title, detail: r.detail, link: r.link,
    raised_at: r.raised_at, updated_at: r.updated_at, read: !!r.read_at, resolved_at: r.resolved_at
  };
}

/** Open alerts (most serious, newest first) and the last week's resolved ones. */
function list() {
  const open = db.prepare('SELECT * FROM notifications WHERE resolved_at IS NULL ORDER BY level DESC, raised_at DESC').all().map(shape);
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const resolved = db.prepare('SELECT * FROM notifications WHERE resolved_at IS NOT NULL AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 20').all(since).map(shape);
  return { open, resolved, unread: open.filter((n) => !n.read).length };
}

function unread() {
  return db.prepare('SELECT * FROM notifications WHERE resolved_at IS NULL AND read_at IS NULL ORDER BY level DESC, raised_at DESC LIMIT 50').all().map(shape);
}

function markRead(ids) {
  const now = iso();
  if (ids === 'all') return db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND resolved_at IS NULL').run(now).changes;
  const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL');
  let n = 0;
  for (const id of ids) n += stmt.run(now, id).changes;
  return n;
}

/** Open alerts for the phone's status snapshot (keys change on escalation). */
function forPulse() {
  return db.prepare('SELECT * FROM notifications WHERE resolved_at IS NULL ORDER BY level DESC, raised_at DESC LIMIT 30').all().map((r) => ({
    key: `alert:${r.id}:${r.level}:${r.raised_at}`,
    kind: r.kind,
    severity: r.level === CRITICAL ? 'high' : 'medium',
    title: r.title,
    detail: r.detail
  }));
}

module.exports = { evaluate, soon, start, list, unread, markRead, forPulse, currentConditions, WARNING, CRITICAL };
