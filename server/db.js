const path = require('path');
const bcrypt = require('bcryptjs');
const { openDatabase, isSea } = require('./lib/sqlite');

// When running as the standalone .exe, the database lives in a writable
// "data" folder beside the .exe.
const PKG_ROOT = process.pkg || isSea()
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..');

// RECEIPTS_DB points the tests at a scratch database.
const DB_PATH = process.env.RECEIPTS_DB || path.join(PKG_ROOT, 'data', 'receipts.db');

// Ensure the data folder exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = openDatabase(DB_PATH);
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

db.exec(`
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  delta       REAL NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('initial','sale','void','adjust','edit')),
  sale_id     INTEGER REFERENCES sales(id),
  user_id     INTEGER REFERENCES users(id),
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at);

-- A print session: one client's burst of print jobs, grouped by
-- server/lib/printAnalysis.js. Totals and flags are recomputed whenever a
-- job joins. A session linked to a sale (sale_id) is billed and closed.
CREATE TABLE IF NOT EXISTS print_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        INTEGER NOT NULL REFERENCES agents(id),
  client_key      TEXT NOT NULL,
  owner           TEXT NOT NULL DEFAULT '',
  machine         TEXT NOT NULL DEFAULT '',
  started_at      TEXT NOT NULL,
  ended_at        TEXT NOT NULL,
  job_count       INTEGER NOT NULL DEFAULT 0,
  document_count  INTEGER NOT NULL DEFAULT 0,
  color_pages     INTEGER NOT NULL DEFAULT 0,
  mono_pages      INTEGER NOT NULL DEFAULT 0,
  unknown_pages   INTEGER NOT NULL DEFAULT 0,
  sheets          INTEGER NOT NULL DEFAULT 0,
  max_concurrent  INTEGER NOT NULL DEFAULT 1,
  flags           TEXT NOT NULL DEFAULT '[]',
  sale_id         INTEGER REFERENCES sales(id),
  billed_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_print_sessions_client ON print_sessions(client_key, ended_at);

-- One row per closed business day (local date, YYYY-MM-DD): the end-of-day
-- "Z-report" snapshot, frozen when the day is closed.
CREATE TABLE IF NOT EXISTS day_closings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date  TEXT UNIQUE NOT NULL,
  sales_count    INTEGER NOT NULL,
  voided_count   INTEGER NOT NULL,
  gross_total    REAL NOT NULL,
  cash_total     REAL NOT NULL,
  momo_total     REAL NOT NULL,
  card_total     REAL NOT NULL,
  cash_counted   REAL NOT NULL,
  variance       REAL NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  closed_by      INTEGER NOT NULL REFERENCES users(id),
  closed_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
// products.print_color_mode marks a product as a colour or B&W print service;
// the printed-vs-sold reconciliation counts its quantity sold as pages.
// matched_product_id / sale_id / auto_billed / settings.require_manual_print_review
// are legacy columns from a removed auto-billing feature. Left in place (harmless,
// unused) rather than dropped, so upgrading an existing database never loses data.
ensureColumn('print_jobs', 'matched_product_id', 'matched_product_id INTEGER REFERENCES products(id)');
ensureColumn('print_jobs', 'sale_id', 'sale_id INTEGER REFERENCES sales(id)');
ensureColumn('print_jobs', 'auto_billed', 'auto_billed INTEGER NOT NULL DEFAULT 0');
ensureColumn('settings', 'require_manual_print_review', 'require_manual_print_review INTEGER NOT NULL DEFAULT 0');
ensureColumn('sales', 'payment_method', "payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','momo','card'))");
ensureColumn('sales', 'amount_tendered', 'amount_tendered REAL');
ensureColumn('sales', 'change_due', 'change_due REAL');
ensureColumn('sales', 'customer_phone', "customer_phone TEXT NOT NULL DEFAULT ''");
ensureColumn('sales', 'voided_at', 'voided_at TEXT');
ensureColumn('sales', 'voided_by', 'voided_by INTEGER REFERENCES users(id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)');
// Profitability: optional cost price per product, snapshotted onto each sale
// line so margins stay correct after a cost changes.
ensureColumn('products', 'cost_price', 'cost_price REAL');
ensureColumn('sale_items', 'unit_cost', 'unit_cost REAL');

// Consumables per printer (paper loaded / toner fitted) and their usage since.
db.exec(`
CREATE TABLE IF NOT EXISTS printer_supplies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_name  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('paper','toner')),
  capacity      INTEGER NOT NULL,
  refilled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  refilled_by   INTEGER REFERENCES users(id),
  UNIQUE (printer_name, kind)
);
CREATE TABLE IF NOT EXISTS supply_refills (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_name  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  capacity      INTEGER NOT NULL,
  remaining_before INTEGER,
  refilled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  refilled_by   INTEGER REFERENCES users(id)
);
`);

// Toner / ink levels and device page counters read from printers over SNMP.
db.exec(`
CREATE TABLE IF NOT EXISTS supply_readings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       INTEGER NOT NULL REFERENCES agents(id),
  printer_name   TEXT NOT NULL,
  supply_index   TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  colorant       TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL DEFAULT 'other',
  receptacle     INTEGER NOT NULL DEFAULT 0,
  percent        REAL,
  some_remaining INTEGER NOT NULL DEFAULT 0,
  read_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supply_readings ON supply_readings(printer_name, supply_index, read_at);
