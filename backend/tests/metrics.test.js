"use strict";

// Teston endpoint-in /metrics: format Prometheus, numërues të saktë,
// pa të dhëna sensitive.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, ADMIN } = require("./helpers");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

test("/metrics kthen formatin e Prometheus-it me numëruesit bazë", async () => {
  // Gjenerohen disa kërkesa: një 200 dhe një 404
  await t.api("GET", "/api/stats");
  await t.api("GET", "/api/rruge-qe-s-ekziston");

  const res = await fetch(t.base + "/metrics");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  const body = await res.text();

  assert.match(body, /parkimi_http_requests_total\{method="GET",status="200"\} \d+/);
  assert.match(body, /parkimi_http_requests_total\{method="GET",status="404"\} \d+/);
  assert.match(body, /parkimi_http_request_duration_seconds_count \d+/);
  assert.match(body, /parkimi_uptime_seconds \d+/);
  assert.match(body, /parkimi_db_up 1/);
});

test("/metrics nuk përmban kredenciale, token-ë apo të dhëna personale", async () => {
  const token = await t.adminLogin();
  await t.api("GET", "/api/admin/me", { token });
  const body = await (await fetch(t.base + "/metrics")).text();

  assert.ok(!body.includes(ADMIN.password), "pa fjalëkalime");
  assert.ok(!body.includes(token), "pa token-ë sesioni");
  assert.ok(!body.includes("plate"), "pa targa");
  // Vetëm emra metrikash të pritshme
  for (const line of body.split("\n")) {
    if (line && !line.startsWith("#")) {
      assert.match(line, /^parkimi_[a-z_]+(\{[^}]*\})? [\d.+-eInf]+$/, `rresht i papritur: ${line}`);
    }
  }
});

test("gabimet 5xx numërohen në parkimi_http_request_errors_total", async () => {
  const before5xx = /parkimi_http_request_errors_total (\d+)/.exec(
    await (await fetch(t.base + "/metrics")).text()
  )[1];
  // JSON i pavlefshëm → 400 (jo 5xx) — numëruesi s'duhet të rritet
  await t.api("POST", "/api/qr/scan", { body: "{jo-json", headers: { "Content-Type": "application/json" } });
  const after5xx = /parkimi_http_request_errors_total (\d+)/.exec(
    await (await fetch(t.base + "/metrics")).text()
  )[1];
  assert.equal(before5xx, after5xx);
});

test("metrikat e domenit: vende sipas sektorit/statusit, rezervime, sensorë, siguri", async () => {
  // Një rezervim real në sektorin B që gauge-i të ketë vlerë > 0
  const vt = (await t.api("POST", "/api/login", { body: { name: "Metrika", plate: "MM111MM" } })).json.token;
  await t.api("POST", "/api/reserve", { token: vt, body: { key: "B-P5", end: Date.now() + 3600_000 } });
  // Edhe një tentativë e dështuar (vend inekzistent → error counter)
  await t.api("POST", "/api/reserve", { token: vt, body: { key: "X-P1", end: Date.now() + 3600_000 } });

  const body = await (await fetch(t.base + "/metrics")).text();
  assert.match(body, /parkimi_spots_total\{sector="A"\} 6/);
  assert.match(body, /parkimi_spots_total\{sector="B"\} 12/);
  assert.match(body, /parkimi_spots_total\{sector="C"\} 20/);
  assert.match(body, /parkimi_spot_status\{sector="B",status="free"\} \d+/);
  assert.match(body, /parkimi_reservations_active\{sector="B"\} [1-9]/);
  assert.match(body, /parkimi_reservation_requests_total\{outcome="ok"\} [1-9]/);
  assert.match(body, /parkimi_reservation_requests_total\{outcome="error"\} [1-9]/);
  assert.match(body, /parkimi_parking_sessions_active\{sector="A"\} \d+/);
  assert.match(body, /parkimi_barrier_state\{status="closed"\} [01]/);
  assert.match(body, /parkimi_admin_users_total \d+/);
  assert.match(body, /parkimi_audit_events_total\{action="login"\} \d+/);
  // Pa PII: emri/targa e vizitorit nuk shfaqen kurrë
  assert.ok(!body.includes("MM111MM") && !body.includes("Metrika"));
});
