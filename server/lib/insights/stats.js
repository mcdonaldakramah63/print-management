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

module.exports = {
  sum, mean, quantile, median, mad, std, robustZ, winsorize, wilsonLower, betaPrior,
  levenshtein, nameSimilarity, hungarian
};
