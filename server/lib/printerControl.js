// ---------------------------------------------------------------
// Remote printer control: state store and command queue
//
// Agents sync in (POST /api/printers/agent-sync) with a snapshot of their
// printers and the results of commands they ran; the reply carries the
// commands waiting for them. Commands are:
//   * validated against the latest snapshot (a job action must name a job
//     that is really in the queue, by id AND document name);
//   * role-checked (cashiers run the everyday actions, admins also clear
//     queues and change default settings) and rate-limited per user;
//   * de-duplicated (a double-click returns the command already waiting)
//     and superseded (Pause then Resume before the agent picked up the
//     Pause drops the Pause);
//   * leased to the agent for 60 s at a time and re-delivered if no result
//     came back (the agent's journal makes sure nothing runs twice), up to
//     3 attempts;
//   * time-limited: one not picked up before its deadline expires instead
//     of running late.
// ---------------------------------------------------------------
const db = require('../db');
const { diagnose, STALE_MS } = require('./printerDoctor');

const ACTIONS = {
  cancel_job: { role: 'cashier', job: true, ttlSec: 120, verb: 'Cancel' },
  pause_job: { role: 'cashier', job: true, ttlSec: 120, verb: 'Hold' },
  resume_job: { role: 'cashier', job: true, ttlSec: 120, verb: 'Release' },
  restart_job: { role: 'cashier', job: true, ttlSec: 120, verb: 'Restart' },
  pause_printer: { role: 'cashier', ttlSec: 120, verb: 'Pause printer' },
  resume_printer: { role: 'cashier', ttlSec: 300, verb: 'Resume printer' },
  set_online: { role: 'cashier', ttlSec: 300, verb: 'Bring online' },
  test_page: { role: 'cashier', ttlSec: 120, verb: 'Print test page' },
  clear_queue: { role: 'admin', ttlSec: 120, verb: 'Clear queue' },
  set_defaults: { role: 'admin', ttlSec: 300, verb: 'Change defaults' }
};
const OPPOSITE = { pause_printer: 'resume_printer', resume_printer: 'pause_printer', pause_job: 'resume_job', resume_job: 'pause_job' };
const DUPLEX = ['OneSided', 'TwoSidedLongEdge', 'TwoSidedShortEdge'];
const PAPER = ['A4', 'A3', 'A5', 'Letter', 'Legal'];
const LEASE_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RATE = { max: 20, windowMs: 60 * 1000 };
const VIEW_WINDOW_MS = 60 * 1000;

class ControlError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const parse = (s, fallback) => { try { return JSON.parse(s); } catch (_) { return fallback; } };

// ---- who is looking (agents sync faster while someone is)
let lastViewAt = 0;
function markViewed(nowMs = Date.now()) { lastViewAt = nowMs; }
function isWatched(nowMs = Date.now()) { return nowMs - lastViewAt < VIEW_WINDOW_MS; }

// ---- rate limit per user (sliding window, in memory)
const recent = new Map();
function rateLimit(userId, nowMs) {
  const list = (recent.get(userId) || []).filter((t) => nowMs - t < RATE.windowMs);
  if (list.length >= RATE.max) throw new ControlError('Too many printer actions in a minute. Wait a moment and try again.', 429);
  list.push(nowMs);
  recent.set(userId, list);
}

function roleAllows(role, action) {
  const need = ACTIONS[action].role;
  return need === 'cashier' || role === 'admin';
}

function allowedActions(role) {
  return Object.keys(ACTIONS).filter((a) => roleAllows(role, a));
}

function latestState(agentId, printer) {
  const row = db.prepare('SELECT data, updated_at FROM printer_states WHERE agent_id = ? AND printer_name = ?').get(agentId, printer);
  return row ? { ...parse(row.data, {}), updated_at: row.updated_at } : null;
}

