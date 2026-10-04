'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'queue.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stores (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  logo_url      TEXT NOT NULL DEFAULT '',
  welcome_text  TEXT NOT NULL DEFAULT '',
  theme_color   TEXT NOT NULL DEFAULT '#E4572E',
  queue_session INTEGER NOT NULL DEFAULT 1,
  business_date TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (store_id, key)
);

CREATE TABLE IF NOT EXISTS queue_groups (
  id           INTEGER PRIMARY KEY,
  store_id     INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  prefix       TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  min_pax      INTEGER NOT NULL,
  max_pax      INTEGER NOT NULL,
  start_number INTEGER NOT NULL DEFAULT 1,
  last_seq     INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (store_id, prefix)
);

CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  store_id   INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  sms_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id            INTEGER PRIMARY KEY,
  store_id      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS queues (
  id              TEXT PRIMARY KEY,
  store_id        INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  group_id        INTEGER NOT NULL REFERENCES queue_groups(id),
  queue_session   INTEGER NOT NULL,
  business_date   TEXT NOT NULL,
  queue_number    TEXT NOT NULL,
  queue_prefix    TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  pax             INTEGER NOT NULL,
  customer_id     TEXT REFERENCES customers(id),
  customer_name   TEXT NOT NULL DEFAULT '',
  customer_phone  TEXT NOT NULL DEFAULT '',
  sms_opt_in      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','called','seated','completed','cancelled','no_show')),
  tracking_token  TEXT NOT NULL UNIQUE,
  request_id      TEXT UNIQUE,
  source          TEXT NOT NULL DEFAULT 'kiosk',
  created_at      INTEGER NOT NULL,
  called_at       INTEGER,
  last_called_at  INTEGER,
  call_count      INTEGER NOT NULL DEFAULT 0,
  called_by       INTEGER REFERENCES staff(id),
  seated_at       INTEGER,
  completed_at    INTEGER,
  cancelled_at    INTEGER,
  no_show_at      INTEGER,
  sms_called_sent_at INTEGER,
  sms_near_sent_at   INTEGER,
  UNIQUE (store_id, queue_session, queue_number)
);
CREATE INDEX IF NOT EXISTS idx_queues_store_status ON queues(store_id, status);
CREATE INDEX IF NOT EXISTS idx_queues_store_created ON queues(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_queues_group_status ON queues(group_id, status);

CREATE TABLE IF NOT EXISTS queue_events (
  id          INTEGER PRIMARY KEY,
  queue_id    TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  store_id    INTEGER NOT NULL,
  event       TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  staff_id    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_events_queue ON queue_events(queue_id);

CREATE TABLE IF NOT EXISTS display_devices (
  id           TEXT PRIMARY KEY,
  store_id     INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT NOT NULL DEFAULT '',
  paired_at    INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id             INTEGER PRIMARY KEY,
  store_id       INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  created_by     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER,
  used_by_device TEXT
);
CREATE INDEX IF NOT EXISTS idx_pairing_code ON pairing_codes(code);

CREATE TABLE IF NOT EXISTS printer_settings (
  store_id        INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  connection_type TEXT NOT NULL DEFAULT 'browser'
                  CHECK (connection_type IN ('usb','lan','wifi','bluetooth','serial','printer_number','browser')),
  paper_width     INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58,80)),
  ip              TEXT NOT NULL DEFAULT '',
  port            INTEGER NOT NULL DEFAULT 9100,
  printer_number  TEXT NOT NULL DEFAULT '',
  device_label    TEXT NOT NULL DEFAULT '',
  auto_print      INTEGER NOT NULL DEFAULT 1,
  copies          INTEGER NOT NULL DEFAULT 1,
  cut_paper       INTEGER NOT NULL DEFAULT 1,
  agent_key       TEXT NOT NULL,
  last_status     TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at INTEGER,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS print_agents (
  store_id       INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  printer_number TEXT NOT NULL,
  info           TEXT NOT NULL DEFAULT '',
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (store_id, printer_number)
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id             TEXT PRIMARY KEY,
  store_id       INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  queue_id       TEXT REFERENCES queues(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'ticket',
  transport      TEXT NOT NULL,
  printer_number TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','printing','printed','failed')),
  payload        TEXT,
  error          TEXT NOT NULL DEFAULT '',
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  printed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_store ON print_jobs(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_print_jobs_pending ON print_jobs(store_id, status, printer_number);

CREATE TABLE IF NOT EXISTS promotion_images (
  id         INTEGER PRIMARY KEY,
  store_id   INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_logs (
  id         INTEGER PRIMARY KEY,
  store_id   INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  queue_id   TEXT REFERENCES queues(id) ON DELETE SET NULL,
  phone      TEXT NOT NULL,
  message    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'called',
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

db.exec(SCHEMA);

const DEFAULT_STORE_ID = 1;

function seed() {
  const now = Date.now();
  const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(DEFAULT_STORE_ID);
  if (!store) {
    db.prepare(`INSERT INTO stores (id, name, logo_url, welcome_text, theme_color, created_at, updated_at)
                VALUES (?, ?, '', ?, '#E4572E', ?, ?)`)
      .run(DEFAULT_STORE_ID, 'ร้านอาหารของฉัน', 'ยินดีต้อนรับ กรุณากดรับบัตรคิว', now, now);
  }
  const groupCount = db.prepare('SELECT COUNT(*) c FROM queue_groups WHERE store_id = ?').get(DEFAULT_STORE_ID).c;
  if (!groupCount) {
    const ins = db.prepare(`INSERT INTO queue_groups (store_id, prefix, name, min_pax, max_pax, start_number, sort_order)
                            VALUES (?, ?, ?, ?, ?, 1, ?)`);
    [['A', '1 ท่าน', 1, 1], ['B', '2–4 ท่าน', 2, 4], ['C', '5–6 ท่าน', 5, 6], ['D', '7–12 ท่าน', 7, 12]]
      .forEach(([p, n, min, max], i) => ins.run(DEFAULT_STORE_ID, p, n, min, max, i));
  }
  const printer = db.prepare('SELECT store_id FROM printer_settings WHERE store_id = ?').get(DEFAULT_STORE_ID);
  if (!printer) {
    const key = require('crypto').randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO printer_settings (store_id, agent_key, updated_at) VALUES (?, ?, ?)')
      .run(DEFAULT_STORE_ID, key, now);
  }
}
seed();

module.exports = { db, DEFAULT_STORE_ID, DATA_DIR };
