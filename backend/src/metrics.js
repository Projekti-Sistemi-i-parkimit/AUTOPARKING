"use strict";

// Metrika në formatin e tekstit të Prometheus-it — pa varësi të jashtme.
// Parimi kryesor: dështimi i monitorimit NUK e prish kurrë aplikacionin
// (çdo regjistrim është në try/catch) dhe metrikat nuk përmbajnë kurrë
// kredenciale, token-ë, targa apo të dhëna personale — vetëm numërues.

const fs = require("fs");

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

function createMetrics(db) {
  const startedAt = Date.now();
  const requests = new Map(); // "METODA|statusi" → numër
  let errors = 0;
  let durSum = 0;
  let durCount = 0;
  const bucketCounts = new Array(DURATION_BUCKETS.length).fill(0);
  // Rezervimet online (sektorët B/C): numërues në proces nga kërkesat reale
  // POST /api/reserve — ok = u krijua, error = u refuzua (4xx/5xx).
  let reservationsOk = 0;
  let reservationsErr = 0;

  // Middleware: numëron çdo kërkesë HTTP të përfunduar dhe kohëzgjatjen e saj.
  function middleware(req, res, next) {
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      try {
        // req.originalUrl nuk ndryshohet nga router-ët e Express-it (req.path
        // mund të mbetet pa prefiksin /api kur përgjigja dërgohet brenda tyre)
        const path = (req.originalUrl || req.url || "").split("?")[0];
        if (path === "/metrics") return; // vetë-skrapimi s'ka vlerë statistikore
        const key = `${req.method}|${res.statusCode}`;
        requests.set(key, (requests.get(key) || 0) + 1);
        if (res.statusCode >= 500) errors += 1;
        if (req.method === "POST" && path === "/api/reserve") {
          if (res.statusCode < 400) reservationsOk += 1;
          else reservationsErr += 1;
        }
        const s = Number(process.hrtime.bigint() - t0) / 1e9;
        durSum += s;
        durCount += 1;
        for (let i = 0; i < DURATION_BUCKETS.length; i++) {
          if (s <= DURATION_BUCKETS[i]) bucketCounts[i] += 1;
        }
      } catch {
        /* monitorimi nuk ndal aplikacionin */
      }
    });
    next();
  }

  function dbUp() {
    try {
      db.prepare("SELECT 1").get();
      return 1;
    } catch {
      return 0;
    }
  }

  function render() {
    const L = [];
    L.push("# HELP parkimi_http_requests_total Numri total i kërkesave HTTP sipas metodës dhe statusit");
    L.push("# TYPE parkimi_http_requests_total counter");
    for (const [key, n] of requests) {
      const [method, status] = key.split("|");
      L.push(`parkimi_http_requests_total{method="${method}",status="${status}"} ${n}`);
    }
    L.push("# HELP parkimi_http_request_errors_total Kërkesat me status 5xx");
    L.push("# TYPE parkimi_http_request_errors_total counter");
    L.push(`parkimi_http_request_errors_total ${errors}`);
    L.push("# HELP parkimi_http_request_duration_seconds Kohëzgjatja e kërkesave HTTP");
    L.push("# TYPE parkimi_http_request_duration_seconds histogram");
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      L.push(`parkimi_http_request_duration_seconds_bucket{le="${DURATION_BUCKETS[i]}"} ${bucketCounts[i]}`);
    }
    L.push(`parkimi_http_request_duration_seconds_bucket{le="+Inf"} ${durCount}`);
    L.push(`parkimi_http_request_duration_seconds_sum ${durSum.toFixed(6)}`);
    L.push(`parkimi_http_request_duration_seconds_count ${durCount}`);
    L.push("# HELP parkimi_uptime_seconds Sekondat që nga nisja e procesit");
    L.push("# TYPE parkimi_uptime_seconds gauge");
    L.push(`parkimi_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
    L.push("# HELP parkimi_db_up Shëndeti i databazës (1 = në rregull, 0 = e paarritshme)");
    L.push("# TYPE parkimi_db_up gauge");
    L.push(`parkimi_db_up ${dbUp()}`);
    renderBusiness(L);
    return L.join("\n") + "\n";
  }

  // Metrikat e domenit — llogariten nga SQLite në çdo skrapim (query të lira
  // mbi tabela të vogla/indeksuara). Çdo grup në try/catch: dështimi i një
  // grupi nuk prish të tjerët dhe kurrë s'prek aplikacionin. Pa PII: vetëm
  // numërues; etiketat janë vlera të fiksuara konfigurimi (sektorë, çelësa
  // vendesh A-P1…A-P6, statuse, veprime auditimi) — jo ID unike.
  function renderBusiness(L) {
    try {
      // Vendet sipas sektorit dhe statusit (gjithmonë të gjitha kombinimet)
      L.push("# HELP parkimi_spots_total Numri i vendeve të parkimit sipas sektorit");
      L.push("# TYPE parkimi_spots_total gauge");
      L.push("# HELP parkimi_spot_status Numri i vendeve sipas sektorit dhe statusit aktual");
      L.push("# TYPE parkimi_spot_status gauge");
      const counts = new Map(); // "sektori|statusi" → numër
      const totals = new Map();
      for (const r of db
        .prepare(
          `SELECT s.sector, st.status, COUNT(*) AS n
           FROM spots s JOIN spot_status st ON st.spot_id = s.id
           GROUP BY s.sector, st.status`
        )
        .all()) {
        counts.set(`${r.sector}|${r.status}`, r.n);
        totals.set(r.sector, (totals.get(r.sector) || 0) + r.n);
      }
      for (const [sector, n] of totals) L.push(`parkimi_spots_total{sector="${sector}"} ${n}`);
      for (const sector of totals.keys()) {
        for (const status of ["free", "occupied", "unknown"]) {
          L.push(
            `parkimi_spot_status{sector="${sector}",status="${status}"} ${counts.get(`${sector}|${status}`) || 0}`
          );
        }
      }
    } catch { /* grupi anashkalohet */ }

    try {
      // Rezervimet aktive (vetëm sektorët online B/C kanë rezervime)
      L.push("# HELP parkimi_reservations_active Rezervimet aktive sipas sektorit");
      L.push("# TYPE parkimi_reservations_active gauge");
      const bySector = new Map();
      for (const r of db
        .prepare(
          `SELECT s.sector, COUNT(*) AS n FROM reservations r
           JOIN spots s ON s.id = r.spot_id
           WHERE r.status IN ('reserved','active') AND (r.until IS NULL OR r.until > ?)
           GROUP BY s.sector`
        )
        .all(Date.now())) {
        bySector.set(r.sector, r.n);
      }
      for (const sector of ["B", "C"]) {
        L.push(`parkimi_reservations_active{sector="${sector}"} ${bySector.get(sector) || 0}`);
      }
      L.push("# HELP parkimi_reservation_requests_total Kërkesat POST /api/reserve sipas rezultatit");
      L.push("# TYPE parkimi_reservation_requests_total counter");
      L.push(`parkimi_reservation_requests_total{outcome="ok"} ${reservationsOk}`);
      L.push(`parkimi_reservation_requests_total{outcome="error"} ${reservationsErr}`);
    } catch { /* grupi anashkalohet */ }

    try {
      // Qëndrimet në parking
      L.push("# HELP parkimi_parking_sessions_active Qëndrimet e hapura sipas sektorit");
      L.push("# TYPE parkimi_parking_sessions_active gauge");
      const open = new Map();
      for (const r of db
        .prepare(
          `SELECT s.sector, COUNT(*) AS n FROM parking_sessions p
           JOIN spots s ON s.id = p.spot_id WHERE p.ended_at IS NULL GROUP BY s.sector`
        )
        .all()) {
        open.set(r.sector, r.n);
      }
      for (const sector of ["A", "B", "C"]) {
        L.push(`parkimi_parking_sessions_active{sector="${sector}"} ${open.get(sector) || 0}`);
      }
      L.push("# HELP parkimi_parking_sessions_completed Qëndrimet e përfunduara (historiku)");
      L.push("# TYPE parkimi_parking_sessions_completed gauge");
      L.push(
        `parkimi_parking_sessions_completed ${db.prepare("SELECT COUNT(*) AS n FROM parking_sessions WHERE ended_at IS NOT NULL").get().n}`
      );
    } catch { /* grupi anashkalohet */ }

    try {
      // Sensorët e Sektorit A (prototipi Arduino): distanca aktuale dhe
      // vjetërsia e matjes së fundit për çdo vend me sensor
      L.push("# HELP parkimi_sensor_distance_cm Distanca e fundit e matur nga sensori (cm)");
      L.push("# TYPE parkimi_sensor_distance_cm gauge");
      for (const r of db
        .prepare(
          `SELECT s.spot_key AS spot, st.distance_cm FROM spots s
           JOIN spot_status st ON st.spot_id = s.id
           WHERE s.has_sensor = 1 AND st.distance_cm IS NOT NULL`
        )
        .all()) {
        L.push(`parkimi_sensor_distance_cm{spot="${r.spot}"} ${r.distance_cm}`);
      }
      L.push("# HELP parkimi_sensor_last_reading_age_seconds Sekonda nga matja e fundit e sensorit");
      L.push("# TYPE parkimi_sensor_last_reading_age_seconds gauge");
      for (const r of db
        .prepare(
          `SELECT s.spot_key AS spot,
                  strftime('%s','now') - strftime('%s', MAX(r.created_at)) AS age
           FROM sensor_readings r JOIN spots s ON s.id = r.spot_id
           GROUP BY s.spot_key`
        )
        .all()) {
        L.push(`parkimi_sensor_last_reading_age_seconds{spot="${r.spot}"} ${Math.max(0, r.age)}`);
      }
      L.push("# HELP parkimi_sensor_readings_total Matjet e regjistruara të sensorëve (historiku)");
      L.push("# TYPE parkimi_sensor_readings_total counter");
      L.push(
        `parkimi_sensor_readings_total ${db.prepare("SELECT COUNT(*) AS n FROM sensor_readings").get().n}`
      );
      L.push("# HELP parkimi_sensor_faults_total Matjet me sensor_ok=0 (defekte të raportuara)");
      L.push("# TYPE parkimi_sensor_faults_total counter");
      L.push(
        `parkimi_sensor_faults_total ${db.prepare("SELECT COUNT(*) AS n FROM sensor_readings WHERE sensor_ok = 0").get().n}`
      );
    } catch { /* grupi anashkalohet */ }

    try {
      // Barriera dhe hyrje-daljet (porta)
      L.push("# HELP parkimi_barrier_state Gjendja e barrierës (one-hot: 1 = statusi aktual)");
      L.push("# TYPE parkimi_barrier_state gauge");
      const b = db.prepare("SELECT status FROM barrier_state WHERE id = 1").get();
      for (const status of ["open", "closed", "error"]) {
        L.push(`parkimi_barrier_state{status="${status}"} ${b && b.status === status ? 1 : 0}`);
      }
      L.push("# HELP parkimi_gate_events_total Ngjarjet e portës sipas tipit (historiku)");
      L.push("# TYPE parkimi_gate_events_total counter");
      for (const type of ["entry", "exit"]) {
        L.push(
          `parkimi_gate_events_total{type="${type}"} ${db.prepare("SELECT COUNT(*) AS n FROM gate_events WHERE type = ?").get(type).n}`
        );
      }
      L.push("# HELP parkimi_qr_scans_total Skanimet e kodeve QR (historiku)");
      L.push("# TYPE parkimi_qr_scans_total counter");
      L.push(`parkimi_qr_scans_total ${db.prepare("SELECT COUNT(*) AS n FROM qr_scans").get().n}`);
    } catch { /* grupi anashkalohet */ }

    try {
      // Siguria dhe aktiviteti administrativ — vetëm numërues, kurrë emra/IP
      L.push("# HELP parkimi_audit_events_total Ngjarjet e audit log-ut sipas veprimit");
      L.push("# TYPE parkimi_audit_events_total counter");
      for (const r of db
        .prepare("SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action")
        .all()) {
        L.push(`parkimi_audit_events_total{action="${r.action}"} ${r.n}`);
      }
      L.push("# HELP parkimi_admin_sessions_active Sesionet aktive të adminëve");
      L.push("# TYPE parkimi_admin_sessions_active gauge");
      L.push(
        `parkimi_admin_sessions_active ${db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE expires_at > ?").get(new Date().toISOString()).n}`
      );
      L.push("# HELP parkimi_admin_users_total Llogaritë e administratorëve");
      L.push("# TYPE parkimi_admin_users_total gauge");
      L.push(`parkimi_admin_users_total ${db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n}`);
      L.push("# HELP parkimi_visitor_tokens_total Token-ët e vizitorëve të lëshuar");
      L.push("# TYPE parkimi_visitor_tokens_total gauge");
      L.push(`parkimi_visitor_tokens_total ${db.prepare("SELECT COUNT(*) AS n FROM visitor_tokens").get().n}`);
    } catch { /* grupi anashkalohet */ }

    try {
      // Madhësia e skedarit SQLite (vetëm kur databaza është në disk)
      if (db.name && db.name !== ":memory:") {
        L.push("# HELP parkimi_db_size_bytes Madhësia e skedarit të databazës SQLite");
        L.push("# TYPE parkimi_db_size_bytes gauge");
        L.push(`parkimi_db_size_bytes ${fs.statSync(db.name).size}`);
      }
    } catch { /* grupi anashkalohet */ }
  }

  // Handler për GET /metrics
  function handler() {
    return (req, res) => {
      try {
        res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(render());
      } catch {
        res.status(500).end();
      }
    };
  }

  return { middleware, handler };
}

module.exports = { createMetrics };
