// Small, dependency-free statistics toolkit used by the insight engines.

function sum(xs) { return xs.reduce((s, x) => s + x, 0); }
function mean(xs) { return xs.length ? sum(xs) / xs.length : 0; }

function quantile(xs, q) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function median(xs) { return quantile(xs, 0.5); }

/** Median absolute deviation, scaled to estimate a standard deviation (1.4826). */
function mad(xs) {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/**
 * Robust z-score of x against a reference sample: how many robust standard
 * deviations it sits from the median. `floor` stops near-constant samples
 * (MAD = 0) from turning tiny differences into huge scores.
 */
function robustZ(x, sample, floor = 0) {
  const scale = Math.max(mad(sample), floor, 1e-9);
  return (x - median(sample)) / scale;
}

/** Clamp values to median ± k·MAD so single outliers can't dominate a fit. */
function winsorize(xs, k = 3) {
  if (xs.length < 5) return [...xs];
  const m = median(xs);
  const s = mad(xs);
  if (s === 0) return [...xs];
  return xs.map((x) => Math.min(m + k * s, Math.max(m - k * s, x)));
}

/**
 * Wilson score interval lower bound for a proportion: a conservative
 * estimate that stays low when the sample is small (3 of 4 is weaker
 * evidence than 300 of 400).
 */
function wilsonLower(successes, n, z = 1.96) {
  if (n === 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/**
 * Empirical-Bayes Beta prior for a set of rates (method of moments).
 * groups: [{ x: successes, n: trials }]. Falls back to a weak prior at the
 * pooled rate when the groups don't vary enough to estimate one.
 */
function betaPrior(groups, fallbackStrength = 20) {
  const totalX = sum(groups.map((g) => g.x));
  const totalN = sum(groups.map((g) => g.n));
  const pooled = totalN ? totalX / totalN : 0;
  const rates = groups.filter((g) => g.n > 0).map((g) => g.x / g.n);
  if (rates.length >= 3 && pooled > 0 && pooled < 1) {
    const m = mean(rates);
    const v = std(rates) ** 2;
    if (v > 0 && v < m * (1 - m)) {
      // Clamp the prior's weight: an outlier group inflates the variance and
      // would otherwise make the prior too weak to shrink small samples.
      const strength = Math.min(500, Math.max(10, (m * (1 - m)) / v - 1));
      return { a: pooled * strength, b: (1 - pooled) * strength, pooled };
    }
  }
  return { a: pooled * fallbackStrength, b: (1 - pooled) * fallbackStrength, pooled };
}

/** Levenshtein edit distance (two-row dynamic programme). */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Jaro-Winkler similarity (0..1). Better than edit distance for short names
 * and typos near the end ("Mensah" / "Mensa"), and rewards a shared prefix.
 */
function jaroWinkler(a, b) {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array(a.length).fill(false);
  const bHit = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bHit[j] && a[i] === b[j]) { aHit[i] = bHit[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** 0..1 similarity between two names, ignoring case, punctuation and word order. */
function nameSimilarity(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // A first name typed at the till vs "domain user" from Windows: containment counts.
  if (x.split(' ').some((w) => w.length > 2 && y.split(' ').includes(w))) return 0.85;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Minimum-cost assignment (Hungarian / Kuhn–Munkres, O(n³), potentials form).
 * cost: rows × cols matrix (rows <= cols after padding). Returns an array
 * mapping each row to its assigned column.
 */
function hungarian(cost) {
  const rows = cost.length;
  if (rows === 0) return [];
  const cols = cost[0].length;
  const n = Math.max(rows, cols);
  const c = (i, j) => (i <= rows && j <= cols ? cost[i - 1][j - 1] : 0);
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = c(i0, j) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assignment = new Array(rows).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] >= 1 && p[j] <= rows && j <= cols) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}

/**
 * Minimum-cost assignment on a sparse graph, where each row may also take a
 * private "none" option at a fixed cost. Same optimum as hungarian() on the
 * full matrix padded with one private column per row, but each row is added
 * by a Dijkstra shortest augmenting path (Jonker–Volgenant, with
 * potentials) over only the edges that exist, and the search stops at the
 * first free column, so it stays local: a month of a busy shop's print
 * sessions vs sales takes milliseconds instead of minutes.
 *
 * edges[i]: [[col, cost], ...] with col in 0..nCols-1. Returns an array
 * mapping each row to its column, or -1 for "none".
 */
function sparseAssignment(edges, nCols, noneCost) {
  const n = edges.length;
  // Shift every cost by the same amount so all are >= 0 (each row takes
  // exactly one option, so the optimum doesn't change).
  let minCost = noneCost;
  for (const list of edges) for (const [, c] of list) if (c < minCost) minCost = c;
  const shift = minCost < 0 ? -minCost : 0;
  const total = nCols + n; // real columns, then one "none" column per row
  const u = new Float64Array(n);
  const v = new Float64Array(total);
  const colRow = new Int32Array(total).fill(-1);
  const rowCol = new Int32Array(n).fill(-1);
  const dist = new Float64Array(total);
  const seen = new Int32Array(total).fill(-1); // stamp: dist valid for this round
  const done = new Int32Array(total).fill(-1); // stamp: finalised this round
  const via = new Int32Array(total);
  const rowDist = new Float64Array(n);

  for (let i0 = 0; i0 < n; i0++) {
    const heap = [];
    const push = (d, j) => {
      heap.push([d, j]);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    const relax = (r, base) => {
      const step = (j, c) => {
        if (done[j] === i0) return;
        const d = base + c + shift - u[r] - v[j];
        if (seen[j] !== i0 || d < dist[j]) {
          seen[j] = i0;
          dist[j] = d;
          via[j] = r;
          push(d, j);
        }
      };
      for (const [j, c] of edges[r]) step(j, c);
      step(nCols + r, noneCost);
    };

    const tree = [i0];
    const finals = [];
    rowDist[i0] = 0;
    relax(i0, 0);
    let end = -1;
    let delta = 0;
    while (heap.length) {
      const [d, j] = pop();
      if (done[j] === i0 || d > dist[j]) continue;
      done[j] = i0;
      finals.push(j);
      if (colRow[j] === -1) { end = j; delta = d; break; }
      const r = colRow[j];
      rowDist[r] = d;
      tree.push(r);
      relax(r, d);
    }
    // Potentials keep every reduced cost >= 0 and matched edges at 0.
    for (const r of tree) u[r] += delta - rowDist[r];
    for (const j of finals) v[j] -= delta - dist[j];
    // Flip the augmenting path.
    for (let j = end; ;) {
      const r = via[j];
      const prev = rowCol[r];
      rowCol[r] = j;
      colRow[j] = r;
      if (r === i0) break;
      j = prev;
    }
  }
  return Array.from(rowCol, (c) => (c >= nCols ? -1 : c));
}

module.exports = {
  sum, mean, quantile, median, mad, std, robustZ, winsorize, wilsonLower, betaPrior,
  levenshtein, jaroWinkler, nameSimilarity, hungarian, sparseAssignment
};
