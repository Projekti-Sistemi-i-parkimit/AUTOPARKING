-- GJENERUAR AUTOMATIKISHT nga `npm run db:snapshot` — mos e ndrysho me dorë.
-- Skema e plotë pas schema.sql + migrimeve. Rishikohet në çdo PR që e ndryshon (D7).
-- migrim: 001_parking_structure.sql sha256:8f7923f058686566
-- migrim: 002_readings_policy.sql sha256:5da84ab4bc896380
-- migrim: 003_entrance_and_history.sql sha256:88f8e219d619a8e1

-- table: admin_sessions
CREATE TABLE admin_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: admin_users
CREATE TABLE admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,               -- scrypt: salt:hash (hex)
  role          TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','operator')),
  last_login    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: api_keys
CREATE TABLE api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- table: audit_log
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  details       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: barrier_events
CREATE TABLE barrier_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  status      TEXT NOT NULL CHECK (status IN ('open','closed','error')),
  reason      TEXT,
  source      TEXT NOT NULL DEFAULT 'bridge',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: barrier_state
CREATE TABLE barrier_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  status      TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('open','closed','error')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: floors
CREATE TABLE floors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sector_id   INTEGER NOT NULL REFERENCES sectors(id) ON DELETE RESTRICT,
  code        TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 8 AND code NOT GLOB '*[^A-Z0-9]*'),
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  level       INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN -10 AND 50),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sector_id, code)
);

-- table: gate_events
CREATE TABLE gate_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('entry','exit')),
  plate       TEXT,
  source      TEXT NOT NULL DEFAULT 'bridge',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: parking_sessions
CREATE TABLE parking_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id       INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  visitor_name  TEXT NOT NULL DEFAULT 'Vizitor',
  plate         TEXT NOT NULL DEFAULT '-',
  started_at    INTEGER NOT NULL,            -- epoch ms (përputhet me frontend-in)
  planned_until INTEGER,
  ended_at      INTEGER
);

-- table: qr_codes
CREATE TABLE qr_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id     INTEGER NOT NULL UNIQUE REFERENCES spots(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,          -- vlera e koduar në QR (fillimisht = spot_key)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: qr_scans
CREATE TABLE qr_scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id     INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  plate       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: reservation_history
CREATE TABLE reservation_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id  INTEGER NOT NULL,
  spot_id         INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  visitor_name    TEXT NOT NULL,
  plate           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  until           INTEGER NOT NULL,
  closed_at       INTEGER NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('fulfilled', 'expired', 'cancelled'))
);

-- table: reservations
CREATE TABLE reservations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id       INTEGER NOT NULL UNIQUE REFERENCES spots(id) ON DELETE CASCADE,
  visitor_name  TEXT NOT NULL,
  plate         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,            -- epoch ms
  until         INTEGER NOT NULL             -- epoch ms
);

-- table: schema_migrations
CREATE TABLE schema_migrations (
    name       TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

-- table: sectors
CREATE TABLE sectors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE
              CHECK (length(code) BETWEEN 1 AND 4 AND code NOT GLOB '*[^A-Z]*'),
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: sensor_readings
CREATE TABLE sensor_readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id     INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  distance_cm REAL,
  status      TEXT NOT NULL CHECK (status IN ('free','occupied','unknown')),
  sensor_ok   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
, kind TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change', 'sample')));

-- table: sensors
CREATE TABLE sensors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('spot', 'entrance')),
  spot_id      INTEGER UNIQUE REFERENCES spots(id) ON DELETE RESTRICT,
  trig_pin     TEXT,
  echo_pin     TEXT,
  last_seen_at TEXT,
  last_ok_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((kind = 'entrance') = (spot_id IS NULL))
);

-- table: settings
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT
);

-- table: spot_status
CREATE TABLE spot_status (
  spot_id     INTEGER PRIMARY KEY REFERENCES spots(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('free','occupied','unknown')),
  distance_cm REAL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- table: spots
CREATE TABLE spots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_key    TEXT NOT NULL UNIQUE,
  sector      TEXT NOT NULL,
  label       TEXT NOT NULL,
  has_sensor  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
, floor_id  INTEGER REFERENCES floors(id) ON DELETE RESTRICT, row_label TEXT CHECK (row_label IS NULL OR length(row_label) <= 8), number    INTEGER CHECK (number IS NULL OR number > 0), source    TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('sensor', 'demo', 'manual')), is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)));

