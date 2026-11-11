"use strict";

// Mjetet e databazës (D6):
//   npm run db:backup [-- dosja]          → kopje online në backend/data/backups/
//   npm run db:restore -- <skedari.db>    → rikthim (ndal serverin më parë!)
//   npm run db:check                      → kontrollet e integritetit (exit 1 nëse ka probleme)
//   npm run db:purge [-- --confirm]       → pastrim sipas politikës së ruajtjes (pa --confirm vetëm numëron)

const path = require("path");
const config = require("../src/config");
const { createDb } = require("../src/db");
const { integrityReport, purge, backup, restore, backupFileName } = require("../src/services/maintenance");

async function main([cmd, ...rest]) {
  const dbPath = path.resolve(config.dbPath);
  switch (cmd) {
    case "backup": {
      const db = createDb(dbPath);
      const dir = rest[0] ? path.resolve(rest[0]) : path.join(path.dirname(dbPath), "backups");
      const info = await backup(db, path.join(dir, backupFileName()));
      db.close();
      console.log(`✔ Backup: ${info.path} (${(info.bytes / 1024).toFixed(1)} KB, ${info.spots} vende, migrimet: ${info.migrations.join(", ")})`);
      return 0;
    }
    case "restore": {
      if (!rest[0]) throw new Error("Përdorimi: npm run db:restore -- <skedari.db>");
      const info = restore(path.resolve(rest[0]), dbPath);
      console.log(`✔ U rikthye nga ${info.restored_from}`);
      if (info.safety_copy) console.log(`  Databaza e mëparshme u ruajt te ${info.safety_copy}`);
      // Hapja e parë aplikon migrimet që mund të mungojnë në një backup më të vjetër.
      const db = createDb(dbPath);
      const report = integrityReport(db);
      db.close();
      console.log(report.ok ? "✔ Kontrolli i integritetit: në rregull" : "✖ Kontrolli i integritetit gjeti probleme — npm run db:check");
      return report.ok ? 0 : 1;
    }
    case "check": {
      const db = createDb(dbPath);
      const report = integrityReport(db);
      db.close();
      for (const c of report.checks) {
        console.log(`${c.ok ? "✔" : "✖"} ${c.name}${c.ok ? "" : ` — ${c.count}: ${JSON.stringify(c.sample)}`}`);
      }
      console.log(`Migrimet: ${report.migrations.map((m) => m.name).join(", ")}`);
      console.log("Rreshta:", report.counts);
      return report.ok ? 0 : 1;
    }
    case "purge": {
      const db = createDb(dbPath);
      const out = purge(db, { dryRun: !rest.includes("--confirm") });
      db.close();
      for (const r of out.result) console.log(`${out.dry_run ? "do të fshiheshin" : "u fshinë"} ${r.deleted} — ${r.name}`);
      if (out.dry_run) console.log("(provë — shto --confirm për të fshirë)");
      return 0;
    }
    default:
      console.log("Komandat: backup [dosja] | restore <skedari> | check | purge [--confirm]");
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error("✖", e.message);
    process.exit(1);
  }
);
