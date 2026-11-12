-- =====================================================================
-- 002 — Politika e ruajtjes së leximeve (D2). Pronar: Erdi.
--
-- Arduino dërgon matje çdo ~500 ms; ruajtja e të gjithave mbush databazën pa vlerë.
-- Rregulli: një lexim ruhet vetëm kur
--   (a) ndryshon statusi ose sensor_ok, ose distanca lëviz më shumë se tolerance_cm, ose
--   (b) ka kaluar sample_interval_s nga leximi i fundit i ruajtur (mostër periodike).
-- Rreshti shënohet kind = 'change' ose 'sample'. Kodi i Emirit (parking.js) nuk ndryshon:
-- filtri është trigger BEFORE INSERT që e injoron rreshtin e tepërt (RAISE(IGNORE)).
-- Ndryshimet e statusit regjistrohen gjithmonë në status_events (për statistikat D3).
-- =====================================================================

ALTER TABLE sensor_readings ADD COLUMN kind TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change', 'sample'));
CREATE INDEX idx_readings_created ON sensor_readings(created_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('tolerance_cm',          '0.5'),
  ('sample_interval_s',     '300'),
  ('sensor_timeout_s',      '30'),
  ('retention_sample_days', '30'),
  ('retention_change_days', '180');

-- Çdo kalim free/occupied/unknown, me kohë në ms (si parking_sessions) për llogaritje të sakta.
CREATE TABLE status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id     INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL CHECK (to_status IN ('free', 'occupied', 'unknown')),
  distance_cm REAL,
  created_at  INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
CREATE INDEX idx_status_events_spot_time ON status_events(spot_id, created_at);
CREATE INDEX idx_status_events_time      ON status_events(created_at);

CREATE TRIGGER spot_status_log AFTER UPDATE OF status ON spot_status
WHEN NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO status_events (spot_id, from_status, to_status, distance_cm)
  VALUES (NEW.spot_id, OLD.status, NEW.status, NEW.distance_cm);
END;

-- Gjurmimi i sensorit: çdo matje e përditëson (edhe kur rreshti nuk ruhet).
-- Pastaj filtri: injoro matjen nëse është e njëjtë me të fundit brenda intervalit të mostrës.
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

-- Rreshti që kaloi filtrin pa ndryshim statusi/distance është mostër periodike.
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