-- table: status_events
CREATE TABLE status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id     INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL CHECK (to_status IN ('free', 'occupied', 'unknown')),
  distance_cm REAL,
  created_at  INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);

-- table: visitor_tokens
CREATE TABLE visitor_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  plate       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- index: idx_barrier_events_time
CREATE INDEX idx_barrier_events_time ON barrier_events(created_at);

-- index: idx_gate_events_time
CREATE INDEX idx_gate_events_time    ON gate_events(created_at);

-- index: idx_qr_scans_plate
CREATE INDEX idx_qr_scans_plate ON qr_scans(plate, id DESC);

-- index: idx_readings_created
CREATE INDEX idx_readings_created ON sensor_readings(created_at);

-- index: idx_readings_spot
CREATE INDEX idx_readings_spot ON sensor_readings(spot_id, id DESC);

-- index: idx_reservation_history_time
CREATE INDEX idx_reservation_history_time ON reservation_history(closed_at);

-- index: idx_sessions_open
CREATE INDEX idx_sessions_open ON parking_sessions(spot_id) WHERE ended_at IS NULL;

-- index: idx_sessions_spot
CREATE INDEX idx_sessions_spot       ON parking_sessions(spot_id, started_at);

-- index: idx_sessions_started
CREATE INDEX idx_sessions_started    ON parking_sessions(started_at);

-- index: idx_spots_floor
CREATE INDEX idx_spots_floor  ON spots(floor_id);

-- index: idx_spots_sector
CREATE INDEX idx_spots_sector ON spots(sector);

-- index: idx_status_events_spot_time
CREATE INDEX idx_status_events_spot_time ON status_events(spot_id, created_at);

-- index: idx_status_events_time
CREATE INDEX idx_status_events_time      ON status_events(created_at);

-- view: entrance_events
CREATE VIEW entrance_events AS
  SELECT 'gate' AS kind, id, type AS event, plate, NULL AS reason, source, created_at FROM gate_events
  UNION ALL
  SELECT 'barrier' AS kind, id, status AS event, NULL AS plate, reason, source, created_at FROM barrier_events;

-- trigger: readings_mark_sample
CREATE TRIGGER readings_mark_sample AFTER INSERT ON sensor_readings
WHEN EXISTS (
  SELECT 1 FROM sensor_readings p
  WHERE p.spot_id = NEW.spot_id AND p.id < NEW.id
    AND p.id = (SELECT MAX(id) FROM sensor_readings WHERE spot_id = NEW.spot_id AND id < NEW.id)
    AND p.status = NEW.status AND p.sensor_ok = NEW.sensor_ok
    AND ((p.distance_cm IS NULL AND NEW.distance_cm IS NULL)
         OR abs(p.distance_cm - NEW.distance_cm)
            <= CAST((SELECT value FROM settings WHERE key = 'tolerance_cm') AS REAL))
)
BEGIN
  UPDATE sensor_readings SET kind = 'sample' WHERE id = NEW.id;
END;

-- trigger: readings_policy
CREATE TRIGGER readings_policy BEFORE INSERT ON sensor_readings
BEGIN
  UPDATE sensors SET
    last_seen_at = datetime('now'),
    last_ok_at   = CASE WHEN NEW.sensor_ok = 1 THEN datetime('now') ELSE last_ok_at END
  WHERE spot_id = NEW.spot_id;

  SELECT RAISE(IGNORE)
  FROM (SELECT * FROM sensor_readings WHERE spot_id = NEW.spot_id ORDER BY id DESC LIMIT 1) AS last
  WHERE last.status = NEW.status
    AND last.sensor_ok = NEW.sensor_ok
    AND (
      (last.distance_cm IS NULL AND NEW.distance_cm IS NULL)
      OR abs(last.distance_cm - NEW.distance_cm)
         <= CAST((SELECT value FROM settings WHERE key = 'tolerance_cm') AS REAL)
    )
    AND (julianday(COALESCE(NEW.created_at, datetime('now'))) - julianday(last.created_at)) * 86400
        < CAST((SELECT value FROM settings WHERE key = 'sample_interval_s') AS REAL);
END;

