// ---------------------------------------------------------------
// Print session ↔ sale matching
//
// Cashiers don't always use "Add to sale" for a print session; often they
// ring up "B&W print A4 × 12" by hand. Those sales aren't linked to the
// session, so the session looks unbilled. This finds the most likely
// sale for each unbilled session with a minimum-cost bipartite matching
// (Hungarian algorithm), so one sale can't explain two sessions and the
// overall pairing is optimal rather than first-come greedy.
//
// Cost of pairing a session with a sale (lower is better):
//   * page mismatch: |colour pages - colour sold| + |B&W pages - B&W sold|,
//     relative to the session's pages (must be within 50%),
//   * time: the sale should come after the printing, within 3 hours
//     (up to 15 minutes before is tolerated for ring-up-then-print),
//   * customer name: a till name that matches the Windows user is a bonus.
// Each session may also stay unmatched at a fixed cost, so weak pairings
// are rejected instead of forced.
// ---------------------------------------------------------------
const db = require('../../db');
const { hungarian, nameSimilarity } = require('./stats');

const MAX_AFTER_MIN = 180;
const MAX_BEFORE_MIN = 15;
const MAX_PAGE_ERROR = 0.5;
const UNMATCHED_COST = 1.0;
const BIG = 1e6;

function ts(value) {
  const s = String(value || '');
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}

function pairCost(session, sale) {
  const pages = session.color_pages + session.mono_pages;
  if (pages <= 0) return BIG;
  const pageError = (Math.abs(session.color_pages - sale.color_qty) + Math.abs(session.mono_pages - sale.mono_qty)) / pages;
  if (pageError > MAX_PAGE_ERROR) return BIG;
  const minutes = (ts(sale.created_at) - ts(session.ended_at)) / 60000;
  if (!(minutes <= MAX_AFTER_MIN && minutes >= -MAX_BEFORE_MIN)) return BIG;
  const timeCost = minutes >= 0 ? minutes / MAX_AFTER_MIN : (-minutes / MAX_BEFORE_MIN) * 0.5;
  const nameBonus = nameSimilarity(session.owner, sale.customer_name) >= 0.8 ? 0.3 : 0;
  return 1.5 * pageError + 0.6 * timeCost - nameBonus;
}

/**
 * Match unbilled sessions in [from, to] to print-service sales that aren't
 * linked to any session. Returns Map(sessionId -> { sale, cost, confidence }).
 */
function matchUnbilledSessions(from, to) {
  const sessions = db.prepare(`
    SELECT id, owner, machine, color_pages, mono_pages, ended_at FROM print_sessions
    WHERE sale_id IS NULL AND id IN (SELECT session_id FROM print_jobs WHERE substr(submitted_at, 1, 10) BETWEEN ? AND ?)
  `).all(from, to);
  if (sessions.length === 0) return new Map();

  const sales = db.prepare(`
    SELECT s.id, s.receipt_no, s.customer_name, s.created_at,
           SUM(CASE WHEN p.print_color_mode = 'color' THEN si.qty ELSE 0 END) AS color_qty,
           SUM(CASE WHEN p.print_color_mode = 'mono' THEN si.qty ELSE 0 END) AS mono_qty
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    JOIN products p ON p.id = si.product_id AND p.print_color_mode IS NOT NULL
    WHERE s.voided = 0
      AND date(s.created_at, 'localtime') BETWEEN date(?, '-1 day') AND date(?, '+1 day')
      AND NOT EXISTS (SELECT 1 FROM print_sessions ps WHERE ps.sale_id = s.id)
    GROUP BY s.id
  `).all(from, to);
  if (sales.length === 0) return new Map();

  // Columns: every candidate sale, then one private "stay unmatched" column per session.
  const cost = sessions.map((session, i) => [
    ...sales.map((sale) => pairCost(session, sale)),
    ...sessions.map((_, k) => (k === i ? UNMATCHED_COST : BIG))
  ]);
  const assignment = hungarian(cost);

  const result = new Map();
  assignment.forEach((col, i) => {
    if (col < 0 || col >= sales.length) return;
    const c = cost[i][col];
    if (c >= UNMATCHED_COST) return;
    result.set(sessions[i].id, {
      sale: { id: sales[col].id, receipt_no: sales[col].receipt_no, customer_name: sales[col].customer_name },
      cost: Math.round(c * 100) / 100,
      // Logistic map of cost to a 0–1 confidence: ~0.5 halfway to the
      // rejection cost, never a flat 100% even for a perfect-looking pair.
      confidence: Math.round((1 / (1 + Math.exp(6 * (c - UNMATCHED_COST / 2)))) * 100) / 100
    });
  });
  return result;
}

module.exports = { matchUnbilledSessions, pairCost };
