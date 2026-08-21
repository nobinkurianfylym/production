PRAGMA foreign_keys = ON;
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, email)
);
CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE productions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  format        TEXT NOT NULL DEFAULT 'Feature',
  languages     TEXT NOT NULL DEFAULT '',
  currency      TEXT NOT NULL DEFAULT 'INR',
  territory     TEXT NOT NULL DEFAULT '',
  company       TEXT NOT NULL DEFAULT '',
  prep_start    TEXT,
  shoot_start   TEXT,
  shoot_end     TEXT,
  planned_days  INTEGER NOT NULL DEFAULT 0,
  day_length_hours INTEGER NOT NULL DEFAULT 12,
  mins_per_eighth   INTEGER NOT NULL DEFAULT 20,
  status        TEXT NOT NULL DEFAULT 'Prep',
  current_day_id TEXT,
  dp_target     INTEGER NOT NULL DEFAULT 24,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE production_members (
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN (
                  'producer','line_producer','first_ad','second_ad','director',
                  'dept_head','accountant','post_supervisor','crew','viewer'
                )),
  department    TEXT,
  PRIMARY KEY (production_id, user_id)
);
CREATE TABLE characters (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  cast_person_id TEXT,
  is_minor      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_characters_prod ON characters(production_id);
CREATE TABLE locations (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sets          TEXT NOT NULL DEFAULT '[]',
  address       TEXT DEFAULT '',
  lat           REAL, lng REAL,
  contact       TEXT DEFAULT '', phone TEXT DEFAULT '',
  rate          REAL NOT NULL DEFAULT 0,
  permit        TEXT NOT NULL DEFAULT 'Scouted'
                CHECK (permit IN ('Scouted','Shortlisted','Applied','Granted','Released')),
  permit_expiry TEXT,
  hospital      TEXT DEFAULT '',
  notes         TEXT DEFAULT ''
);
CREATE INDEX idx_locations_prod ON locations(production_id);
CREATE TABLE scenes (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  no            TEXT NOT NULL,
  int_ext       TEXT NOT NULL CHECK (int_ext IN ('INT','EXT')),
  set_name      TEXT NOT NULL,
  dn            TEXT NOT NULL CHECK (dn IN ('DAY','NIGHT','DAWN','DUSK')),
  eighths       INTEGER NOT NULL DEFAULT 1,
  story_day     INTEGER NOT NULL DEFAULT 1,
  loc_id        TEXT REFERENCES locations(id) ON DELETE SET NULL,
  synopsis      TEXT DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_scenes_prod ON scenes(production_id);
CREATE TABLE scene_cast (
  scene_id      TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY (scene_id, character_id)
);
CREATE TABLE elements (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  name          TEXT NOT NULL,
  department    TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'To source'
                CHECK (status IN ('To source','Ordered','Received','Ready','Returned')),
  est_cost      REAL NOT NULL DEFAULT 0,
  actual_cost   REAL NOT NULL DEFAULT 0,
  vendor        TEXT DEFAULT ''
);
CREATE INDEX idx_elements_prod ON elements(production_id);
CREATE TABLE element_scenes (
  element_id  TEXT NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
  scene_id    TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  PRIMARY KEY (element_id, scene_id)
);
CREATE TABLE people (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('cast','crew')),
  department    TEXT DEFAULT '',
  role          TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  email         TEXT DEFAULT '',
  rate          REAL NOT NULL DEFAULT 0,
  rate_basis    TEXT NOT NULL DEFAULT 'day' CHECK (rate_basis IN ('day','week','flat')),
  start_date    TEXT, end_date TEXT
);
CREATE INDEX idx_people_prod ON people(production_id);
CREATE TABLE shooting_days (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  n             INTEGER NOT NULL,
  date          TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'Main',
  loc_id        TEXT REFERENCES locations(id) ON DELETE SET NULL,
  call_time     TEXT, shoot_call TEXT, wrap_time TEXT,
  status        TEXT NOT NULL DEFAULT 'Planned'
                CHECK (status IN ('Planned','Shooting','Completed')),
  UNIQUE (production_id, n)
);
CREATE INDEX idx_days_prod ON shooting_days(production_id);
CREATE TABLE day_strips (
  day_id      TEXT NOT NULL REFERENCES shooting_days(id) ON DELETE CASCADE,
  scene_id    TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_id, scene_id),
  UNIQUE (scene_id)
);
CREATE TABLE call_sheets (
  day_id        TEXT PRIMARY KEY REFERENCES shooting_days(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 1,
  published_at  TEXT,
  published_by  TEXT REFERENCES users(id),
  notes         TEXT DEFAULT '',
  safety        TEXT DEFAULT ''
);
CREATE TABLE call_sheet_ack (
  day_id      TEXT NOT NULL REFERENCES call_sheets(day_id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ack_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day_id, person_id)
);
CREATE TABLE dprs (
  day_id          TEXT PRIMARY KEY REFERENCES shooting_days(id) ON DELETE CASCADE,
  planned_eighths INTEGER NOT NULL DEFAULT 0,
  eighths_shot    INTEGER NOT NULL DEFAULT 0,
  setups          INTEGER NOT NULL DEFAULT 0,
  first_shot      TEXT, lunch TEXT, wrap_time TEXT,
  approved        INTEGER NOT NULL DEFAULT 0,
  approved_by     TEXT REFERENCES users(id),
  approved_at     TEXT
);
CREATE TABLE dpr_scenes (
  day_id    TEXT NOT NULL REFERENCES dprs(day_id) ON DELETE CASCADE,
  scene_id  TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  result    TEXT NOT NULL CHECK (result IN ('done','part')),
  PRIMARY KEY (day_id, scene_id)
);
CREATE TABLE delays (
  id        TEXT PRIMARY KEY,
  day_id    TEXT NOT NULL REFERENCES dprs(day_id) ON DELETE CASCADE,
  reason    TEXT NOT NULL,
  mins      INTEGER NOT NULL,
  note      TEXT DEFAULT ''
);
CREATE TABLE incidents (
  id        TEXT PRIMARY KEY,
  day_id    TEXT NOT NULL REFERENCES dprs(day_id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  note      TEXT DEFAULT '',
  severity  TEXT DEFAULT 'Low'
);
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('ATL','BTL','POST','OTHER')),
  name          TEXT NOT NULL,
  UNIQUE (production_id, code)
);
CREATE INDEX idx_accounts_prod ON accounts(production_id);
CREATE TABLE budget_lines (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 1,
  unit        TEXT NOT NULL DEFAULT 'flat',
  rate        REAL NOT NULL DEFAULT 0,
  fringe      REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_budget_lines_acc ON budget_lines(account_id);
CREATE TABLE purchase_orders (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  no            TEXT NOT NULL,
  vendor        TEXT NOT NULL,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  amount        REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Submitted'
                CHECK (status IN ('Draft','Submitted','Approved','Rejected','Closed')),
  raised_by     TEXT REFERENCES users(id),
  approved_by   TEXT REFERENCES users(id),
  date          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  UNIQUE (production_id, no)
);
CREATE INDEX idx_po_prod ON purchase_orders(production_id);
CREATE INDEX idx_po_account ON purchase_orders(account_id);
CREATE TABLE expenses (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  description   TEXT NOT NULL,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  department    TEXT DEFAULT '',
  amount        REAL NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'Petty cash',
  status        TEXT NOT NULL DEFAULT 'Submitted'
                CHECK (status IN ('Submitted','Approved','Rejected')),
  submitted_by  TEXT REFERENCES users(id),
  approved_by   TEXT REFERENCES users(id)
);
CREATE INDEX idx_expenses_prod ON expenses(production_id);
CREATE INDEX idx_expenses_account ON expenses(account_id);
CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  ts            TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id      TEXT REFERENCES users(id),
  actor_name    TEXT NOT NULL,
  action        TEXT NOT NULL,
  object        TEXT NOT NULL,
  detail        TEXT DEFAULT ''
);
CREATE INDEX idx_audit_prod_ts ON audit_log(production_id, ts DESC);
