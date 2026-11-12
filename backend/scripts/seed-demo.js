"use strict";

// Të dhëna DEMO (D4) për sektorët pa sensorë (is_demo = 1), që dashboard-i dhe raportet
// të kenë histori realiste. Sektori A (sensorët live) NUK preket kurrë.
//
//   npm run seed:demo                       → 14 ditë për B dhe C
//   npm run seed:demo -- --days 30 --with-d → edhe Sektori D me dy kate (F0, F1)
//   npm run seed:demo -- --clear            → vetëm fshin të dhënat DEMO
//
// Gjeneratori është determinist (--seed), që rezultatet të përsëriten në prezantim.
// Çdo ekzekutim fshin së pari të dhënat DEMO të mëparshme, pra mund të rinisë pa dublikime.

const config = require("../src/config");
const { createDb } = require("../src/db");

function args(argv) {
  const out = { days: 14, seed: 42, withD: false, clear: false, db: config.dbPath };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a === "--db") out.db = argv[++i];
    else if (a === "--with-d") out.withD = true;
    else if (a === "--clear") out.clear = true;
    else throw new Error(`Argument i panjohur: ${a}`);
  }
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 92) throw new Error("--days duhet 1–92");
  return out;
}

// mulberry32 — PRNG i vogël dhe determinist.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ardhjet për orë në një qendër tregtare (08–22): pik në drekë dhe pas punës, më shumë në fundjavë.
const HOURLY = [0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0.5, 0.7, 0.85, 1, 0.95, 0.8, 0.75, 0.85, 1, 0.95, 0.75, 0.5, 0.3, 0, 0];

const PLATE_LETTERS = "ABCDEFHJKLMNPRSTUVXZ";
function plate(r) {
  const n = () => Math.floor(r() * 10);
  const l = () => PLATE_LETTERS[Math.floor(r() * PLATE_LETTERS.length)];
  return `0${1 + Math.floor(r() * 7)}-${n()}${n()}${n()}-${l()}${l()}`;
}

