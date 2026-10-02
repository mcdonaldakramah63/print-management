// ---------------------------------------------------------------
// SQLite driver selection
//
// Normal installs use better-sqlite3. The standalone Windows app (a Node
// single-executable) can't load native add-ons, so it uses Node's built-in
// node:sqlite through a thin adapter that offers the same API this app uses:
// prepare().get/all/run, exec, pragma and transaction (with nesting).
// Force the built-in driver with RECEIPT_SQLITE=builtin.
// ---------------------------------------------------------------

function isSea() {
  try { return require('node:sea').isSea(); } catch { return false; }
}

function openBuiltin(file) {
  // node:sqlite still prints an "experimental" warning on first use; it's
  // stable enough for this app, so keep the console clean.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (String(w && w.message ? w.message : w).includes('SQLite is an experimental feature')) return;
    return emit.call(process, w, ...rest);
  };
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file);
  let depth = 0;

  return {
    driver: 'node:sqlite',
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    pragma(text) {
      const rows = raw.prepare(`PRAGMA ${text}`).all();
      return rows;
    },
    transaction(fn) {
      return (...args) => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth++;
        try {
          const result = fn(...args);
          depth--;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return result;
        } catch (err) {
          depth--;
          raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw err;
        }
      };
    },
    close: () => raw.close()
  };
}

function openDatabase(file) {
  if (isSea() || process.env.RECEIPT_SQLITE === 'builtin') return openBuiltin(file);
  try {
    const Database = require('better-sqlite3');
    const db = new Database(file);
    db.driver = 'better-sqlite3';
    return db;
  } catch (err) {
    // No native module (or built for another Node version): fall back.
    return openBuiltin(file);
  }
}

module.exports = { openDatabase, isSea };
