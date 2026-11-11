"use strict";

// D7 — Fotografia e skemës. Çdo ndryshim i skemës (i çdo grupi) duhet të shfaqet në
// diff-in e PR-së si ndryshim i src/db/schema.snapshot.sql, që të rishikohet nga pronari.
//   npm run db:snapshot   → rishkruan fotografinë pas një migrimi të ri
// Testi tests/schema.test.js dështon nëse skema ndryshon pa e përditësuar fotografinë.

const fs = require("fs");
const path = require("path");
const { createDb } = require("../src/db");

const SNAPSHOT = path.join(__dirname, "..", "src", "db", "schema.snapshot.sql");

function currentSchema() {
  const db = createDb(":memory:");
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`
    )
    .all();
  const migrations = db.prepare("SELECT name, checksum FROM schema_migrations ORDER BY name").all();
  db.close();
  const header = [
    "-- GJENERUAR AUTOMATIKISHT nga `npm run db:snapshot` — mos e ndrysho me dorë.",
    "-- Skema e plotë pas schema.sql + migrimeve. Rishikohet në çdo PR që e ndryshon (D7).",
    ...migrations.map((m) => `-- migrim: ${m.name} sha256:${m.checksum.slice(0, 16)}`),
    "",
  ];
  const body = rows.map((r) => `-- ${r.type}: ${r.name}\n${r.sql.replace(/\r\n/g, "\n").trim()};\n`);
  return header.join("\n") + "\n" + body.join("\n");
}

if (require.main === module) {
  fs.writeFileSync(SNAPSHOT, currentSchema());
  console.log(`✔ Fotografia e skemës u shkrua: ${path.relative(process.cwd(), SNAPSHOT)}`);
}

module.exports = { currentSchema, SNAPSHOT };