function ensureSectorD(db) {
  const exists = db.prepare("SELECT id FROM sectors WHERE code = 'D'").get();
  if (exists) return false;
  db.transaction(() => {
    const id = db
      .prepare("INSERT INTO sectors (code, name, is_demo, sort_order) VALUES ('D', 'Sektori D (garazh)', 1, 4)")
      .run().lastInsertRowid;
    const f0 = db.prepare("INSERT INTO floors (sector_id, code, name, level, sort_order) VALUES (?, 'F0', 'Përdhesa', 0, 0)").run(id).lastInsertRowid;
    const f1 = db.prepare("INSERT INTO floors (sector_id, code, name, level, sort_order) VALUES (?, 'F1', 'Kati 1', 1, 1)").run(id).lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO spots (spot_key, sector, label, has_sensor, floor_id, row_label, number, source)
       VALUES (?, 'D', ?, 0, ?, ?, ?, 'demo')`
    );
    const qr = db.prepare("INSERT OR IGNORE INTO qr_codes (spot_id, code) VALUES (?, ?)");
    for (let n = 1; n <= 16; n++) {
      const floor = n <= 8 ? f0 : f1;
      const label = `P${n}`;
      const sid = ins.run(`D-${label}`, label, floor, `R${Math.ceil(((n - 1) % 8 + 1) / 4)}`, n).lastInsertRowid;
      qr.run(sid, `D-${label}`);
    }
  })();
  return true;
}

function clearDemo(db) {
  const spotIds = "(SELECT s.id FROM spots s JOIN sectors sec ON sec.code = s.sector WHERE sec.is_demo = 1)";
  return db.transaction(() => ({
    sessions: db.prepare(`DELETE FROM parking_sessions WHERE spot_id IN ${spotIds}`).run().changes,
    status_events: db.prepare(`DELETE FROM status_events WHERE spot_id IN ${spotIds}`).run().changes,
    gate_events: db.prepare("DELETE FROM gate_events WHERE source = 'demo'").run().changes,
    reservation_history: db.prepare(`DELETE FROM reservation_history WHERE spot_id IN ${spotIds}`).run().changes,
  }))();
}

function seedDemo(db, { days = 14, seed = 42, withD = false, now = Date.now() } = {}) {
  const r = rng(seed);
  const createdD = withD ? ensureSectorD(db) : false;
  const cleared = clearDemo(db);
  const spots = db
    .prepare(
      `SELECT s.id, s.spot_key FROM spots s JOIN sectors sec ON sec.code = s.sector
       WHERE sec.is_demo = 1 AND s.has_sensor = 0 AND s.is_active = 1 ORDER BY s.id`
    )
    .all();
  if (!spots.length) return { createdD, cleared, spots: 0, sessions: 0, gate_events: 0 };

  const insSession = db.prepare(
    "INSERT INTO parking_sessions (spot_id, visitor_name, plate, started_at, planned_until, ended_at) VALUES (?, 'Vizitor DEMO', ?, ?, NULL, ?)"
  );
  const insEvent = db.prepare(
    "INSERT INTO status_events (spot_id, from_status, to_status, distance_cm, created_at) VALUES (?, ?, ?, NULL, ?)"
  );
  const insGate = db.prepare("INSERT INTO gate_events (type, plate, source, created_at) VALUES (?, ?, 'demo', ?)");
  const setStatus = db.prepare("UPDATE spot_status SET status = ?, distance_cm = NULL, updated_at = datetime('now') WHERE spot_id = ?");
  const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

  let sessions = 0;
  let gates = 0;
  db.transaction(() => {
    const start = now - days * 86400_000;
    for (const spot of spots) {
      let t = start;
      let state = "free";
      while (t < now) {
        const d = new Date(t);
        const hour = (d.getUTCHours() + 1) % 24; // ~ ora lokale (CET)
        const weekend = [0, 6].includes(d.getUTCDay());
        const p = HOURLY[hour] * (weekend ? 1.25 : 1);
        if (p === 0 || r() > p * 0.55) { t += 15 * 60_000 + Math.floor(r() * 20 * 60_000); continue; }
        // Kohëzgjatja: kryesisht 25–150 min, ndonjëherë më gjatë (log-normal i përafërt).
        const minutes = Math.round(Math.exp(Math.log(55) + (r() + r() + r() - 1.5) * 0.9));
        const begin = t;
        const end = begin + Math.max(10, minutes) * 60_000;
        const pl = plate(r);
        const open = end > now;
        insSession.run(spot.id, pl, begin, open ? null : end);
        insEvent.run(spot.id, state, "occupied", begin);
        insGate.run("entry", pl, sqlTime(begin - 60_000));
        gates++;
        state = "occupied";
        if (!open) {
          insEvent.run(spot.id, "occupied", "free", end);
          insGate.run("exit", pl, sqlTime(end + 60_000));
          gates++;
          state = "free";
        }
        sessions++;
        t = end + 5 * 60_000 + Math.floor(r() * 45 * 60_000);
      }
      // Gjendja aktuale e vendit DEMO = gjendja në fund të historisë. Trigger-i i statusit
      // shkruan një ngjarje "tani"; e heqim se historia tashmë e ka kalimin e saktë.
      const before = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM status_events").get().id;
      setStatus.run(state, spot.id);
      db.prepare("DELETE FROM status_events WHERE id > ?").run(before);
    }
  })();
  return { createdD, cleared, spots: spots.length, sessions, gate_events: gates, days, seed };
}

if (require.main === module) {
  const opts = args(process.argv.slice(2));
  const db = createDb(opts.db);
  if (opts.clear) {
    console.log("Të dhënat DEMO u fshinë:", clearDemo(db));
  } else {
    const out = seedDemo(db, opts);
    console.log(
      `✔ DEMO: ${out.sessions} qëndrime dhe ${out.gate_events} ngjarje hyrjeje në ${out.spots} vende ` +
        `(${out.days} ditë, seed ${out.seed})${out.createdD ? " — u krijua Sektori D" : ""}`
    );
  }
  db.close();
}

module.exports = { seedDemo, clearDemo, ensureSectorD, rng };
