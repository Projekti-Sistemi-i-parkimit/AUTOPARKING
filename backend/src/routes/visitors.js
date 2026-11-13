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

  // Politikat (përputhen me services/parking.js):
  const OPEN_HOLD_MS = 24 * 3600_000; // rezervimi pa orar bllokon deri 24h për disponueshmërinë
  const MAX_FUTURE_MS = 7 * 24 * 3600_000; // rezervohet deri 7 ditë përpara
  const MAX_PER_PLATE = 3; // rezervime në pritje/aktive për një targë

  // POST /api/reserve  (Bearer token i vizitorit)
  //   Mënyra A: { key, start?, end }        — me orar daljeje
  //   Mënyra B: { key, start?, open_ended } — "nuk e di ende kur do të dal"
  //   start mungon = tani. Kontrata e vjetër { key, end } mbetet e vlefshme.
  router.post("/reserve", requireVisitor(db), (req, res) => {
    const key = requireString((req.body || {}).key, "key", { max: 20 });
    const now = Date.now();
    const start = optionalNumber(req.body.start, "start") || now;
    const openEnded = !!req.body.open_ended;
    const end = openEnded ? null : optionalNumber(req.body.end, "end");

    if (!openEnded && !end) {
      throw new HttpError(400, 'Jep orën e daljes ("end") ose zgjidh "open_ended" (pa orar daljeje)');
    }
    if (start < now - 60_000) throw new HttpError(400, "Ora e fillimit nuk mund të jetë në të kaluarën");
    if (start > now + MAX_FUTURE_MS) throw new HttpError(400, "Rezervimet pranohen deri 7 ditë përpara");
    if (end !== null) {
      if (end <= start) throw new HttpError(400, "Ora e daljes duhet të jetë pas orës së hyrjes");
      if (end <= now) throw new HttpError(400, "Ora e përfundimit duhet të jetë në të ardhmen");
    }

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
    // Rezervim që fillon tani: vendi duhet të jetë fizikisht i lirë.
    if (start <= now && spot.status === "occupied") throw new HttpError(409, "Vendi është i zënë");

    parking.expireReservations();

    // Intervali efektiv i bllokimit (pa orar → deri 24h nga fillimi)
    const effEnd = end !== null ? end : start + OPEN_HOLD_MS;

    // E gjithë verifikimi + regjistrimi në NJË transaksion — kërkesat paralele
    // nuk mund të krijojnë mbivendosje (better-sqlite3 është serial + atomik).
    const token = generateToken("rt_");
    const result = db.transaction(() => {
      // Mbivendosja me rezervime të tjera të të njëjtit vend:
      // ato pa orar ende pa check-in bllokojnë [starts_at, starts_at+24h];
      // ato aktive (vetura brenda) bllokojnë deri në check-out real (pafund).
      const conflict = db
        .prepare(
          `SELECT 1 FROM reservations
           WHERE spot_id = ? AND status IN ('reserved','active')
             AND starts_at < ?
             AND CASE
                   WHEN status = 'active' AND until IS NULL THEN 1
                   ELSE COALESCE(until, starts_at + ?) > ?
                 END
           LIMIT 1`
        )
        .get(spot.id, effEnd, OPEN_HOLD_MS, start);
      if (conflict) return { error: new HttpError(409, "Vendi është i rezervuar për këtë interval — zgjidh orar ose vend tjetër") };

      const mine = db
        .prepare("SELECT COUNT(*) AS n FROM reservations WHERE plate = ? AND status IN ('reserved','active')")
        .get(req.visitor.plate).n;
      if (mine >= MAX_PER_PLATE) {
        return { error: new HttpError(409, `Keni tashmë ${mine} rezervime në fuqi — anuloni një para se të shtoni të ri`) };
      }

      const info = db
        .prepare(
          `INSERT INTO reservations (spot_id, visitor_name, plate, created_at, starts_at, until, status, qr_token_hash)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`
        )
        .run(spot.id, req.visitor.name, req.visitor.plate, now, start, end, hashToken(token));
      return { id: info.lastInsertRowid };
    })();
    if (result.error) throw result.error;

    hub.broadcast("reservation", { key, action: "created" });
    // Token-i kthehet VETËM këtu, një herë — në databazë ruhet vetëm hash-i.
    res.status(201).json({
      ok: true,
      key,
      start,
      end,
      open_ended: openEnded,
      status: "reserved",
      token,
      qr_path: `/#/r/${token}`,
    });
  });

  // DELETE /api/reserve/:key — anulon rezervimin e vet në pritje për këtë vend.
  // Rezervimi aktiv (vetura brenda) nuk anulohet — përfundohet me check-out.
  router.delete("/reserve/:key", requireVisitor(db), (req, res) => {
    const spot = db.prepare("SELECT id FROM spots WHERE spot_key = ?").get(req.params.key);
    if (!spot) throw new HttpError(404, `Vendi "${req.params.key}" nuk ekziston`);
    const r = db
      .prepare(
        `SELECT id, plate FROM reservations WHERE spot_id = ? AND status = 'reserved'
         ORDER BY starts_at LIMIT 1`
      )
      .get(spot.id);
    if (!r) throw new HttpError(404, "Nuk ka rezervim në pritje për këtë vend");
    if (r.plate !== req.visitor.plate) {
      throw new HttpError(403, "Mund të anuloni vetëm rezervimin tuaj");
    }
    db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(r.id);
    hub.broadcast("reservation", { key: req.params.key, action: "cancelled" });
    res.json({ ok: true });
  });

  // GET /api/my/reservations — rezervimet e vizitorit të kyçur (pa token-ë QR;
  // ata u kthyen vetëm një herë në krijim dhe i mban pajisja e vizitorit)
  router.get("/my/reservations", requireVisitor(db), (req, res) => {
    parking.expireReservations();
    const rows = db
      .prepare(
        `SELECT s.spot_key AS key, s.sector, s.label, r.starts_at, r.until, r.status,
                r.checked_in_at, r.checked_out_at
         FROM reservations r JOIN spots s ON s.id = r.spot_id
         WHERE r.plate = ? ORDER BY r.id DESC LIMIT 20`
      )
      .all(req.visitor.plate);
    res.json({ data: rows });
  });

  return router;
};