function cleanParams(action, params, state) {
  const p = params && typeof params === 'object' ? params : {};
  if (ACTIONS[action].job) {
    const jobId = Number(p.job_id);
    if (!Number.isInteger(jobId) || jobId <= 0) throw new ControlError('Choose a job');
    const job = (state.jobs || []).find((j) => j.id === jobId);
    if (!job) throw new ControlError('That job is no longer in the queue.', 409);
    if (p.document !== undefined && String(p.document) !== job.document) throw new ControlError('The queue has changed. Refresh and try again.', 409);
    return { job_id: jobId, document: job.document };
  }
  if (action === 'set_defaults') {
    const out = {};
    if (p.duplex !== undefined && p.duplex !== '') {
      if (!DUPLEX.includes(p.duplex)) throw new ControlError('Unknown duplex setting');
      out.duplex = p.duplex;
    }
    if (p.color !== undefined && p.color !== null && p.color !== '') out.color = p.color === true || p.color === 'true';
    if (p.paper_size !== undefined && p.paper_size !== '') {
      if (!PAPER.includes(p.paper_size)) throw new ControlError('Unknown paper size');
      out.paper_size = p.paper_size;
    }
    if (Object.keys(out).length === 0) throw new ControlError('Nothing to change');
    return out;
  }
  if (action === 'clear_queue' && !(state.jobs || []).length) throw new ControlError('The queue is already empty.', 409);
  return {};
}

function shapeCommand(row) {
  return row && {
    id: row.id, agent_id: row.agent_id, printer_name: row.printer_name, action: row.action, verb: ACTIONS[row.action] ? ACTIONS[row.action].verb : row.action,
    params: parse(row.params, {}), status: row.status, created_at: row.created_at, finished_at: row.finished_at,
    error: row.error, result: parse(row.result, null), requested_by: row.requested_by, requested_by_name: row.requested_by_name || null
  };
}

function getCommand(id) {
  return shapeCommand(db.prepare(`
    SELECT c.*, u.full_name AS requested_by_name FROM printer_commands c LEFT JOIN users u ON u.id = c.requested_by WHERE c.id = ?
  `).get(id));
}

