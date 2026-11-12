"use strict";

const { Router } = require("express");
const { HttpError } = require("../middleware/errors");
const { requireVisitor } = require("../middleware/auth");
const { generateToken, hashToken } = require("../lib/tokens");
const { requireString, optionalNumber } = require("../lib/validate");

// Rrugët e vizitorëve — ruajnë kontratën ekzistuese të frontend-it:
// POST /api/login, POST /api/reserve, DELETE /api/reserve/:key
module.exports = function visitorRoutes(db, parking, hub) {
  const router = Router();

  // POST /api/login  { name, plate } → { token }
  router.post("/login", (req, res) => {
    const name = requireString((req.body || {}).name, "name", { max: 30 });
    const plate = requireString(req.body.plate, "plate", { max: 15 }).toUpperCase();
    const token = generateToken("vt_");
    db.prepare("INSERT INTO visitor_tokens (token_hash, name, plate) VALUES (?, ?, ?)").run(
      hashToken(token), name, plate
    );
    res.status(201).json({ token, name, plate });
  });

  // POST /api/reserve  { key, end } (Bearer token i vizitorit)
  router.post("/reserve", requireVisitor(db), (req, res) => {
    const key = requireString((req.body || {}).key, "key", { max: 20 });
    const end = optionalNumber(req.body.end, "end");
    if (!end) throw new HttpError(400, 'Fusha "end" (epoch ms) është e detyrueshme');
    if (end <= Date.now()) throw new HttpError(400, "Ora e përfundimit duhet të jetë në të ardhmen");

    const spot = db
      .prepare(
        `SELECT s.id, s.has_sensor, st.status FROM spots s JOIN spot_status st ON st.spot_id = s.id
         WHERE s.spot_key = ?`
      )
      .get(key);
    if (!spot) throw new HttpError(404, `Vendi "${key}" nuk ekziston`);
    // Arkitektura hibride: Sektori A është prototip fizik (Arduino) vetëm për
    // demonstrime — rezervimet online bëhen vetëm në sektorët B dhe C.
    if (spot.has_sensor) {
      throw new HttpError(403, "Sektori A është prototip fizik demonstrimi — rezervo një vend në sektorët B ose C");
    }
    if (spot.status === "occupied") throw new HttpError(409, "Vendi është i zënë");

    parking.expireReservations();
    const existing = db.prepare("SELECT plate FROM reservations WHERE spot_id = ?").get(spot.id);
    if (existing && existing.plate !== req.visitor.plate) {
      throw new HttpError(409, "Vendi është i rezervuar nga dikush tjetër");
    }

    db.transaction(() => {
      // Një vizitor mund të ketë vetëm një rezervim aktiv.
      db.prepare("DELETE FROM reservations WHERE plate = ?").run(req.visitor.plate);
      db.prepare(
        "INSERT INTO reservations (spot_id, visitor_name, plate, created_at, until) VALUES (?, ?, ?, ?, ?)"
      ).run(spot.id, req.visitor.name, req.visitor.plate, Date.now(), end);
    })();

    hub.broadcast("reservation", { key, action: "created" });
    res.status(201).json({ ok: true, key, end });
  });

  // DELETE /api/reserve/:key — anulon rezervimin e vet
  router.delete("/reserve/:key", requireVisitor(db), (req, res) => {
    const spot = db.prepare("SELECT id FROM spots WHERE spot_key = ?").get(req.params.key);
    if (!spot) throw new HttpError(404, `Vendi "${req.params.key}" nuk ekziston`);
    const r = db.prepare("SELECT id, plate FROM reservations WHERE spot_id = ?").get(spot.id);
    if (!r) throw new HttpError(404, "Nuk ka rezervim për këtë vend");
    if (r.plate !== req.visitor.plate) {
      throw new HttpError(403, "Mund të anuloni vetëm rezervimin tuaj");
    }
    db.prepare("DELETE FROM reservations WHERE id = ?").run(r.id);
    hub.broadcast("reservation", { key: req.params.key, action: "cancelled" });
    res.json({ ok: true });
  });

  return router;
};