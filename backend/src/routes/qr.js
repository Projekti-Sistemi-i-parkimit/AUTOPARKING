"use strict";

const { Router } = require("express");
const { HttpError } = require("../middleware/errors");
const { requireString } = require("../lib/validate");

// Integrimi me QR (skema e Isra-s): informacioni i QR-së për çdo vend,
// regjistrimi i skanimeve dhe "Gjeje veturën time".
module.exports = function qrRoutes(db, hub) {
  const router = Router();

  // GET /api/qr/find?plate=01-234-AB — vendi i fundit ku ka parkuar targa
  // (para /:key që të mos kapet "find" si çelës vendi)
  router.get("/qr/find", (req, res) => {
    const plate = requireString(req.query.plate, "plate", { max: 15 }).toUpperCase();
    const row = db
      .prepare(
        `SELECT s.spot_key, s.sector, s.label, q.created_at AS scanned_at, st.status
         FROM qr_scans q JOIN spots s ON s.id = q.spot_id
         JOIN spot_status st ON st.spot_id = s.id
         WHERE q.plate = ? ORDER BY q.id DESC LIMIT 1`
      )
      .get(plate);
    if (!row) throw new HttpError(404, `Asnjë skanim i regjistruar për targën "${plate}"`);
    res.json(row);
  });

  // GET /api/qr/:key — informacioni i QR-së për një vend
  router.get("/qr/:key", (req, res) => {
    const row = db
      .prepare(
        `SELECT s.spot_key, s.sector, s.label, q.code, st.status
         FROM qr_codes q JOIN spots s ON s.id = q.spot_id
         JOIN spot_status st ON st.spot_id = s.id WHERE s.spot_key = ?`
      )
      .get(req.params.key);
    if (!row) throw new HttpError(404, `Vendi "${req.params.key}" nuk ekziston`);
    res.json(row);
  });

  // POST /api/qr/scan  { code, plate } — skanohet QR-ja e vendit ku u parkua
  router.post("/qr/scan", (req, res) => {
    const code = requireString((req.body || {}).code, "code", { max: 100 });
    const plate = requireString(req.body.plate, "plate", { max: 15 }).toUpperCase();
    const spot = db
      .prepare(
        `SELECT s.id, s.spot_key FROM qr_codes q JOIN spots s ON s.id = q.spot_id
         WHERE q.code = ? OR s.spot_key = ?`
      )
      .get(code, code);
    if (!spot) throw new HttpError(404, `Kodi QR "${code}" nuk njihet`);
    db.prepare("INSERT INTO qr_scans (spot_id, plate) VALUES (?, ?)").run(spot.id, plate);
    hub.broadcast("qr_scan", { key: spot.spot_key, plate });
    res.status(201).json({ ok: true, key: spot.spot_key, plate });
  });

  return router;
};