/** Queue a command from a user. Returns the command (new or the one already waiting). */
function enqueue({ agentId, printer, action, params, user, nowMs = Date.now() }) {
  if (!ACTIONS[action]) throw new ControlError('Unknown printer action');
  if (!roleAllows(user.role, action)) throw new ControlError('Only an admin can do that.', 403);
  const agent = db.prepare('SELECT id, active FROM agents WHERE id = ?').get(agentId);
  if (!agent || !agent.active) throw new ControlError('That print agent is not active.', 404);
  const state = latestState(agentId, printer);
  if (!state) throw new ControlError('Printer not found.', 404);
  const clean = cleanParams(action, params, state);
  const targetKey = clean.job_id ? `job:${clean.job_id}` : 'printer';

  return db.transaction(() => {
    expireOld(nowMs);
    const pending = db.prepare(`
      SELECT * FROM printer_commands WHERE agent_id = ? AND printer_name = ? AND target_key = ? AND status IN ('queued','sent')
    `).all(agentId, printer, targetKey);
    // Double-click: hand back the identical command already waiting.
    const same = pending.find((c) => c.action === action && c.params === JSON.stringify(clean));
    if (same) return { command: getCommand(same.id), duplicate: true };
    for (const c of pending) {
      if (OPPOSITE[action] === c.action && c.status === 'queued') {
        // Pause then Resume before the agent picked up the Pause: drop it.
        db.prepare("UPDATE printer_commands SET status = 'expired', error = 'Replaced by a newer request', finished_at = ? WHERE id = ?").run(iso(nowMs), c.id);
      } else if (clean.job_id) {
        throw new ControlError(`"${clean.document}" already has an action in progress. Wait for it to finish.`, 409);
      }
    }
    rateLimit(user.id, nowMs);
    const info = db.prepare(`
      INSERT INTO printer_commands (agent_id, printer_name, action, params, target_key, requested_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agentId, printer, action, JSON.stringify(clean), targetKey, user.id, iso(nowMs), iso(nowMs + ACTIONS[action].ttlSec * 1000));
    return { command: getCommand(info.lastInsertRowid), duplicate: false };
  })();
}

function expireOld(nowMs) {
  const now = iso(nowMs);
  db.prepare(`
    UPDATE printer_commands SET status = 'expired', finished_at = ?, error = ?
    WHERE status = 'queued' AND expires_at < ?
  `).run(now, "The printer's PC didn't pick this up in time, so it wasn't run.", now);
  db.prepare(`
    UPDATE printer_commands SET status = 'failed', finished_at = ?, error = ?
    WHERE status = 'sent' AND lease_until < ? AND (attempts >= ? OR expires_at < ?)
  `).run(now, "The printer's PC didn't confirm this. Check the printer before trying again.", now, MAX_ATTEMPTS, now);
}

function compactJobs(jobs) {
  return (jobs || []).map((j) => ({ id: j.id, document: j.document, pages_printed: j.pages_printed, total_pages: j.total_pages, status: j.status, position: j.position }));
}

/** An agent's sync: store its snapshot and results, hand it its commands. */
function agentSync(agentId, body, nowMs = Date.now()) {
  const now = iso(nowMs);
  const snapshot = body && body.snapshot;
  const results = Array.isArray(body && body.results) ? body.results.slice(0, 100) : [];
  const acked = [];
  let commands = [];

  db.transaction(() => {
    if (snapshot && Array.isArray(snapshot.printers) && !snapshot.error) {
      const upsert = db.prepare(`
        INSERT INTO printer_states (agent_id, printer_name, data, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (agent_id, printer_name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `);
      const lastHistory = db.prepare('SELECT at, data FROM printer_state_history WHERE agent_id = ? AND printer_name = ? ORDER BY id DESC LIMIT 1');
      const addHistory = db.prepare('INSERT INTO printer_state_history (agent_id, printer_name, at, data) VALUES (?, ?, ?, ?)');
      const names = [];
      for (const p of snapshot.printers.slice(0, 50)) {
        if (!p || !p.name) continue;
        const name = String(p.name).slice(0, 200);
        names.push(name);
        const data = { ...p, jobs: (Array.isArray(p.jobs) ? p.jobs : []).slice(0, 200) };
        upsert.run(agentId, name, JSON.stringify(data), now);
        // History: on every change, else once a minute (stall + speed learning).
        const h = { jobs: compactJobs(data.jobs), state: data.state || '' };
        const last = lastHistory.get(agentId, name);
        if (!last || last.data !== JSON.stringify(h) || nowMs - Date.parse(last.at) >= 60000) addHistory.run(agentId, name, now, JSON.stringify(h));
      }
      // Printers removed from Windows disappear here too.
      const known = db.prepare('SELECT printer_name FROM printer_states WHERE agent_id = ?').all(agentId).map((r) => r.printer_name);
      for (const n of known) if (!names.includes(n)) db.prepare('DELETE FROM printer_states WHERE agent_id = ? AND printer_name = ?').run(agentId, n);
      db.prepare('DELETE FROM printer_state_history WHERE at < ?').run(iso(nowMs - 3 * 3600 * 1000));
    }

    const finish = db.prepare(`
      UPDATE printer_commands SET status = ?, result = ?, error = ?, finished_at = ?
      WHERE id = ? AND agent_id = ? AND status IN ('queued','sent','expired','failed')
    `);
    for (const r of results) {
      const id = Number(r && r.id);
      if (!Number.isInteger(id)) continue;
      const row = db.prepare('SELECT status FROM printer_commands WHERE id = ? AND agent_id = ?').get(id, agentId);
      if (!row) { acked.push(r.id); continue; }
      // The agent's word is final: it ran (or skipped) the command.
      if (row.status !== 'done') {
        finish.run(r.ok ? 'done' : r.expired ? 'expired' : 'failed', r.data === undefined ? null : JSON.stringify(r.data),
          r.ok ? null : String(r.error || 'Failed').slice(0, 300), now, id, agentId);
      }
      acked.push(r.id);
    }

    expireOld(nowMs);
    const due = db.prepare(`
      SELECT * FROM printer_commands
      WHERE agent_id = ? AND expires_at > ? AND (status = 'queued' OR (status = 'sent' AND lease_until < ? AND attempts < ?))
      ORDER BY id LIMIT 10
    `).all(agentId, now, now, MAX_ATTEMPTS);
    const lease = db.prepare("UPDATE printer_commands SET status = 'sent', lease_until = ?, attempts = attempts + 1 WHERE id = ?");
    commands = due.map((c) => {
      lease.run(iso(nowMs + LEASE_MS), c.id);
      return { id: c.id, action: c.action, printer: c.printer_name, params: parse(c.params, {}), expires_in_ms: Date.parse(c.expires_at) - nowMs };
    });
  })();

  return { commands, acked, watch: isWatched(nowMs) };
}

/** Every printer with its diagnosis, queue, pending and recent actions. */
function listPrinters(role, nowMs = Date.now()) {
  expireOld(nowMs);
  const rows = db.prepare(`
    SELECT ps.agent_id, ps.printer_name, ps.data, ps.updated_at, a.label AS agent_label
    FROM printer_states ps JOIN agents a ON a.id = ps.agent_id
    WHERE a.active = 1 ORDER BY a.label, ps.printer_name
  `).all();
  const historyFor = db.prepare(`
    SELECT at, data FROM printer_state_history WHERE agent_id = ? AND printer_name = ? AND at >= ? ORDER BY id
  `);
  const commandsFor = db.prepare(`
    SELECT c.*, u.full_name AS requested_by_name FROM printer_commands c LEFT JOIN users u ON u.id = c.requested_by
    WHERE c.agent_id = ? AND c.printer_name = ? AND (c.status IN ('queued','sent') OR c.finished_at >= ?)
    ORDER BY c.id DESC LIMIT 12
  `);
  const actions = allowedActions(role);
  return rows.map((r) => {
    const state = parse(r.data, {});
    const history = historyFor.all(r.agent_id, r.printer_name, iso(nowMs - 3600 * 1000)).map((h) => ({ at: h.at, ...parse(h.data, {}) }));
    const d = diagnose(state, { updated_at: r.updated_at, now: nowMs }, history);
    const cmds = commandsFor.all(r.agent_id, r.printer_name, iso(nowMs - 15 * 60 * 1000)).map(shapeCommand);
    const device = state.device || null;
    return {
      key: `${r.agent_id}:${r.printer_name}`,
      agent_id: r.agent_id,
      agent_label: r.agent_label,
      name: r.printer_name,
      host: state.host || null,
      driver: state.driver || '',
      is_default: !!state.is_default,
      updated_at: r.updated_at,
      stale: nowMs - Date.parse(r.updated_at) > STALE_MS,
      health: d.health,
      headline: d.headline,
      issues: d.issues,
      queue: d.queue,
      speed: d.speed,
      screen: d.screen,
      config: state.config || null,
      device: device && { reachable: device.reachable, status: device.status, trays: device.trays || [], covers: device.covers || [], alerts: device.alerts || [], errors: device.errors || [] },
      pending: cmds.filter((c) => c.status === 'queued' || c.status === 'sent'),
      recent: cmds.filter((c) => c.status !== 'queued' && c.status !== 'sent').slice(0, 5),
      actions
    };
  });
}

module.exports = { ACTIONS, ControlError, enqueue, agentSync, listPrinters, getCommand, markViewed, isWatched, allowedActions };
