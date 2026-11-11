"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Mirëmbajtja e databazës (D6): kontrollet e integritetit, pastrimi sipas politikës
// së ruajtjes dhe backup/restore. Përdoret nga paneli (rrugët admin) dhe nga skriptet CLI.

// Çdo kontroll kthen rreshtat problematikë; bosh = në rregull.
const CHECKS = [
  ["Vende pa gjendje (spot_status)", "SELECT s.spot_key FROM spots s LEFT JOIN spot_status st ON st.spot_id = s.id WHERE st.spot_id IS NULL"],
  ["Vende pa kod QR", "SELECT s.spot_key FROM spots s LEFT JOIN qr_codes q ON q.spot_id = s.id WHERE q.id IS NULL"],
  ["Vende pa kat", "SELECT spot_key FROM spots WHERE floor_id IS NULL"],
  ["Kati në sektor tjetër nga vendi", `SELECT s.spot_key FROM spots s JOIN floors f ON f.id = s.floor_id
     JOIN sectors sec ON sec.id = f.sector_id WHERE sec.code <> s.sector`],
  ["Vende në sektor të paregjistruar", "SELECT s.spot_key FROM spots s LEFT JOIN sectors sec ON sec.code = s.sector WHERE sec.id IS NULL"],
  ["spot_key jo në formatin <sektor>-<etiketë>", "SELECT spot_key FROM spots WHERE spot_key <> sector || '-' || label"],
  ["Sensor i lidhur me vend pa has_sensor", "SELECT se.code FROM sensors se JOIN spots s ON s.id = se.spot_id WHERE s.has_sensor = 0"],
  ["Vend me has_sensor pa sensor të regjistruar", "SELECT s.spot_key FROM spots s LEFT JOIN sensors se ON se.spot_id = s.id WHERE s.has_sensor = 1 AND se.id IS NULL"],
  ["Lexime për vende pa sensor", "SELECT DISTINCT s.spot_key FROM sensor_readings r JOIN spots s ON s.id = r.spot_id WHERE s.has_sensor = 0"],
  ["Më shumë se një qëndrim i hapur në vend", "SELECT spot_id, COUNT(*) AS n FROM parking_sessions WHERE ended_at IS NULL GROUP BY spot_id HAVING n > 1"],
  ["Qëndrim i hapur në vend të lirë", `SELECT s.spot_key FROM parking_sessions p JOIN spots s ON s.id = p.spot_id
     JOIN spot_status st ON st.spot_id = s.id WHERE p.ended_at IS NULL AND st.status = 'free'`],
  ["Qëndrim që mbaron para se të fillojë", "SELECT id FROM parking_sessions WHERE ended_at IS NOT NULL AND ended_at < started_at"],
  ["Sektor DEMO me sensorë live", `SELECT sec.code FROM sectors sec JOIN spots s ON s.sector = sec.code
     WHERE sec.is_demo = 1 AND s.has_sensor = 1 GROUP BY sec.code`],
  ["Parametra me vlerë jo-numerike", "SELECT key FROM settings WHERE CAST(value AS REAL) || '' <> value AND CAST(value AS INTEGER) || '' <> value"],
];

function integrityReport(db) {
  const checks = CHECKS.map(([name, sql]) => {
    const rows = db.prepare(sql).all();
    return { name, ok: rows.length === 0, count: rows.length, sample: rows.slice(0, 5) };
  });
  const sqliteIntegrity = db.pragma("integrity_check").map((r) => r.integrity_check);
  const foreignKeys = db.pragma("foreign_key_check");
  checks.unshift(
    { name: "SQLite integrity_check", ok: sqliteIntegrity.length === 1 && sqliteIntegrity[0] === "ok", count: sqliteIntegrity[0] === "ok" ? 0 : sqliteIntegrity.length, sample: sqliteIntegrity.slice(0, 5) },
    { name: "Çelësat e huaj (foreign_key_check)", ok: foreignKeys.length === 0, count: foreignKeys.length, sample: foreignKeys.slice(0, 5) }
  );
  const migrations = db.prepare("SELECT name, applied_at FROM schema_migrations ORDER BY name").all();
  const counts = Object.fromEntries(
    ["sectors", "floors", "spots", "sensors", "sensor_readings", "status_events", "parking_sessions", "gate_events", "barrier_events", "reservation_history"]
      .map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])
  );
  return { ok: checks.every((c) => c.ok), checks, migrations, counts, checked_at: new Date().toISOString() };
}

