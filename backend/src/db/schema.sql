PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- =====================================================================
-- SKEMA "PARKING" — pronar: Erdi (koordino para çdo ndryshimi)
-- Identifikuesi stabil ndërmjet komponentëve është spots.spot_key
-- në formatin "<sektor>-<etiketë>", p.sh. "A-P1".
-- =====================================================================

CREATE TABLE IF NOT EXISTS spots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_key    TEXT NOT NULL UNIQUE,
  sector      TEXT NOT NULL,
  label       TEXT NOT NULL,
  has_sensor  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Gjendja aktuale e çdo vendi (një rresht për vend).
CREATE TABLE IF NOT EXISTS spot_status (
  spot_id     INTEGER PRIMARY KEY REFERENCES spots(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('free','occupied','unknown')),
  distance_cm REAL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historiku i matjeve nga sensorët.
CREATE TABLE IF NOT EXISTS sensor_readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id     INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  distance_cm REAL,
  status      TEXT NOT NULL CHECK (status IN ('free','occupied','unknown')),
  sensor_ok   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_readings_spot ON sensor_readings(spot_id, id DESC);

-- Qëndrimet në parking (hapen kur vendi zihet, mbyllen kur lirohet).
CREATE TABLE IF NOT EXISTS parking_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id       INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  visitor_name  TEXT NOT NULL DEFAULT 'Vizitor',
  plate         TEXT NOT NULL DEFAULT '-',
  started_at    INTEGER NOT NULL,            -- epoch ms (përputhet me frontend-in)
  planned_until INTEGER,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_open ON parking_sessions(spot_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS reservations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id       INTEGER NOT NULL UNIQUE REFERENCES spots(id) ON DELETE CASCADE,
  visitor_name  TEXT NOT NULL,
  plate         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,            -- epoch ms
  until         INTEGER NOT NULL             -- epoch ms
);

-- Ngjarjet e hyrjes/daljes nga parkingu.
CREATE TABLE IF NOT EXISTS gate_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('entry','exit')),
  plate       TEXT,
  source      TEXT NOT NULL DEFAULT 'bridge',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Gjendja aktuale e barrierës (një rresht i vetëm, id = 1).
CREATE TABLE IF NOT EXISTS barrier_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  status      TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('open','closed','error')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO barrier_state (id, status) VALUES (1, 'closed');

CREATE TABLE IF NOT EXISTS barrier_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  status      TEXT NOT NULL CHECK (status IN ('open','closed','error')),
  reason      TEXT,
  source      TEXT NOT NULL DEFAULT 'bridge',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =====================================================================
-- SKEMA "QR" — pronare: Isra (koordino para çdo ndryshimi)
-- =====================================================================

CREATE TABLE IF NOT EXISTS qr_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id     INTEGER NOT NULL UNIQUE REFERENCES spots(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,          -- vlera e koduar në QR (fillimisht = spot_key)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skanimet e QR ("Gjeje veturën time"): ruan ku ka parkuar një targë.
CREATE TABLE IF NOT EXISTS qr_scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id     INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  plate       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qr_scans_plate ON qr_scans(plate, id DESC);

-- =====================================================================
-- SKEMA "AUTH" — pronar: Emir
-- =====================================================================

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,               -- scrypt: salt:hash (hex)
  role          TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','operator')),
  last_login    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Çelësat API për urën e Arduino-s. Ruhet VETËM hash-i SHA-256, kurrë çelësi i plotë.
CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  details       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sesionet e adminëve (token-i ruhet vetëm si hash).
CREATE TABLE IF NOT EXISTS admin_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Token-ët e vizitorëve (hyrja e thjeshtë emër + targë nga frontend-i).
CREATE TABLE IF NOT EXISTS visitor_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  plate       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);