-- trigger: reservations_archive
CREATE TRIGGER reservations_archive AFTER DELETE ON reservations
BEGIN
  INSERT INTO reservation_history
    (reservation_id, spot_id, visitor_name, plate, created_at, until, closed_at, outcome)
  VALUES (
    OLD.id, OLD.spot_id, OLD.visitor_name, OLD.plate, OLD.created_at, OLD.until,
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
    CASE
      WHEN EXISTS (SELECT 1 FROM parking_sessions
                   WHERE spot_id = OLD.spot_id AND ended_at IS NULL AND plate = OLD.plate)
        THEN 'fulfilled'
      WHEN OLD.until < CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        THEN 'expired'
      ELSE 'cancelled'
    END
  );
END;

-- trigger: reservations_valid_range
CREATE TRIGGER reservations_valid_range BEFORE INSERT ON reservations
WHEN NEW.until <= NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Rezervimi duhet të mbarojë pas krijimit');
END;

-- trigger: sessions_valid_range
CREATE TRIGGER sessions_valid_range BEFORE UPDATE OF ended_at ON parking_sessions
WHEN NEW.ended_at IS NOT NULL AND NEW.ended_at < NEW.started_at
BEGIN
  SELECT RAISE(ABORT, 'ended_at nuk mund të jetë para started_at');
END;

-- trigger: spot_status_log
CREATE TRIGGER spot_status_log AFTER UPDATE OF status ON spot_status
WHEN NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO status_events (spot_id, from_status, to_status, distance_cm)
  VALUES (NEW.spot_id, OLD.status, NEW.status, NEW.distance_cm);
END;

-- trigger: spots_assign_floor
CREATE TRIGGER spots_assign_floor AFTER INSERT ON spots WHEN NEW.floor_id IS NULL
BEGIN
  INSERT OR IGNORE INTO sectors (code, name, is_demo, sort_order)
  VALUES (NEW.sector, 'Sektori ' || NEW.sector, CASE WHEN NEW.has_sensor = 1 THEN 0 ELSE 1 END,
          (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sectors));
  INSERT OR IGNORE INTO floors (sector_id, code, name, level)
  SELECT id, 'F0', 'Përdhesa', 0 FROM sectors WHERE code = NEW.sector;
  UPDATE spots SET
    floor_id = (SELECT f.id FROM floors f JOIN sectors s ON s.id = f.sector_id
                WHERE s.code = NEW.sector ORDER BY f.sort_order, f.level, f.id LIMIT 1),
    number   = COALESCE(number, CASE WHEN NEW.label GLOB 'P[0-9]*' THEN CAST(substr(NEW.label, 2) AS INTEGER) END),
    source   = CASE WHEN NEW.has_sensor = 1 THEN 'sensor' ELSE source END
  WHERE id = NEW.id;
END;

-- trigger: spots_create_status
CREATE TRIGGER spots_create_status AFTER INSERT ON spots
BEGIN
  INSERT OR IGNORE INTO spot_status (spot_id, status) VALUES (NEW.id, 'unknown');
END;

-- trigger: spots_floor_sector_insert
CREATE TRIGGER spots_floor_sector_insert BEFORE INSERT ON spots
WHEN NEW.floor_id IS NOT NULL AND NEW.sector IS NOT
  (SELECT s.code FROM floors f JOIN sectors s ON s.id = f.sector_id WHERE f.id = NEW.floor_id)
BEGIN
  SELECT RAISE(ABORT, 'Kati nuk i përket sektorit të vendit');
END;

-- trigger: spots_floor_sector_update
CREATE TRIGGER spots_floor_sector_update BEFORE UPDATE OF floor_id, sector ON spots
WHEN NEW.floor_id IS NOT NULL AND NEW.sector IS NOT
  (SELECT s.code FROM floors f JOIN sectors s ON s.id = f.sector_id WHERE f.id = NEW.floor_id)
BEGIN
  SELECT RAISE(ABORT, 'Kati nuk i përket sektorit të vendit');
END;

-- trigger: spots_key_immutable
CREATE TRIGGER spots_key_immutable BEFORE UPDATE OF spot_key ON spots
WHEN NEW.spot_key IS NOT OLD.spot_key
BEGIN
  SELECT RAISE(ABORT, 'spot_key nuk mund të ndryshohet (është në kodin QR)');
END;
