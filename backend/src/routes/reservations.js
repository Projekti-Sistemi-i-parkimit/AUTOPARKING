"use strict";

const { Router } = require("express");
const { HttpError } = require("../middleware/errors");
const { hashToken } = require("../lib/tokens");

// QR-ja e rezervimit: një URL e vetme me token unik (capability URL).
// - Token-i NUK ruhet kurrë në server — vetëm hash-i i tij; pa token
//   (p.sh. me ID numerike) nuk hapet asnjë informacion rezervimi.
// - Skanimi (GET) kurrë nuk e ndryshon rezervimin — check-in/check-out
//   janë POST të veçanta, të autorizuara nga vetë token-i i QR-së.
module.exports = function reservationRoutes(db, parking, hub) {
  const router = Router();

  function findByToken(token) {
    if (!/^rt_[A-Za-z0-9_-]{10,100}$/.test(String(token))) {
      throw new HttpError(404, "Kodi QR nuk njihet");
    }
    parking.expireReservations();
    const r = db
      .prepare(
        `SELECT r.*, s.spot_key, s.sector, s.label FROM reservations r
         JOIN spots s ON s.id = r.spot_id WHERE r.qr_token_hash = ?`
      )
      .get(hashToken(token));
    if (!r) throw new HttpError(404, "Kodi QR nuk njihet ose është i pavlefshëm");
    return r;
  }

  // Targa maskohet në faqen publike të QR-së (kapaciteti i URL-së mund të
  // përcillet — mos ekspozo targën e plotë): "01-234-AB" → "01-•••-AB"
  function maskPlate(p) {
    const parts = String(p).split("-");
    if (parts.length < 2) return p[0] + "•••";
    return [parts[0], ...parts.slice(1, -1).map((x) => "•".repeat(x.length)), parts.at(-1)].join("-");
  }

  function view(r) {
    const now = Date.now();
    return {
      key: r.spot_key,
      sector: r.sector,
      label: r.label,
      status: r.status, // reserved | active | completed | cancelled | expired
      starts_at: r.starts_at,
      until: r.until, // null = pa orar daljeje
      checked_in_at: r.checked_in_at,
      checked_out_at: r.checked_out_at,
      name: r.visitor_name,
      plate_masked: maskPlate(r.plate),
      // Kohëzgjatja REALE: aktive → deri tani; e përfunduar → in → out
      duration_s:
        r.checked_in_at != null
          ? Math.round(((r.checked_out_at ?? now) - r.checked_in_at) / 1000)
          : null,
    };
  }

  // GET /api/reservation/:token — faqja e rezervimit (skanimi i QR-së).
  // Vetëm lexon: skanimi i përsëritur hap të njëjtin rezervim, pa efekte.
  router.get("/reservation/:token", (req, res) => {
    res.json(view(findByToken(req.params.token)));
  });

  // POST /api/reservation/:token/checkin — hyrja REALE në parking.
  // Lejohet vetëm për rezervim "reserved", nga 15 min para orës së fillimit.
  router.post("/reservation/:token/checkin", (req, res) => {
    const r = findByToken(req.params.token);
    const now = Date.now();
    if (r.status === "active") throw new HttpError(409, "Jeni tashmë brenda (check-in i kryer)");
    if (r.status !== "reserved") {
      throw new HttpError(409, `Rezervimi është "${r.status}" — nuk mund të bëhet check-in`);
    }
    if (now < r.starts_at - 15 * 60_000) {
      throw new HttpError(409, "Ende herët — check-in hapet 15 minuta para orës së rezervimit");
    }
    const spot = db
      .prepare("SELECT st.status FROM spot_status st WHERE st.spot_id = ?")
      .get(r.spot_id);
    if (spot.status === "occupied") {
      throw new HttpError(409, "Vendi rezulton i zënë — kontakto stafin ose zgjidh vend tjetër");
    }
    // Zënia reale kalon nëpër logjikën qendrore: hapet qëndrimi me emrin e
    // rezervuesit dhe rezervimi kalon në "active" me kohën reale të hyrjes.
    parking.ingest([{ key: r.spot_key, status: "occupied" }], { recordReadings: false });
    res.json(view(findByToken(req.params.token)));
  });

  // POST /api/reservation/:token/checkout — dalja REALE nga parkingu.
  router.post("/reservation/:token/checkout", (req, res) => {
    const r = findByToken(req.params.token);
    if (r.status === "completed") throw new HttpError(409, "Parkimi është përfunduar tashmë");
    if (r.status !== "active") {
      throw new HttpError(409, `Rezervimi është "${r.status}" — s'ka parkim aktiv për të përfunduar`);
    }
    // Lirimi real: mbyllet qëndrimi dhe rezervimi kalon "completed" me kohën
    // reale të daljes (services/parking.js → syncSession).
    parking.ingest([{ key: r.spot_key, status: "free" }], { recordReadings: false });
    hub.broadcast("reservation", { key: r.spot_key, action: "completed" });
    res.json(view(findByToken(req.params.token)));
  });

  return router;
};
