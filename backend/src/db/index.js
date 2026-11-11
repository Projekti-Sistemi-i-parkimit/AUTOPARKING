"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Sektorët dhe vendet — përputhen me hartën e frontend-it.
// Sektori A ka 6 vende me sensorë HC-SR04 (+1 sensor hyrjeje që s'është vend
// parkimi — shih docs/HARDWARE.md); B dhe C janë pjesë e maketës pa sensorë.
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
  db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  seedSpots(db);
  return db;
}

// Krijon vendet, gjendjet fillestare dhe kodet QR nëse mungojnë (idempotente).
function seedSpots(db) {
  const insertSpot = db.prepare(
    "INSERT OR IGNORE INTO spots (spot_key, sector, label, has_sensor) VALUES (?, ?, ?, ?)"
  );
  const insertStatus = db.prepare(
    "INSERT OR IGNORE INTO spot_status (spot_id, status) SELECT id, 'unknown' FROM spots WHERE spot_key = ?"
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
  })();
}

module.exports = { createDb, SECTORS };