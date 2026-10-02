const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

// When running as a pkg-built .exe, __dirname is inside the read-only
// snapshot, so the database must live in a writable folder beside the .exe.
const PKG_ROOT = process.pkg
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..');

const DB_PATH = path.join(PKG_ROOT, 'data', 'receipts.db');

// Ensure the data folder exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL DEFAULT 'My Business',
  address       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  logo_data_url TEXT NOT NULL DEFAULT '',
  tax_rate      REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'GHS',
  footer_note   TEXT NOT NULL DEFAULT 'Thank you for your patronage!',
  receipt_prefix TEXT NOT NULL DEFAULT 'RCT',
  require_manual_print_review INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no      TEXT UNIQUE NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  customer_name   TEXT NOT NULL DEFAULT '',
  subtotal        REAL NOT NULL,
  discount_type   TEXT NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount','percent')),
  discount_value  REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  tax_rate        REAL NOT NULL DEFAULT 0,
  tax_amount      REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL,
  voided          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  qty         REAL NOT NULL,
  unit_price  REAL NOT NULL,
  line_total  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  sku              TEXT UNIQUE,
  category         TEXT NOT NULL DEFAULT '',
  price            REAL NOT NULL DEFAULT 0,
  stock_qty        REAL NOT NULL DEFAULT 0,
  reorder_level    REAL NOT NULL DEFAULT 5,
  track_stock      INTEGER NOT NULL DEFAULT 1,
  active           INTEGER NOT NULL DEFAULT 1,
  print_color_mode TEXT CHECK (print_color_mode IN ('color','mono')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id           INTEGER NOT NULL REFERENCES agents(id),
  dedupe_key         TEXT UNIQUE NOT NULL,
  printer_name       TEXT NOT NULL,
  document_name      TEXT NOT NULL DEFAULT '',
  submitted_by       TEXT NOT NULL DEFAULT '',
  pages              INTEGER,
  size_bytes         INTEGER,
  color_mode         TEXT CHECK (color_mode IN ('color','mono','unknown')),
  submitted_at       TEXT NOT NULL,
  received_at        TEXT NOT NULL DEFAULT (datetime('now')),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  matched_product_id INTEGER REFERENCES products(id),
  sale_id            INTEGER REFERENCES sales(id),
  auto_billed        INTEGER NOT NULL DEFAULT 0,
  note               TEXT NOT NULL DEFAULT '',
  reviewed_by        INTEGER REFERENCES users(id),
  reviewed_at        TEXT
);
`);

// ---------- Lightweight migrations for upgrading an older DB ----------
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('sale_items', 'product_id', 'product_id INTEGER REFERENCES products(id)');
ensureColumn('products', 'print_color_mode', "print_color_mode TEXT CHECK (print_color_mode IN ('color','mono'))");
ensureColumn('print_jobs', 'color_mode', "color_mode TEXT CHECK (color_mode IN ('color','mono','unknown'))");
ensureColumn('print_jobs', 'duplex', "duplex TEXT CHECK (duplex IN ('duplex','simplex','unknown'))");
ensureColumn('print_jobs', 'note', "note TEXT NOT NULL DEFAULT ''");
// matched_product_id / sale_id / auto_billed / products.print_color_mode / settings.require_manual_print_review
// are legacy columns from a removed auto-billing feature. Left in place (harmless,
// unused) rather than dropped, so upgrading an existing database never loses data.
ensureColumn('print_jobs', 'matched_product_id', 'matched_product_id INTEGER REFERENCES products(id)');
ensureColumn('print_jobs', 'sale_id', 'sale_id INTEGER REFERENCES sales(id)');
ensureColumn('print_jobs', 'auto_billed', 'auto_billed INTEGER NOT NULL DEFAULT 0');
ensureColumn('settings', 'require_manual_print_review', 'require_manual_print_review INTEGER NOT NULL DEFAULT 0');

// ---------- Seed default settings row ----------
const settingsExists = db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
if (!settingsExists) {
  db.prepare(`INSERT INTO settings (id, business_name) VALUES (1, 'My Business')`).run();
}

// ---------- Seed default admin account ----------
const anyAdmin = db.prepare(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`).get();
if (!anyAdmin) {
  const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(defaultPassword, 10);
  db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role)
    VALUES ('admin', ?, 'Administrator', 'admin')
  `).run(hash);
  console.log('------------------------------------------------------');
  console.log(' Created default admin account:');
  console.log('   username: admin');
  console.log(`   password: ${defaultPassword}`);
  console.log(' Please log in and change this password immediately.');
  console.log('------------------------------------------------------');
}

module.exports = db;