function setting(db, key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? Number(row.value) : fallback;
}

// Pastrimi sipas politikës: mostrat pas retention_sample_days, ndryshimet dhe ngjarjet
// e statusit pas retention_change_days. Qëndrimet, hyrjet dhe rezervimet nuk fshihen
// (janë të dhëna biznesi për raportet). dryRun = vetëm numëron.
function purge(db, { dryRun = false, now = Date.now() } = {}) {
  const sampleDays = setting(db, "retention_sample_days", 30);
  const changeDays = setting(db, "retention_change_days", 180);
  const iso = (days) => new Date(now - days * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const plan = [
    ["sensor_readings (mostra)", "FROM sensor_readings WHERE kind = 'sample' AND created_at < ?", iso(sampleDays)],
    ["sensor_readings (ndryshime)", "FROM sensor_readings WHERE kind = 'change' AND created_at < ?", iso(changeDays)],
    ["status_events", "FROM status_events WHERE created_at < ?", now - changeDays * 86400_000],
  ];
  const result = db.transaction(() =>
    plan.map(([name, sql, cutoff]) => ({
      name,
      cutoff,
      deleted: dryRun
        ? db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(cutoff).n
        : db.prepare(`DELETE ${sql}`).run(cutoff).changes,
    }))
  )();
  return { dry_run: dryRun, retention: { sample_days: sampleDays, change_days: changeDays }, result };
}

function backupFileName(now = new Date()) {
  return `parking-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.db`;
}

// Backup "online" me API-në e SQLite: i sigurt edhe kur serveri po shkruan (WAL).
async function backup(db, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await db.backup(destPath);
  const check = verifyBackup(destPath);
  if (!check.ok) throw new Error(`Backup-i nuk kaloi kontrollin: ${check.reason}`);
  return { path: destPath, bytes: fs.statSync(destPath).size, ...check };
}

// Kontrollon që një skedar është databazë e vlefshme e këtij projekti.
function verifyBackup(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: "Skedari nuk ekziston" };
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") return { ok: false, reason: `integrity_check: ${integrity}` };
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ["spots", "spot_status", "admin_users", "schema_migrations", "sectors"]) {
      if (!tables.has(t)) return { ok: false, reason: `Mungon tabela ${t}` };
    }
    const migrations = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r) => r.name);
    const spots = db.prepare("SELECT COUNT(*) AS n FROM spots").get().n;
    return { ok: true, migrations, spots };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    if (db) db.close();
  }
}

// Rikthimi bëhet vetëm me serverin të ndalur (CLI). Databaza aktuale ruhet më parë si
// kopje sigurie, pastaj backup-i kopjohet në vend të saj dhe skedarët -wal/-shm hiqen.
function restore(backupPath, dbPath, { safetyDir } = {}) {
  const check = verifyBackup(backupPath);
  if (!check.ok) throw new Error(`Backup-i i pavlefshëm: ${check.reason}`);
  let safety = null;
  if (fs.existsSync(dbPath)) {
    const live = new Database(dbPath);
    live.pragma("wal_checkpoint(TRUNCATE)");
    live.close();
    const dir = safetyDir || path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(dir, { recursive: true });
    safety = path.join(dir, "para-rikthimit-" + backupFileName());
    fs.copyFileSync(dbPath, safety);
  }
  for (const ext of ["-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
  fs.copyFileSync(backupPath, dbPath);
  return { restored_from: backupPath, safety_copy: safety, ...check };
}

module.exports = { integrityReport, purge, backup, verifyBackup, restore, backupFileName };
