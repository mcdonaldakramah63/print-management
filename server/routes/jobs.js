const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { quote } = require('../lib/jobPricing');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['queued', 'printing', 'ready', 'collected', 'cancelled'];
const OPEN = ['queued', 'printing', 'ready'];
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function dueAt(v) {
  if (v == null || v === '') return null;
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) throw new Error('The due time is not a valid date.');
  return t.toISOString();
}

function shape(r) {
  if (!r) return r;
  const parts = JSON.parse(r.parts || '[]');
  const lines = JSON.parse(r.lines || '[]');
  return {
    ...r,
    parts,
    lines,
    paid: !!r.sale_id,
    overdue: OPEN.includes(r.status) && r.status !== 'ready' && !!r.due_at && Date.parse(r.due_at) < Date.now()
  };
}

const SELECT = `
  SELECT j.*, u.full_name AS created_by_name, s.receipt_no
  FROM jobs j
  LEFT JOIN users u ON u.id = j.created_by
  LEFT JOIN sales s ON s.id = j.sale_id
`;

function getJob(id) {
  return shape(db.prepare(`${SELECT} WHERE j.id = ?`).get(Number(id)));
}

// Price a job without saving it (the builder's live total).
router.post('/quote', (req, res) => {
  try {
    res.json(quote(req.body && req.body.parts));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The board: open jobs by due time, plus recently finished ones.
router.get('/', (req, res) => {
  const q = text(req.query.q, 100);
  const search = q ? ' AND (j.job_no LIKE ? OR j.customer_name LIKE ? OR j.customer_phone LIKE ? OR j.title LIKE ?)' : '';
  const params = q ? Array(4).fill(`%${q}%`) : [];
  const open = db.prepare(`${SELECT} WHERE j.status IN ('queued','printing','ready')${search}
    ORDER BY j.due_at IS NULL, j.due_at, j.id`).all(...params).map(shape);
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const done = db.prepare(`${SELECT} WHERE j.status IN ('collected','cancelled')
    AND j.updated_at >= datetime('now', ?)${search}
    ORDER BY j.updated_at DESC LIMIT 100`).all(`-${days} days`, ...params).map(shape);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const j of open) counts[j.status]++;
  for (const j of done) counts[j.status]++;
  counts.overdue = open.filter((j) => j.overdue).length;
  counts.unpaid_ready = open.filter((j) => j.status === 'ready' && !j.paid).length;
  res.json({ jobs: open.concat(done), counts });
});

router.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  try {
    const priced = quote(b.parts);
    if (!priced.lines.length) throw new Error('Nothing in this job has a price yet. Fix the warnings or add a custom line.');
    const due = dueAt(b.due_at);
    const id = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO jobs (job_no, customer_name, customer_phone, title, parts, lines, total, due_at, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`new-${Date.now()}-${Math.random()}`, text(b.customer_name, 200), text(b.customer_phone, 40), text(b.title, 200),
        JSON.stringify(priced.parts), JSON.stringify(priced.lines), priced.subtotal, due, text(b.notes, 1000), req.session.user.id);
      const newId = info.lastInsertRowid;
      db.prepare('UPDATE jobs SET job_no = ? WHERE id = ?').run(`J-${String(newId).padStart(4, '0')}`, newId);
      return newId;
    })();
    res.status(201).json({ job: getJob(id), warnings: priced.warnings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Edit the details; the work itself only until it is paid for.
router.put('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!OPEN.includes(job.status)) return res.status(400).json({ error: `This job is ${job.status} and can no longer be changed.` });
  const b = req.body || {};
  try {
    let parts = job.parts;
    let lines = job.lines;
    let total = job.total;
    let warnings = [];
    if (b.parts !== undefined) {
      const priced = quote(b.parts);
      const changed = JSON.stringify(priced.parts) !== JSON.stringify(job.parts);
      if (changed && job.paid) throw new Error(`This job is already paid for (${job.receipt_no}). Void that sale to change the work.`);
      if (!priced.lines.length) throw new Error('Nothing in this job has a price yet. Fix the warnings or add a custom line.');
      if (changed) ({ parts, lines, subtotal: total, warnings } = priced);
    }
    db.prepare(`
      UPDATE jobs SET customer_name = ?, customer_phone = ?, title = ?, parts = ?, lines = ?, total = ?,
        due_at = ?, notes = ?, updated_at = datetime('now') WHERE id = ?
    `).run(
      b.customer_name !== undefined ? text(b.customer_name, 200) : job.customer_name,
      b.customer_phone !== undefined ? text(b.customer_phone, 40) : job.customer_phone,
      b.title !== undefined ? text(b.title, 200) : job.title,
      JSON.stringify(parts), JSON.stringify(lines), total,
      b.due_at !== undefined ? dueAt(b.due_at) : job.due_at,
      b.notes !== undefined ? text(b.notes, 1000) : job.notes,
      job.id
    );
    res.json({ job: getJob(job.id), warnings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Move a job along: queued -> printing -> ready -> collected, or cancel it.
router.patch('/:id/status', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const status = String((req.body || {}).status || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  if (status === job.status) return res.json({ job });
  if (job.status === 'cancelled' && status !== 'queued') return res.status(400).json({ error: 'This job was cancelled. Reopen it first.' });
  if (status === 'cancelled' && job.paid) {
    return res.status(400).json({ error: `This job is paid for (${job.receipt_no}). Void that sale before cancelling the job.` });
  }
  db.prepare(`
    UPDATE jobs SET status = ?, updated_at = datetime('now'),
      ready_at = CASE WHEN ? = 'ready' THEN datetime('now') WHEN ? IN ('queued','printing') THEN NULL ELSE ready_at END,
      collected_at = CASE WHEN ? = 'collected' THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(status, status, status, status, job.id);
  res.json({ job: getJob(job.id) });
});

module.exports = router;
