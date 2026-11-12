-- =====================================================================
-- 003 — Hyrja/dalja dhe historiku (D2, D3). Pronar: Erdi.
-- gate_events dhe barrier_events (rrugët e Erblinit) mbeten siç janë; këtu shtohen
-- indekset për raportet, një pamje e përbashkët e ngjarjeve të hyrjes dhe historiku
-- i rezervimeve (rezervimi fshihet nga parking.js kur vetura arrin ose kur skadon).
-- =====================================================================

CREATE INDEX idx_gate_events_time    ON gate_events(created_at);
CREATE INDEX idx_barrier_events_time ON barrier_events(created_at);
CREATE INDEX idx_sessions_started    ON parking_sessions(started_at);
CREATE INDEX idx_sessions_spot       ON parking_sessions(spot_id, started_at);

-- Pamja e vetme e ngjarjeve te hyrja: sensori S7 (entry/exit) + barriera (open/closed/error).
CREATE VIEW entrance_events AS
  SELECT 'gate' AS kind, id, type AS event, plate, NULL AS reason, source, created_at FROM gate_events
  UNION ALL
  SELECT 'barrier' AS kind, id, status AS event, NULL AS plate, reason, source, created_at FROM barrier_events;

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
CREATE INDEX idx_reservation_history_time ON reservation_history(closed_at);

-- fulfilled: u hap një qëndrim me të njëjtën targë në atë vend (parking.js e fut qëndrimin
-- para se ta fshijë rezervimin); expired: koha kaloi; ndryshe: anuluar.
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

-- Qëndrimi nuk mund të mbarojë para se të fillojë.
CREATE TRIGGER sessions_valid_range BEFORE UPDATE OF ended_at ON parking_sessions
WHEN NEW.ended_at IS NOT NULL AND NEW.ended_at < NEW.started_at
BEGIN
  SELECT RAISE(ABORT, 'ended_at nuk mund të jetë para started_at');
END;

CREATE TRIGGER reservations_valid_range BEFORE INSERT ON reservations
WHEN NEW.until <= NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Rezervimi duhet të mbarojë pas krijimit');
END;
