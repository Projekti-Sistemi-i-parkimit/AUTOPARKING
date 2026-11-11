"use strict";

const { Router } = require("express");
const { pagination, paginated, optionalEnum } = require("../lib/validate");

// Lexim publik i ngjarjeve të hyrjes/daljes dhe gjendjes së barrierës.
module.exports = function eventsRoutes(db) {
  const router = Router();

  // GET /api/events?type=entry&page=1&limit=50
  router.get("/events", (req, res) => {
    const type = optionalEnum(req.query.type, "type", ["entry", "exit"]);
    const pg = pagination(req.query);
    const whereSql = type ? "WHERE type = ?" : "";
    const params = type ? [type] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM gate_events ${whereSql}`).get(...params).n;
    const rows = db
      .prepare(`SELECT id, type, plate, source, created_at FROM gate_events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pg.limit, pg.offset);
    res.json(paginated(rows, pg, total));
  });

  // GET /api/barrier — gjendja aktuale
  router.get("/barrier", (req, res) => {
    res.json(db.prepare("SELECT status, updated_at FROM barrier_state WHERE id = 1").get());
  });

  // GET /api/barrier/events?page=1&limit=50
  router.get("/barrier/events", (req, res) => {
    const pg = pagination(req.query);
    const total = db.prepare("SELECT COUNT(*) AS n FROM barrier_events").get().n;
    const rows = db
      .prepare("SELECT id, status, reason, source, created_at FROM barrier_events ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(pg.limit, pg.offset);
    res.json(paginated(rows, pg, total));
  });

  return router;
};