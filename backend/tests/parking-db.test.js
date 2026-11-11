"use strict";

// Testet e grupit "parking" (Erdi — D1–D6): migrimet, politika e leximeve, struktura,
// parametrat, statistikat, raportet CSV, integriteti, backup/restore dhe të dhënat DEMO.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startTestServer } = require("./helpers");
const { createDb } = require("../src/db");
const { listMigrations } = require("../src/db/migrate");
const { integrityReport, purge, backup, restore, verifyBackup } = require("../src/services/maintenance");
const { cell } = require("../src/services/reports");
const { seedDemo } = require("../scripts/seed-demo");

let t;
let token;
before(async () => {
  t = await startTestServer();
  token = await t.adminLogin();
});
after(() => t.close());

const sensor = (spots) => t.api("POST", "/api/sensor", { apiKey: t.bridgeKey, body: { spots } });

// ---------------- D1: skema ----------------

test("D1: migrimet aplikohen një herë, me radhë, dhe janë idempotente", () => {
  const db = createDb(":memory:");
  const applied = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(applied, listMigrations());
  const { runMigrations } = require("../src/db/migrate");
  assert.deepEqual(runMigrations(db), []); // hera e dytë: asgjë
  db.close();
});

test("D1: databaza ekzistuese rihapet pa rikrijuar vende të fshira", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parkimi-test-"));
  const file = path.join(dir, "p.db");
  let db = createDb(file);
  const total = db.prepare("SELECT COUNT(*) AS n FROM spots").get().n;
  db.prepare("DELETE FROM spots WHERE spot_key = 'C-P20'").run();
  db.close();
  db = createDb(file);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spots").get().n, total - 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("D1: sektorët, katet dhe sensorët plotësohen nga të dhënat e ekipit", () => {
  const sectors = t.db.prepare("SELECT code, is_demo FROM sectors ORDER BY code").all();
  assert.deepEqual(sectors, [
    { code: "A", is_demo: 0 },
    { code: "B", is_demo: 1 },
    { code: "C", is_demo: 1 },
  ]);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM spots WHERE floor_id IS NULL").get().n, 0);
  const s1 = t.db.prepare("SELECT trig_pin, echo_pin FROM sensors WHERE code = 'S1'").get();
  assert.deepEqual(s1, { trig_pin: "D2", echo_pin: "D3" });
  const s7 = t.db.prepare("SELECT kind, spot_id, trig_pin FROM sensors WHERE code = 'S7'").get();
  assert.deepEqual(s7, { kind: "entrance", spot_id: null, trig_pin: "A0" });
});

test("D1: spot_key nuk ndryshohet dhe kati duhet të jetë i të njëjtit sektor", () => {
  assert.throws(() => t.db.prepare("UPDATE spots SET spot_key = 'Z-P1' WHERE spot_key = 'A-P1'").run(), /spot_key/);
  const floorB = t.db.prepare("SELECT f.id FROM floors f JOIN sectors s ON s.id = f.sector_id WHERE s.code = 'B'").get().id;
  assert.throws(() => t.db.prepare("UPDATE spots SET floor_id = ? WHERE spot_key = 'A-P1'").run(floorB), /sektorit/);
});

// ---------------- D2: politika e leximeve ----------------

test("D2: ruhen vetëm ndryshimet; matjet e njëjta brenda tolerancës injorohen", async () => {
  const spot = t.db.prepare("SELECT id FROM spots WHERE spot_key = 'A-P3'").get().id;
  const count = () => t.db.prepare("SELECT COUNT(*) AS n FROM sensor_readings WHERE spot_id = ?").get(spot).n;
  const n0 = count();
  await sensor([{ key: "A-P3", cm: 8 }]);
  await sensor([{ key: "A-P3", cm: 8.2 }]); // brenda tolerancës 0.5
  await sensor([{ key: "A-P3", cm: 8.1 }]);
  assert.equal(count(), n0 + 1);
  await sensor([{ key: "A-P3", cm: 6 }]); // lëvizje > tolerancë
  await sensor([{ key: "A-P3", cm: 2 }]); // ndryshim statusi
  assert.equal(count(), n0 + 3);
  const seen = t.db.prepare("SELECT last_seen_at, last_ok_at FROM sensors WHERE spot_id = ?").get(spot);
  assert.ok(seen.last_seen_at && seen.last_ok_at);
});

