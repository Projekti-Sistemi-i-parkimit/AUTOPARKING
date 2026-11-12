"use strict";

// Logjika qendrore e parkimit: klasifikimi i matjeve, përditësimi i gjendjes,
// hapja/mbyllja automatike e qëndrimeve dhe skadimi i rezervimeve.
// Çdo ndryshim real shpërndahet te klientët përmes SSE (hub).

function createParkingService(db, config, hub) {
  const q = {
    spotByKey: db.prepare("SELECT * FROM spots WHERE spot_key = ?"),
    status: db.prepare("SELECT * FROM spot_status WHERE spot_id = ?"),
    setStatus: db.prepare(
      "UPDATE spot_status SET status = ?, distance_cm = ?, updated_at = datetime('now') WHERE spot_id = ?"
    ),
    insertReading: db.prepare(
      "INSERT INTO sensor_readings (spot_id, distance_cm, status, sensor_ok) VALUES (?, ?, ?, ?)"
    ),
    openSession: db.prepare(
      "SELECT * FROM parking_sessions WHERE spot_id = ? AND ended_at IS NULL"
    ),
    startSession: db.prepare(
      "INSERT INTO parking_sessions (spot_id, visitor_name, plate, started_at, planned_until) VALUES (?, ?, ?, ?, ?)"
    ),
    endSession: db.prepare("UPDATE parking_sessions SET ended_at = ? WHERE id = ?"),
    // Rezervimi që "mbulon" momentin aktual për një vend (reserved ose active)
    currentReservation: db.prepare(
      `SELECT * FROM reservations
       WHERE spot_id = ? AND status IN ('reserved','active')
         AND starts_at <= ? AND (until IS NULL OR until > ?)
       ORDER BY starts_at LIMIT 1`
    ),
    activateReservation: db.prepare(
      "UPDATE reservations SET status = 'active', checked_in_at = ? WHERE id = ? AND status = 'reserved'"
    ),
    completeReservation: db.prepare(
      `UPDATE reservations SET status = 'completed', checked_out_at = ?
       WHERE spot_id = ? AND status = 'active'`
    ),
    // Skadimi: me orar → kur kalon "until" pa check-in; pa orar → kur kalon
    // afati i paraqitjes (no-show) pa check-in. Statusi ruhet për faqen e QR-së.
    expireReservations: db.prepare(
      `UPDATE reservations SET status = 'expired'
       WHERE status = 'reserved'
         AND ((until IS NOT NULL AND until < ?) OR (until IS NULL AND starts_at + ? < ?))`
    ),
  };

  // Politikat e rezervimeve pa orar daljeje (që vendet të mos bllokohen pafund):
  // - NOSHOW_MS: pa check-in brenda 2 orësh nga fillimi → rezervimi skadon.
  // - OPEN_HOLD_MS: për llogaritjen e disponueshmërisë, një rezervim i hapur
  //   bllokon vendin deri 24 orë nga fillimi (pas check-in: deri në check-out).
  const RES_POLICY = { NOSHOW_MS: 2 * 3600_000, OPEN_HOLD_MS: 24 * 3600_000 };

  // Klasifikimi sipas README-së: ≤ prag = e zënë, ≤ rrezja max = e lirë, ndryshe e panjohur.
  function classify(cm, sensorOk) {
    if (!sensorOk || cm == null || cm < 0) return "unknown";
    if (cm <= config.occThresholdCm) return "occupied";
    if (cm <= config.maxRangeCm) return "free";
    return "unknown";
  }

  // Zbaton një listë matjesh/gjendjesh nga ura. Kthen ndryshimet reale.
  // Çdo element: { key, cm?, sensor_ok?, status? } — nëse mungon status,
  // ai llogaritet nga distanca.
  const applyReadings = db.transaction((items, { recordReadings = true } = {}) => {
    const changes = [];
    const now = Date.now();
    for (const item of items) {
      const spot = q.spotByKey.get(item.key);
      if (!spot) continue; // validimi i çelësave të panjohur bëhet në rrugë
      const sensorOk = item.sensor_ok !== undefined ? !!item.sensor_ok : item.cm != null;
      const cm = typeof item.cm === "number" ? item.cm : null;
      const status = item.status || classify(cm, sensorOk);

      if (recordReadings && spot.has_sensor) {
        q.insertReading.run(spot.id, cm, status, sensorOk ? 1 : 0);
      }

      const current = q.status.get(spot.id);
      if (current.status === status && current.distance_cm === cm) continue;
      const prevStatus = current.status;
      q.setStatus.run(status, cm, spot.id);
      syncSession(spot, prevStatus, status, now);
      changes.push({ key: spot.spot_key, status, cm, prev: prevStatus });
    }
    return changes;
  });

  // Hap qëndrim kur vendi zihet; e mbyll kur lirohet. "unknown" nuk e mbyll
  // (humbja e sinjalit nuk do të thotë se vetura iku). Rezervimi përkatës
  // kalon reserved → active (check-in real) dhe active → completed (check-out
  // real) — kohët REALE regjistrohen në checked_in_at / checked_out_at.
  function syncSession(spot, prevStatus, status, now) {
    const open = q.openSession.get(spot.id);
    if (status === "occupied" && !open) {
      const r = q.currentReservation.get(spot.id, now, now);
      q.startSession.run(
        spot.id,
        r ? r.visitor_name : "Vizitor",
        r ? r.plate : "-",
        now,
        r ? r.until : null
      );
      if (r && r.status === "reserved") q.activateReservation.run(now, r.id);
    } else if (open && status === "free") {
      q.endSession.run(now, open.id);
      q.completeReservation.run(now, spot.id);
    }
  }

  function expireReservations() {
    const now = Date.now();
    return q.expireReservations.run(now, RES_POLICY.NOSHOW_MS, now).changes;
  }

  // Sektori A (prototipi fizik): kur Arduino hesht më gjatë se pragu,
  // vendet me sensor shënohen "unknown" (OFFLINE) — kurrë nuk shpiken matje.
  // Prek VETËM vendet me sensor; sektorët online B/C nuk bëhen kurrë offline.
  function sweepOfflineSensors(thresholdS) {
    const stale = db
      .prepare(
        `SELECT s.spot_key FROM spots s JOIN spot_status st ON st.spot_id = s.id
         WHERE s.has_sensor = 1 AND st.status != 'unknown'
           AND COALESCE(
                 (SELECT MAX(created_at) FROM sensor_readings r WHERE r.spot_id = s.id),
                 '1970-01-01'
               ) < datetime('now', ?)`
      )
      .all(`-${Math.round(thresholdS)} seconds`);
    if (!stale.length) return [];
    return ingest(stale.map((r) => ({ key: r.spot_key, sensor_ok: false })));
  }

  // Statistikat për një sektor ose për gjithë parkingun.
  function stats(sector) {
    const where = sector ? "WHERE s.sector = ?" : "";
    const rows = db
      .prepare(
        `SELECT st.status, COUNT(*) AS n FROM spots s
         JOIN spot_status st ON st.spot_id = s.id ${where} GROUP BY st.status`
      )
      .all(...(sector ? [sector] : []));
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const total = (by.free || 0) + (by.occupied || 0) + (by.unknown || 0);
    const now = Date.now();
    const reserved = db
      .prepare(
        `SELECT COUNT(*) AS n FROM reservations r JOIN spots s ON s.id = r.spot_id
         WHERE r.status = 'reserved' AND r.starts_at <= ?
           AND (r.until IS NULL OR r.until > ?) ${sector ? "AND s.sector = ?" : ""}`
      )
      .get(now, now, ...(sector ? [sector] : [])).n;
    const known = (by.free || 0) + (by.occupied || 0);
    return {
      sector: sector || "all",
      total,
      free: by.free || 0,
      occupied: by.occupied || 0,
      unknown: by.unknown || 0,
      reserved,
      occupancy_pct: known ? Math.round(((by.occupied || 0) / known) * 100) : 0,
    };
  }

  // Fotografia e plotë e gjendjes në formatin që pret frontend-i ekzistues.
  function stateSnapshot() {
    expireReservations();
    const spots = {};
    for (const row of db
      .prepare(
        `SELECT s.spot_key, st.status, st.distance_cm FROM spots s
         JOIN spot_status st ON st.spot_id = s.id`
      )
      .all()) {
      spots[row.spot_key] = { status: row.status, cm: row.distance_cm };
    }
    // Vetëm rezervimet NË PRITJE (reserved) — përfshirë të ardhshmet, që
    // frontend-i të shfaqë "rezervimet e mia"; harta i trajton si "rezervuar"
    // vetëm ato me starts_at <= tani.
    const res = db
      .prepare(
        `SELECT s.spot_key AS key, r.visitor_name AS name, r.plate,
                r.starts_at AS start, r.until AS end, r.status
         FROM reservations r JOIN spots s ON s.id = r.spot_id
         WHERE r.status = 'reserved' AND (r.until IS NULL OR r.until > ?)`
      )
      .all(Date.now());
    const sessions = db
      .prepare(
        `SELECT s.spot_key AS key, p.visitor_name AS name, p.plate, p.started_at AS start,
                p.planned_until AS until, p.ended_at AS end
         FROM parking_sessions p JOIN spots s ON s.id = p.spot_id
         ORDER BY p.id DESC LIMIT 300`
      )
      .all();
    return { spots, res, sessions };
  }

  // Zbaton matjet dhe njofton klientët SSE vetëm për ndryshimet reale.
  function ingest(items, opts) {
    const changes = applyReadings(items, opts);
    for (const c of changes) {
      hub.broadcast("spot_update", c, c.key);
    }
    if (changes.length) {
      hub.broadcast("stats", stats(), "global");
    }
    return changes;
  }

  return { classify, ingest, applyReadings, expireReservations, sweepOfflineSensors, stats, stateSnapshot };
}

module.exports = { createParkingService };