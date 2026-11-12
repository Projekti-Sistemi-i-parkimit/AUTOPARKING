"use strict";

// Metrika në formatin e tekstit të Prometheus-it — pa varësi të jashtme.
// Parimi kryesor: dështimi i monitorimit NUK e prish kurrë aplikacionin
// (çdo regjistrim është në try/catch) dhe metrikat nuk përmbajnë kurrë
// kredenciale, token-ë, targa apo të dhëna personale — vetëm numërues.

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

function createMetrics(db) {
  const startedAt = Date.now();
  const requests = new Map(); // "METODA|statusi" → numër
  let errors = 0;
  let durSum = 0;
  let durCount = 0;
  const bucketCounts = new Array(DURATION_BUCKETS.length).fill(0);

  // Middleware: numëron çdo kërkesë HTTP të përfunduar dhe kohëzgjatjen e saj.
  function middleware(req, res, next) {
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      try {
        if (req.path === "/metrics") return; // vetë-skrapimi s'ka vlerë statistikore
        const key = `${req.method}|${res.statusCode}`;
        requests.set(key, (requests.get(key) || 0) + 1);
        if (res.statusCode >= 500) errors += 1;
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
    return L.join("\n") + "\n";
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