test("D2: pas intervalit të mostrës ruhet një lexim 'sample'", () => {
  const spot = t.db.prepare("SELECT id FROM spots WHERE spot_key = 'A-P4'").get().id;
  const ins = t.db.prepare("INSERT INTO sensor_readings (spot_id, distance_cm, status, sensor_ok, created_at) VALUES (?, 7, 'free', 1, ?)");
  ins.run(spot, "2026-01-01 10:00:00");
  ins.run(spot, "2026-01-01 10:01:00"); // injorohet (< 300 s)
  ins.run(spot, "2026-01-01 10:06:00"); // mostër
  const rows = t.db.prepare("SELECT kind FROM sensor_readings WHERE spot_id = ? AND created_at LIKE '2026-01-01%' ORDER BY id").all(spot);
  assert.deepEqual(rows.map((r) => r.kind), ["change", "sample"]);
});

test("D2: çdo ndryshim statusi shkruhet në status_events", async () => {
  const spot = t.db.prepare("SELECT id FROM spots WHERE spot_key = 'A-P5'").get().id;
  await sensor([{ key: "A-P5", cm: 2 }]);
  await sensor([{ key: "A-P5", cm: 7 }]);
  const ev = t.db.prepare("SELECT from_status, to_status FROM status_events WHERE spot_id = ? ORDER BY id").all(spot);
  assert.deepEqual(ev.slice(-2), [
    { from_status: "unknown", to_status: "occupied" },
    { from_status: "occupied", to_status: "free" },
  ]);
});

