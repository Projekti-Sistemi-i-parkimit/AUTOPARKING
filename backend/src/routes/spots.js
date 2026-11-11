"use strict";

const { Router } = require("express");
const { HttpError } = require("../middleware/errors");
const { pagination, paginated, optionalEnum } = require("../lib/validate");

// Lexim publik: vendet e parkimit, sensorët, statistikat dhe fotografia e gjendjes.
// Këto janë edhe "read-only endpoints" për integrimet opsionale të asistentëve (M4).
module.exports = function spotsRoutes(db, parking) {
  const router = Router();

  // GET /api/spots?sector=A&status=free&page=1&limit=50
  router.get("/spots", (req, res) => {
    const sector = req.query.sector || null;
    const status = optionalEnum(req.query.status, "status", ["free", "occupied", "unknown"]);
    const pg = pagination(req.query);
    const where = [];
    const params = [];
    if (sector) { where.push("s.sector = ?"); params.push(sector); }
    if (status) { where.push("st.status = ?"); params.push(status); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM spots s JOIN spot_status st ON st.spot_id = s.id ${whereSql}`)
      .get(...params).n;
    const rows = db
      .prepare(
        `SELECT s.spot_key, s.sector, s.label, s.has_sensor, st.status, st.distance_cm, st.updated_at
         FROM spots s JOIN spot_status st ON st.spot_id = s.id ${whereSql}
         ORDER BY s.sector, s.id LIMIT ? OFFSET ?`
      )
      .all(...params, pg.limit, pg.offset);
    res.json(paginated(rows, pg, total));
  });

  // GET /api/spots/:key — detajet e një vendi
  router.get("/spots/:key", (req, res) => {
    const row = db
      .prepare(
        `SELECT s.id, s.spot_key, s.sector, s.label, s.has_sensor, st.status, st.distance_cm, st.updated_at
         FROM spots s JOIN spot_status st ON st.spot_id = s.id WHERE s.spot_key = ?`
      )
      .get(req.params.key);
    if (!row) throw new HttpError(404, `Vendi "${req.params.key}" nuk ekziston`);
    const reservation = db
      .prepare("SELECT visitor_name AS name, plate, created_at AS start, until FROM reservations WHERE spot_id = ?")
      .get(row.id);
    const session = db
      .prepare(
        `SELECT visitor_name AS name, plate, started_at, planned_until
         FROM parking_sessions WHERE spot_id = ? AND ended_at IS NULL`
      )
      .get(row.id);
    const { id, ...spot } = row;
    res.json({ ...spot, reservation: reservation || null, active_session: session || null });
  });

  // GET /api/spots/:key/readings — historiku i matjeve (me faqëzim)
  router.get("/spots/:key/readings", (req, res) => {
    const spot = db.prepare("SELECT id FROM spots WHERE spot_key = ?").get(req.params.key);
    if (!spot) throw new HttpError(404, `Vendi "${req.params.key}" nuk ekziston`);
    const pg = pagination(req.query);
    const total = db.prepare("SELECT COUNT(*) AS n FROM sensor_readings WHERE spot_id = ?").get(spot.id).n;
    const rows = db
      .prepare(
        `SELECT distance_cm, status, sensor_ok, created_at FROM sensor_readings
         WHERE spot_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .all(spot.id, pg.limit, pg.offset);
    res.json(paginated(rows, pg, total));
  });

  // GET /api/sensors — gjendja e sensorëve (matja e fundit për çdo vend me sensor)
  router.get("/sensors", (req, res) => {
    const rows = db
      .prepare(
        `SELECT s.spot_key, st.status, st.distance_cm, st.updated_at,
                (SELECT sensor_ok FROM sensor_readings r WHERE r.spot_id = s.id ORDER BY r.id DESC LIMIT 1) AS sensor_ok,
                (SELECT created_at FROM sensor_readings r WHERE r.spot_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_reading_at
         FROM spots s JOIN spot_status st ON st.spot_id = s.id
         WHERE s.has_sensor = 1 ORDER BY s.spot_key`
      )
      .all();
    res.json({ data: rows.map((r) => ({ ...r, sensor_ok: r.sensor_ok == null ? null : !!r.sensor_ok })) });
  });

  // GET /api/stats?sector=A — statistikat e zënies
  router.get("/stats", (req, res) => {
    res.json(parking.stats(req.query.sector || null));
  });

  // GET /api/state — fotografia e plotë (formati që pret frontend-i ekzistues)
  router.get("/state", (req, res) => {
    res.json(parking.stateSnapshot());
  });

  return router;
};