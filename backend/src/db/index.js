"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Arkitektura HIBRIDE e sektorëve:
// - Sektori A: prototipi FIZIK me Arduino + HC-SR04 (vetëm demonstrime).
//   Statusi vjen nga sensorët; pa sinjal = "unknown" (offline).
// - Sektorët B dhe C: parking ONLINE — menaxhohen nga aplikacioni/backend-i
//   (rezervime + statuse manuale nga admini), PA asnjë varësi nga hardueri.
//   Gjendja fillestare e tyre është "free" (parking bosh i sapo-konfiguruar).
const SECTORS = {
  A: { spots: ["P1", "P2", "P3", "P4", "P5", "P6"], hasSensor: true },
  B: { spots: Array.from({ length: 12 }, (_, i) => `P${i + 1}`), hasSensor: false },
  C: { spots: Array.from({ length: 20 }, (_, i) => `P${i + 1}`), hasSensor: false },
};

function createDb(dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Migrimi para skemës: skema e re ka indekse mbi kolona që tabelat e
  // vjetra s'i kanë ende — rindërtimi duhet të ndodhë i pari.
  migrate(db);
  db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  seedSpots(db);
  return db;
}

// Migrime idempotente për databazat ekzistuese (CREATE TABLE IF NOT EXISTS
// nuk i shton kolonat e reja në tabelat e vjetra).
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(admin_users)").all().map((c) => c.name);
  if (cols.length && !cols.includes("must_change_password")) {
    db.exec("ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  }

  // Rezervimet: skema e vjetër (spot_id UNIQUE, until NOT NULL, pa statuse)
  // rindërtohet duke RUAJTUR të gjitha rreshtat ekzistues. Rreshtat e vjetër
  // marrin starts_at = created_at dhe status 'reserved'.
  const resCols = db.prepare("PRAGMA table_info(reservations)").all().map((c) => c.name);
  if (resCols.length && !resCols.includes("starts_at")) {
    db.exec(`
      BEGIN;
      CREATE TABLE reservations_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        spot_id        INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
        visitor_name   TEXT NOT NULL,
        plate          TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        starts_at      INTEGER NOT NULL,
        until          INTEGER,
        status         TEXT NOT NULL DEFAULT 'reserved'
                       CHECK (status IN ('reserved','active','completed','cancelled','expired')),
        qr_token_hash  TEXT UNIQUE,
        checked_in_at  INTEGER,
        checked_out_at INTEGER
      );
      INSERT INTO reservations_new (id, spot_id, visitor_name, plate, created_at, starts_at, until)
        SELECT id, spot_id, visitor_name, plate, created_at, created_at, until FROM reservations;
      DROP TABLE reservations;
      ALTER TABLE reservations_new RENAME TO reservations;
      CREATE INDEX IF NOT EXISTS idx_res_spot ON reservations(spot_id, status);
      CREATE INDEX IF NOT EXISTS idx_res_plate ON reservations(plate, status);
      COMMIT;
    `);
  }
}

// Krijon vendet, gjendjet fillestare dhe kodet QR nëse mungojnë (idempotente).
function seedSpots(db) {
  const insertSpot = db.prepare(
    "INSERT OR IGNORE INTO spots (spot_key, sector, label, has_sensor) VALUES (?, ?, ?, ?)"
  );
  // Vendet me sensor nisin "unknown" (derisa të flasë Arduino); vendet online
  // nisin "free" — ato s'kanë sensorë dhe menaxhohen nga aplikacioni.
  const insertStatus = db.prepare(
    `INSERT OR IGNORE INTO spot_status (spot_id, status)
     SELECT id, CASE WHEN has_sensor = 1 THEN 'unknown' ELSE 'free' END
     FROM spots WHERE spot_key = ?`
  );
  const insertQr = db.prepare(
    "INSERT OR IGNORE INTO qr_codes (spot_id, code) SELECT id, spot_key FROM spots WHERE spot_key = ?"
  );
  db.transaction(() => {
    for (const [sector, def] of Object.entries(SECTORS)) {
      for (const label of def.spots) {
        const key = `${sector}-${label}`;
        insertSpot.run(key, sector, label, def.hasSensor ? 1 : 0);
        insertStatus.run(key);
        insertQr.run(key);
      }
    }
    // Migrim idempotent për databazat ekzistuese: sektorët online nuk mund
    // të jenë "pa sinjal" — ata s'kanë sensorë. "unknown" i trashëguar → "free".
    db.prepare(
      `UPDATE spot_status SET status = 'free', updated_at = datetime('now')
       WHERE status = 'unknown'
         AND spot_id IN (SELECT id FROM spots WHERE has_sensor = 0)`
    ).run();
  })();
}

module.exports = { createDb, SECTORS };