test("D2: rezervimet e mbyllura kalojnë në historik me rezultatin e duhur", async () => {
  const vt = await t.visitorLogin("Arta", "02-222-AA");
  const r = await t.api("POST", "/api/reserve", { token: vt, body: { key: "A-P6", end: Date.now() + 3600_000 } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  await sensor([{ key: "A-P6", cm: 2 }]); // vetura arrin → qëndrim + fshirje e rezervimit
  const h = t.db.prepare("SELECT outcome, plate FROM reservation_history ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(h, { outcome: "fulfilled", plate: "02-222-AA" });
});

// ---------------- D5: struktura ----------------

test("D5: CRUD i strukturës kërkon admin dhe ruan rregullat", async () => {
  assert.equal((await t.api("POST", "/api/admin/sectors", { body: { code: "E", name: "X" } })).status, 401);

  const sec = await t.api("POST", "/api/admin/sectors", { token, body: { code: "e", name: "Sektori E" } });
  assert.equal(sec.status, 201);
  assert.equal(sec.json.code, "E");
  assert.equal((await t.api("POST", "/api/admin/sectors", { token, body: { code: "E", name: "Dublikatë" } })).status, 409);

  const tree = await t.api("GET", "/api/admin/structure", { token });
  const e = tree.json.data.find((s) => s.code === "E");
  assert.equal(e.floors.length, 1); // F0 krijohet automatikisht

  const f1 = await t.api("POST", "/api/admin/floors", { token, body: { sector_id: e.id, code: "F1", name: "Kati 1", level: 1 } });
  assert.equal(f1.status, 201);

  const spot = await t.api("POST", "/api/admin/spots", { token, body: { floor_id: f1.json.id, label: "p1", row_label: "r1" } });
  assert.equal(spot.status, 201);
  assert.equal(spot.json.spot_key, "E-P1");
  assert.equal(spot.json.status, "unknown");
  assert.equal(spot.json.source, "demo");
  // QR dhe API-ja e ekipit e shohin vendin e ri
  assert.equal((await t.api("GET", "/api/spots/E-P1")).status, 200);
  assert.ok(t.db.prepare("SELECT 1 FROM qr_codes WHERE code = 'E-P1'").get());

  assert.equal((await t.api("PATCH", "/api/admin/spots/E-P1", { token, body: { label: "P9" } })).status, 400);
  const upd = await t.api("PATCH", "/api/admin/spots/E-P1", { token, body: { is_active: false, number: 7 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.is_active, 0);

  assert.equal((await t.api("DELETE", `/api/admin/floors/${f1.json.id}`, { token })).status, 409); // ka vende
  assert.equal((await t.api("DELETE", `/api/admin/sectors/${e.id}`, { token })).status, 409);
  assert.equal((await t.api("DELETE", "/api/admin/spots/E-P1", { token })).status, 200);
  assert.equal((await t.api("DELETE", `/api/admin/floors/${f1.json.id}`, { token })).status, 200);
  assert.equal((await t.api("DELETE", `/api/admin/sectors/${e.id}`, { token })).status, 200);

  const audit = t.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'sector_%' OR action LIKE 'spot_%'").all();
  assert.ok(audit.some((a) => a.action === "spot_create") && audit.some((a) => a.action === "sector_delete"));
});

test("D5: vendi me sensor live ose me histori nuk fshihet", async () => {
  assert.equal((await t.api("DELETE", "/api/admin/spots/A-P1", { token })).status, 409);
  const a = t.db.prepare("SELECT id FROM sectors WHERE code = 'A'").get().id;
  const r = await t.api("PATCH", `/api/admin/sectors/${a}`, { token, body: { is_demo: true } });
  assert.equal(r.status, 409);
});

test("D5: operatori lexon strukturën por nuk e ndryshon", async () => {
  await t.api("POST", "/api/admin/users", { token, body: { username: "op1", password: "operator-i-forte-1", role: "operator" } });
  const login = await t.api("POST", "/api/admin/login", { body: { username: "op1", password: "operator-i-forte-1" } });
  const op = login.json.token;
  assert.equal((await t.api("GET", "/api/admin/structure", { token: op })).status, 200);
  assert.equal((await t.api("POST", "/api/admin/sectors", { token: op, body: { code: "F", name: "F" } })).status, 403);
  assert.equal((await t.api("PUT", "/api/admin/settings", { token: op, body: { tolerance_cm: 1 } })).status, 403);
});

// ---------------- D5: parametrat ----------------

test("D5: parametrat validohen dhe pragu i ri zbatohet menjëherë", async () => {
  const bad = await t.api("PUT", "/api/admin/settings", { token, body: { occ_threshold_cm: 20 } });
  assert.equal(bad.status, 400); // ≥ rrezja maksimale (10)
  assert.equal((await t.api("PUT", "/api/admin/settings", { token, body: { nope: 1 } })).status, 400);
  assert.equal((await t.api("PUT", "/api/admin/settings", { token, body: { sample_interval_s: 1.5 } })).status, 400);

  const ok = await t.api("PUT", "/api/admin/settings", { token, body: { occ_threshold_cm: 5 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.values.occ_threshold_cm, 5);
  assert.equal(ok.json.meta.occ_threshold_cm.updated_by, "admin-test");

  await sensor([{ key: "A-P2", cm: 4.5 }]); // me pragun e vjetër (3) do ishte "free"
  assert.equal((await t.api("GET", "/api/spots/A-P2")).json.status, "occupied");

  await t.api("PUT", "/api/admin/settings", { token, body: { occ_threshold_cm: 3 } });
});

// ---------------- D3 + D4: statistikat me të dhëna DEMO ----------------

test("D4: seed-i DEMO prek vetëm sektorët DEMO dhe është i përsëritshëm", () => {
  const db = createDb(":memory:");
  const now = Date.parse("2026-11-10T12:00:00Z");
  const a = seedDemo(db, { days: 7, seed: 7, withD: true, now });
  assert.ok(a.createdD);
  assert.ok(a.sessions > 100);
  const live = db.prepare("SELECT COUNT(*) AS n FROM parking_sessions p JOIN spots s ON s.id = p.spot_id WHERE s.sector = 'A'").get().n;
  assert.equal(live, 0);
  const floorsD = db.prepare("SELECT COUNT(*) AS n FROM floors f JOIN sectors s ON s.id = f.sector_id WHERE s.code = 'D'").get().n;
  assert.equal(floorsD, 2);
  const b = seedDemo(db, { days: 7, seed: 7, withD: true, now });
  assert.equal(b.sessions, a.sessions); // determinist, pa dublikime
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM parking_sessions").get().n, a.sessions);
  assert.ok(integrityReport(db).ok, JSON.stringify(integrityReport(db).checks.filter((c) => !c.ok)));
  db.close();
});

test("D3: /api/stats/summary jep zënien për orë, pikun, kohëzgjatjen dhe hyrjet", async () => {
  seedDemo(t.db, { days: 7, seed: 3 });
  const r = await t.api("GET", "/api/stats/summary?sector=B");
  assert.equal(r.status, 200);
  const s = r.json;
  assert.equal(s.sector, "B");
  assert.equal(s.occupancy.by_hour_of_day.length, 24);
  assert.ok(s.occupancy.avg_pct > 0 && s.occupancy.avg_pct <= 100);
  assert.ok(s.occupancy.peak_hour.hour >= 8 && s.occupancy.peak_hour.hour <= 21);
  assert.ok(s.sessions.count > 0 && s.sessions.avg_minutes > 0 && s.sessions.median_minutes > 0);
  assert.ok(s.entrance.entries > 0);
  assert.equal(s.sensors.sensors.length, 7);

  assert.equal((await t.api("GET", "/api/stats/summary?sector=Q")).status, 400);
  assert.equal((await t.api("GET", "/api/stats/summary?from=2026-01-01&to=2025-01-01")).status, 400);
  assert.equal((await t.api("GET", "/api/stats/summary?from=2025-01-01&to=2026-01-01")).status, 400); // > 92 ditë
});

test("D3: zënia llogaritet saktë për një qëndrim të njohur", () => {
  const { summary } = require("../src/services/stats");
  const db = createDb(":memory:");
  const spot = db.prepare("SELECT id FROM spots WHERE spot_key = 'C-P1'").get().id;
  const from = Date.parse("2026-03-02T09:00:00Z"); // 10:00 në Beograd (CET)
  db.prepare("INSERT INTO parking_sessions (spot_id, started_at, ended_at) VALUES (?, ?, ?)").run(spot, from, from + 2 * 3600_000);
  const s = summary(db, { from, to: from + 4 * 3600_000, sector: "C" }, { now: from + 5 * 3600_000 });
  // 1 vend i zënë 2 orë nga 20 vende × 4 orë = 2.5 %
  assert.equal(s.occupancy.avg_pct, 2.5);
  assert.equal(s.occupancy.peak_hour.hour, 10);
  assert.equal(s.sessions.avg_minutes, 120);
  db.close();
});

// ---------------- D5: raportet CSV ----------------

test("D5: eksporti CSV ka BOM, kokë dhe mbrohet nga formulat", async () => {
  const res = await fetch(`${t.base}/api/admin/reports/sessions.csv?sector=B`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /parkimi-sessions-B-/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = buf.toString("utf8").slice(1);
  assert.ok(text.startsWith("spot_key,sector,floor,visitor_name,plate,started_at"));
  assert.ok(Number(res.headers.get("x-row-count")) > 0);

  assert.equal(cell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(cell("a,b"), '"a,b"');
  assert.equal(cell(-3), "-3");

  for (const type of ["readings", "status-events", "entrance", "reservations"]) {
    const r = await fetch(`${t.base}/api/admin/reports/${type}.csv`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, type);
  }
  assert.equal((await fetch(`${t.base}/api/admin/reports/nope.csv`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.equal((await fetch(`${t.base}/api/admin/reports/sessions.csv`)).status, 401);
});

// ---------------- D6: integriteti, pastrimi, backup ----------------

test("D6: kontrolli i integritetit kalon dhe zbulon një problem të futur me qëllim", async () => {
  const r = await t.api("GET", "/api/admin/maintenance/integrity", { token });
  assert.equal(r.status, 200);
  assert.ok(r.json.ok, JSON.stringify(r.json.checks.filter((c) => !c.ok)));

  const db = createDb(":memory:");
  db.prepare("DELETE FROM qr_codes WHERE code = 'B-P2'").run();
  const report = integrityReport(db);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.name === "Vende pa kod QR").count, 1);
  db.close();
});

test("D6: pastrimi fshin vetëm të dhënat më të vjetra se politika", () => {
  const db = createDb(":memory:");
  const spot = db.prepare("SELECT id FROM spots WHERE spot_key = 'A-P1'").get().id;
  const ins = db.prepare("INSERT INTO sensor_readings (spot_id, distance_cm, status, sensor_ok, created_at, kind) VALUES (?, ?, 'free', 1, ?, ?)");
  ins.run(spot, 5, "2026-08-01 00:00:00", "change"); // < 180 ditë → mbetet
  ins.run(spot, 9, "2026-09-01 00:00:00", "sample"); // > 30 ditë → fshihet
  ins.run(spot, 6, "2026-11-09 00:00:00", "sample"); // e re → mbetet
  const now = Date.parse("2026-11-10T00:00:00Z");
  const dry = purge(db, { dryRun: true, now });
  assert.equal(dry.result[0].deleted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sensor_readings").get().n, 3);
  const real = purge(db, { now });
  assert.deepEqual(real.result.map((r) => r.deleted), [1, 0, 0]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sensor_readings").get().n, 2);
  db.close();
});

test("D6: backup → restore rikthen të dhënat dhe ruan kopje sigurie", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parkimi-bk-"));
  const dbFile = path.join(dir, "parking.db");
  let db = createDb(dbFile);
  db.prepare("INSERT INTO gate_events (type, plate, source) VALUES ('entry', 'BK-1', 'test')").run();
  const info = await backup(db, path.join(dir, "backups", "b1.db"));
  assert.ok(info.ok && info.spots === 38);
  db.prepare("DELETE FROM gate_events").run();
  db.close();

  const out = restore(info.path, dbFile);
  assert.ok(out.safety_copy && fs.existsSync(out.safety_copy));
  db = createDb(dbFile);
  assert.equal(db.prepare("SELECT plate FROM gate_events").get().plate, "BK-1");
  db.close();

  fs.writeFileSync(path.join(dir, "jo.db"), "nuk jam databazë");
  assert.equal(verifyBackup(path.join(dir, "jo.db")).ok, false);
  assert.throws(() => restore(path.join(dir, "jo.db"), dbFile), /pavlefshëm/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("D6: GET /api/admin/backup shkarkon një databazë të vlefshme (vetëm admin)", async () => {
  const res = await fetch(`${t.base}/api/admin/backup`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), "SQLite format 3");
  assert.equal((await fetch(`${t.base}/api/backup`)).status, 404);
  assert.equal((await fetch(`${t.base}/api/admin/backup`)).status, 401);
});

test("API publike: /api/sectors liston sektorët aktivë me katet", async () => {
  const r = await t.api("GET", "/api/sectors");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.slice(0, 3).map((s) => s.code), ["A", "B", "C"]);
  assert.equal(r.json.data[0].is_demo, false);
  assert.ok(r.json.data[0].floors.length >= 1);
});
