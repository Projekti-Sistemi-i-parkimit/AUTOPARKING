"use strict";

const { Router } = require("express");
const { HttpError } = require("../middleware/errors");
const { requireApiKey } = require("../middleware/auth");
const { requireEnum, requireString, optionalNumber } = require("../lib/validate");

// Rrugët e urës së Arduino-s — të gjitha kërkojnë çelës API (header x-api-key).
// POST /api/sensor ruan formatin që përdor tashmë frontend-i (Web Serial bridge).
module.exports = function bridgeRoutes(db, parking, hub) {
  const router = Router();
  // KUJDES: çelësi API kërkohet vetëm për rrugët e urës — jo me router.use(),
  // sepse ai do të bllokonte edhe rrugët e router-ëve të mëpasshëm nën /api.
  const apiKey = requireApiKey(db);

  // POST /api/sensor  { spots: [{ key, status?, cm?, sensor_ok? }] }
  router.post("/sensor", apiKey, (req, res) => {
    const { spots } = req.body || {};
    if (!Array.isArray(spots) || spots.length === 0) {
      throw new HttpError(400, 'Trupi duhet të ketë "spots" si listë jo bosh');
    }
    if (spots.length > 500) throw new HttpError(400, "Maksimumi 500 vende për kërkesë");
    const known = [];
    const unknownKeys = [];
    for (const s of spots) {
      const key = requireString(s && s.key, "key", { max: 20 });
      if (!db.prepare("SELECT 1 FROM spots WHERE spot_key = ?").get(key)) {
        unknownKeys.push(key);
        continue;
      }
      known.push({
        key,
        cm: optionalNumber(s.cm, "cm", { min: -1, max: 1000 }),
        sensor_ok: s.sensor_ok,
        status: s.status == null ? null : requireEnum(s.status, "status", ["free", "occupied", "unknown"]),
      });
    }
    const changes = parking.ingest(known);
    res.json({ ok: true, applied: known.length, changed: changes.length, unknown_keys: unknownKeys });
  });

  // POST /api/events  { type: "entry"|"exit", plate? }
  router.post("/events", apiKey, (req, res) => {
    const type = requireEnum((req.body || {}).type, "type", ["entry", "exit"]);
    const plate = req.body.plate ? requireString(req.body.plate, "plate", { max: 15 }) : null;
    const info = db
      .prepare("INSERT INTO gate_events (type, plate, source) VALUES (?, ?, ?)")
      .run(type, plate, req.apiKey.name);
    const event = { id: info.lastInsertRowid, type, plate, source: req.apiKey.name };
    hub.broadcast("gate_event", event);
    res.status(201).json(event);
  });

  // POST /api/barrier  { status: "open"|"closed"|"error", reason? }
  router.post("/barrier", apiKey, (req, res) => {
    const status = requireEnum((req.body || {}).status, "status", ["open", "closed", "error"]);
    const reason = req.body.reason ? requireString(req.body.reason, "reason", { max: 200 }) : null;
    const current = db.prepare("SELECT status FROM barrier_state WHERE id = 1").get();
    db.prepare("UPDATE barrier_state SET status = ?, updated_at = datetime('now') WHERE id = 1").run(status);
    db.prepare("INSERT INTO barrier_events (status, reason, source) VALUES (?, ?, ?)").run(
      status, reason, req.apiKey.name
    );
    if (current.status !== status) {
      hub.broadcast("barrier_update", { status, reason }, "barrier");
    }
    res.json({ ok: true, status, changed: current.status !== status });
  });

  return router;
};