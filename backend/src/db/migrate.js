"use strict";

// Migrimet e skemës "parking" (pronar: Erdi — D1, D7).
//
// schema.sql krijon tabelat bazë me "CREATE TABLE IF NOT EXISTS" për të gjithë ekipin.
// Çdo ndryshim i mëtejshëm i skemës parking bëhet me një skedar të ri të numëruar në
// migrations/ (p.sh. 004_emri.sql) — kurrë duke ndryshuar një migrim që është aplikuar.
// Secili migrim ekzekutohet një herë, brenda një transaksioni, dhe regjistrohet në
// schema_migrations. Kështu një databazë ekzistuese (backend/data/parking.db) dhe një
// e re arrijnë në të njëjtën skemë.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const FILE_RE = /^\d{3}_[a-z0-9_]+\.sql$/;

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort();
}

// Kontrollsumë e pavarur nga fundet e rreshtave (CRLF në Windows / LF në Git).
function checksum(sql) {
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

function runMigrations(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const done = new Map(db.prepare("SELECT name, checksum FROM schema_migrations").all().map((r) => [r.name, r.checksum]));
  const applied = [];
  for (const file of listMigrations(dir)) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const sum = checksum(sql);
    if (done.has(file)) {
      // D7: një migrim i aplikuar nuk ndryshohet — ndryshimi i ri shkon në një skedar të ri.
      if (done.get(file) !== sum) {
        throw new Error(`Migrimi ${file} është ndryshuar pasi u aplikua. Shto një migrim të ri në vend të tij.`);
      }
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)").run(file, sum);
    })();
    applied.push(file);
  }
  return applied;
}

module.exports = { runMigrations, listMigrations, checksum, MIGRATIONS_DIR };
