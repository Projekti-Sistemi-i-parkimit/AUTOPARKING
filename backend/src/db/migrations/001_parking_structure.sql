-- =====================================================================
-- 001 — Struktura e parkingut (D1): sektorët, katet, sensorët, parametrat
-- Pronar: Erdi. spot_key mbetet në formatin e ekipit "<sektor>-<etiketë>" (p.sh. A-P1),
-- ndërsa kati ruhet si e dhënë (floor_id) — asnjë komponent tjetër nuk prishet.
-- =====================================================================

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

-- Vendet: kati, rreshti, numri, burimi i të dhënave dhe aktiv/joaktiv.
ALTER TABLE spots ADD COLUMN floor_id  INTEGER REFERENCES floors(id) ON DELETE RESTRICT;
ALTER TABLE spots ADD COLUMN row_label TEXT CHECK (row_label IS NULL OR length(row_label) <= 8);
ALTER TABLE spots ADD COLUMN number    INTEGER CHECK (number IS NULL OR number > 0);
ALTER TABLE spots ADD COLUMN source    TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('sensor', 'demo', 'manual'));
ALTER TABLE spots ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
CREATE INDEX idx_spots_sector ON spots(sector);
CREATE INDEX idx_spots_floor  ON spots(floor_id);

-- Sensorët HC-SR04: 6 për vendet e Sektorit A + 1 te hyrja (pinat nga firmware-i i Erblinit).
-- last_seen_at / last_ok_at përditësohen nga trigger-i i leximeve (migrimi 002);
-- "online" llogaritet gjatë leximit me parametrin sensor_timeout_s.
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

-- Parametrat e sistemit (pragu, timeout, ruajtja). Vlera ruhet si tekst numerik.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT
);

-- ---------- Plotësimi i të dhënave ekzistuese ----------
INSERT INTO sectors (code, name, is_demo, sort_order)
SELECT sector,
       'Sektori ' || sector,
       CASE WHEN MAX(has_sensor) = 1 THEN 0 ELSE 1 END,
       ROW_NUMBER() OVER (ORDER BY sector)
FROM spots
GROUP BY sector;

INSERT INTO floors (sector_id, code, name, level)
SELECT id, 'F0', CASE WHEN is_demo = 0 THEN 'Maketa (sensorë live)' ELSE 'Përdhesa' END, 0
FROM sectors;

UPDATE spots SET
  floor_id = (SELECT f.id FROM floors f JOIN sectors s ON s.id = f.sector_id
              WHERE s.code = spots.sector AND f.code = 'F0'),
  number   = CASE WHEN label GLOB 'P[0-9]*' THEN CAST(substr(label, 2) AS INTEGER) END,
  source   = CASE WHEN has_sensor = 1 THEN 'sensor' ELSE 'demo' END;

-- Rreshtat sipas maketës: A ka 2 rreshta me nga 3 vende, B me nga 6, C me nga 10.
UPDATE spots SET row_label = 'R' || ((number - 1) / CASE sector WHEN 'A' THEN 3 WHEN 'B' THEN 6 ELSE 10 END + 1)
WHERE number IS NOT NULL;

INSERT INTO sensors (code, kind, spot_id, trig_pin, echo_pin)
SELECT 'S' || number, 'spot', id, 'D' || (number * 2), 'D' || (number * 2 + 1)
FROM spots
WHERE has_sensor = 1 AND number BETWEEN 1 AND 6;

INSERT INTO sensors (code, kind, spot_id, trig_pin, echo_pin) VALUES ('S7', 'entrance', NULL, 'A0', 'A1');

-- ---------- Rregullat e integritetit ----------

-- Çdo vend i ri ka gjendje (unknown) — edhe kur krijohet nga paneli.
CREATE TRIGGER spots_create_status AFTER INSERT ON spots
BEGIN
  INSERT OR IGNORE INTO spot_status (spot_id, status) VALUES (NEW.id, 'unknown');
END;

-- Vendet që shton seed-i i backend-it (pa kat) lidhen automatikisht me katin e parë të sektorit.
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

-- spot_key është i printuar në QR: nuk ndryshohet kurrë (krijo vend të ri, çaktivizo të vjetrin).
CREATE TRIGGER spots_key_immutable BEFORE UPDATE OF spot_key ON spots
WHEN NEW.spot_key IS NOT OLD.spot_key
BEGIN
  SELECT RAISE(ABORT, 'spot_key nuk mund të ndryshohet (është në kodin QR)');
END;

-- Kati i një vendi duhet t'i përkasë të njëjtit sektor.
CREATE TRIGGER spots_floor_sector_insert BEFORE INSERT ON spots
WHEN NEW.floor_id IS NOT NULL AND NEW.sector IS NOT
  (SELECT s.code FROM floors f JOIN sectors s ON s.id = f.sector_id WHERE f.id = NEW.floor_id)
BEGIN
  SELECT RAISE(ABORT, 'Kati nuk i përket sektorit të vendit');
END;

CREATE TRIGGER spots_floor_sector_update BEFORE UPDATE OF floor_id, sector ON spots
WHEN NEW.floor_id IS NOT NULL AND NEW.sector IS NOT
  (SELECT s.code FROM floors f JOIN sectors s ON s.id = f.sector_id WHERE f.id = NEW.floor_id)
BEGIN
  SELECT RAISE(ABORT, 'Kati nuk i përket sektorit të vendit');
END;