CREATE TABLE IF NOT EXISTS device_counters (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  printer_name  TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  life_count    INTEGER,
  read_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_counters ON device_counters(printer_name, read_at);
`);

// Reorder planning: supplier lead time and how many days an order should cover.
ensureColumn('settings', 'reorder_lead_days', 'reorder_lead_days INTEGER NOT NULL DEFAULT 3');
ensureColumn('settings', 'reorder_cover_days', 'reorder_cover_days INTEGER NOT NULL DEFAULT 14');

// Print-job detail captured by the agent (per-job DEVMODE, client PC,
// completion time, optional source-document page count) and the results of
// server/lib/printAnalysis.js. pages stays "pages per copy" as reported by
// the spooler; impressions = pages x copies is what was physically printed.
ensureColumn('print_jobs', 'copies', 'copies INTEGER');
ensureColumn('print_jobs', 'collated', 'collated INTEGER');
ensureColumn('print_jobs', 'paper_size', "paper_size TEXT NOT NULL DEFAULT ''");
ensureColumn('print_jobs', 'client_machine', "client_machine TEXT NOT NULL DEFAULT ''");
ensureColumn('print_jobs', 'completed_at', 'completed_at TEXT');
ensureColumn('print_jobs', 'settings_source', "settings_source TEXT NOT NULL DEFAULT ''");
ensureColumn('print_jobs', 'document_pages', 'document_pages INTEGER');
ensureColumn('print_jobs', 'document_pages_source', "document_pages_source TEXT NOT NULL DEFAULT ''");
ensureColumn('print_jobs', 'doc_key', "doc_key TEXT NOT NULL DEFAULT ''");
ensureColumn('print_jobs', 'impressions', 'impressions INTEGER');
ensureColumn('print_jobs', 'sheets', 'sheets INTEGER');
ensureColumn('print_jobs', 'est_document_pages', 'est_document_pages INTEGER');
ensureColumn('print_jobs', 'est_source', "est_source TEXT NOT NULL DEFAULT ''");
ensureColumn('print_jobs', 'coverage', "coverage TEXT NOT NULL DEFAULT 'unknown'");
ensureColumn('print_jobs', 'flags', "flags TEXT NOT NULL DEFAULT '[]'");
ensureColumn('print_jobs', 'session_id', 'session_id INTEGER REFERENCES print_sessions(id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_print_jobs_session ON print_jobs(session_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_print_jobs_doc ON print_jobs(doc_key)');

// Print services: photocopy vs print, and one- vs two-sided. A two-sided
// service is sold per sheet; each sheet counts as 2 pages when printed is
// compared with sold.
ensureColumn('products', 'print_kind', "print_kind TEXT NOT NULL DEFAULT 'print' CHECK (print_kind IN ('print','copy'))");
ensureColumn('products', 'print_sides', 'print_sides INTEGER NOT NULL DEFAULT 1 CHECK (print_sides IN (1,2))');

// Photocopies (walk-up output) detected by the agents from the printer's
// page counter; see agent/copyMonitor.js.
db.exec(`
CREATE TABLE IF NOT EXISTS copy_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       INTEGER NOT NULL REFERENCES agents(id),
  event_key      TEXT NOT NULL,
  printer_name   TEXT NOT NULL,
  address        TEXT NOT NULL DEFAULT '',
  started_at     TEXT NOT NULL,
  ended_at       TEXT NOT NULL,
  detected_pages INTEGER NOT NULL,
  pages          INTEGER NOT NULL,
  color_pages    INTEGER NOT NULL DEFAULT 0,
  mono_pages     INTEGER NOT NULL DEFAULT 0,
  unknown_pages  INTEGER NOT NULL DEFAULT 0,
  unit           TEXT NOT NULL DEFAULT 'impressions',
  source         TEXT NOT NULL DEFAULT 'counter_gap',
  confidence     TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  evidence       TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','billed','dismissed','duplicate')),
  duplicate_of   INTEGER REFERENCES copy_events(id),
  sale_id        INTEGER REFERENCES sales(id),
  billed_at      TEXT,
  note           TEXT NOT NULL DEFAULT '',
  reviewed_by    INTEGER REFERENCES users(id),
  reviewed_at    TEXT,
  received_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agent_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_copy_events_started ON copy_events(started_at);
CREATE INDEX IF NOT EXISTS idx_copy_events_address ON copy_events(address, started_at);
`);

// Remote printer control: the latest front-panel snapshot per printer, a
// short history of it (for stall detection and print-speed learning), and
// the command queue the agents work through.
db.exec(`
CREATE TABLE IF NOT EXISTS printer_states (
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  printer_name  TEXT NOT NULL,
  data          TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (agent_id, printer_name)
);
CREATE TABLE IF NOT EXISTS printer_state_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  printer_name  TEXT NOT NULL,
  at            TEXT NOT NULL,
  data          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_printer_state_history ON printer_state_history(agent_id, printer_name, at);
CREATE TABLE IF NOT EXISTS printer_commands (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  printer_name  TEXT NOT NULL,
  action        TEXT NOT NULL,
  params        TEXT NOT NULL DEFAULT '{}',
  target_key    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','done','failed','expired')),
  requested_by  INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  lease_until   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  result        TEXT,
  error         TEXT,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_printer_commands_agent ON printer_commands(agent_id, status);
CREATE TABLE IF NOT EXISTS printer_info (
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  printer_name  TEXT NOT NULL,
  data          TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (agent_id, printer_name)
);
`);

// ---------- Indexes for lookups by sale ----------
// "Is this sale already linked to a print session / photocopy / job?" runs
// once per sale in reports and matching: without these it scanned whole
// tables each time (minutes on a year of data).
db.exec(`
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_print_sessions_sale ON print_sessions(sale_id);
CREATE INDEX IF NOT EXISTS idx_copy_events_sale ON copy_events(sale_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_sale ON print_jobs(sale_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_submitted ON print_jobs(submitted_at);
`);

// ---------- Alerts for the admin ----------
// One row per condition (a toner cartridge, a product): raised once, raised
// again only if it gets worse, resolved when it clears.
db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  level        INTEGER NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  link         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  raised_at    TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  read_at      TEXT,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_open ON notifications(resolved_at, raised_at);
`);
ensureColumn('settings', 'toner_warn_pct', 'toner_warn_pct INTEGER NOT NULL DEFAULT 20');
ensureColumn('settings', 'toner_critical_pct', 'toner_critical_pct INTEGER NOT NULL DEFAULT 10');

// ---------- Job builder ----------
// A customer's order taken at the counter (pages, copies, finishing) and
// tracked until it is collected. Priced from the catalog; billed through a
// normal sale, before or after it is done.
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_no          TEXT NOT NULL UNIQUE,
  customer_name   TEXT NOT NULL DEFAULT '',
  customer_phone  TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  parts           TEXT NOT NULL DEFAULT '[]',
  lines           TEXT NOT NULL DEFAULT '[]',
  total           REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','printing','ready','collected','cancelled')),
  due_at          TEXT,
  notes           TEXT NOT NULL DEFAULT '',
  sale_id         INTEGER REFERENCES sales(id),
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ready_at        TEXT,
  collected_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, due_at);
CREATE INDEX IF NOT EXISTS idx_jobs_sale ON jobs(sale_id);
`);

// ---------- Remote access ----------
// Logins survive restarts (the app's 30-day "keep me signed in" needs it),
// and the shop's link to the relay plus the key that encrypts the status
// snapshot paired phones read. Kept out of settings, which every signed-in
// user can read.
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid      TEXT PRIMARY KEY,
  sess     TEXT NOT NULL,
  expires  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

CREATE TABLE IF NOT EXISTS remote_link (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  enabled      INTEGER NOT NULL DEFAULT 0,
  relay_url    TEXT NOT NULL DEFAULT '',
  relay_key    TEXT NOT NULL DEFAULT '',
  shop_id      TEXT NOT NULL,
  shop_secret  TEXT NOT NULL,
  pulse_key    TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

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
