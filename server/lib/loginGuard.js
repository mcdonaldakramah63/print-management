// ---------------------------------------------------------------
// Login guard
//
// Once the shop can be reached from the internet, passwords can be guessed
// from anywhere, so failed sign-ins are slowed down:
//   * per account: after 5 failures in 15 minutes the account is locked for
//     1 minute, doubling with every further failure up to 30 minutes;
//   * per address: 20 failures in 15 minutes blocks that address for 15.
// Remote and in-shop sign-ins are counted separately, so someone guessing
// over the internet can't lock the cashiers at the counter out.
// A successful sign-in clears the account's count.
// ---------------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_FREE = 5;
const IP_LIMIT = 20;
const MAX_LOCK_MS = 30 * 60 * 1000;

function createLoginGuard({ now = () => Date.now() } = {}) {
  const accounts = new Map(); // key -> { fails: [ts], lockedUntil }
  const addresses = new Map(); // ip -> { fails: [ts], blockedUntil }

  const recent = (list, t) => list.filter((x) => t - x < WINDOW_MS);
  const accountKey = (username, remote) => `${remote ? 'r' : 'l'}:${String(username).trim().toLowerCase()}`;

  function sweep(t) {
    if (accounts.size + addresses.size < 5000) return;
    for (const [k, v] of accounts) if (!recent(v.fails, t).length && (v.lockedUntil || 0) < t) accounts.delete(k);
    for (const [k, v] of addresses) if (!recent(v.fails, t).length && (v.blockedUntil || 0) < t) addresses.delete(k);
  }

  /** Milliseconds to wait before another try is allowed (0 = go ahead). */
  function check(username, ip, remote) {
    const t = now();
    const a = accounts.get(accountKey(username, remote));
    const i = addresses.get(ip);
    return Math.max(0, (a && a.lockedUntil ? a.lockedUntil - t : 0), (i && i.blockedUntil ? i.blockedUntil - t : 0));
  }

  function fail(username, ip, remote) {
    const t = now();
    sweep(t);
    const key = accountKey(username, remote);
    const a = accounts.get(key) || { fails: [], lockedUntil: 0 };
    a.fails = recent(a.fails, t).concat(t);
    const over = a.fails.length - ACCOUNT_FREE;
    if (over >= 0) a.lockedUntil = t + Math.min(MAX_LOCK_MS, 60000 * 2 ** over);
    accounts.set(key, a);

    const i = addresses.get(ip) || { fails: [], blockedUntil: 0 };
    i.fails = recent(i.fails, t).concat(t);
    if (i.fails.length >= IP_LIMIT) i.blockedUntil = t + WINDOW_MS;
    addresses.set(ip, i);
    return check(username, ip, remote);
  }

  function succeed(username, remote) {
    accounts.delete(accountKey(username, remote));
  }

  return { check, fail, succeed };
}

function waitMessage(ms) {
  const mins = Math.ceil(ms / 60000);
  return `Too many failed sign-ins. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
}

module.exports = { createLoginGuard, waitMessage };
