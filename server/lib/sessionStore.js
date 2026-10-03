// ---------------------------------------------------------------
// Sessions kept in the app's SQLite database, so sign-ins survive a restart
// of the shop PC (the phone app keeps admins signed in for 30 days).
// ---------------------------------------------------------------
const session = require('express-session');

class SqliteStore extends session.Store {
  constructor(db, { pruneMs = 60 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.q = {
      get: db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?'),
      set: db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires < ?')
    };
    this.prune();
    this.timer = setInterval(() => this.prune(), pruneMs);
    if (this.timer.unref) this.timer.unref();
  }

  static expiry(sess) {
    const c = sess && sess.cookie;
    if (c && c.expires) return new Date(c.expires).getTime();
    return Date.now() + (c && c.originalMaxAge ? c.originalMaxAge : 12 * 3600 * 1000);
  }

  prune() {
    try { this.q.prune.run(Date.now()); } catch { /* best effort */ }
  }

  get(sid, cb) {
    try {
      const row = this.q.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) { this.q.destroy.run(sid); return cb(null, null); }
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb = () => {}) {
    try { this.q.set.run(sid, JSON.stringify(sess), SqliteStore.expiry(sess)); cb(null); } catch (err) { cb(err); }
  }

  touch(sid, sess, cb = () => {}) {
    try { this.q.touch.run(SqliteStore.expiry(sess), sid); cb(null); } catch (err) { cb(err); }
  }

  destroy(sid, cb = () => {}) {
    try { this.q.destroy.run(sid); cb(null); } catch (err) { cb(err); }
  }
}

module.exports = { SqliteStore };
