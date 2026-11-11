"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

test("POST /api/sensor refuzohet pa çelës API ose me çelës të gabuar", async () => {
  const noKey = await t.api("POST", "/api/sensor", { body: { spots: [{ key: "A-P1", cm: 2 }] } });
  assert.equal(noKey.status, 401);

  const badKey = await t.api("POST", "/api/sensor", {
    body: { spots: [{ key: "A-P1", cm: 2 }] },
    apiKey: "pk_i_gabuar",
  });
  assert.equal(badKey.status, 401);
});

test("POST /api/sensor klasifikon distancat sipas pragjeve", async () => {
  const r = await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P1", cm: 2.0 }, { key: "A-P2", cm: 7.0 }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.applied, 2);
  assert.equal(r.json.changed, 2);

  const state = await t.api("GET", "/api/state");
  assert.equal(state.json.spots["A-P1"].status, "occupied"); // ≤ 3cm
  assert.equal(state.json.spots["A-P2"].status, "free");     // ≤ 10cm
});

test("POST /api/sensor pranon status të dërguar direkt dhe raporton çelësa të panjohur", async () => {
  const r = await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "B-P1", status: "occupied" }, { key: "X-P9", cm: 1 }] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.unknown_keys, ["X-P9"]);

  const spot = await t.api("GET", "/api/spots/B-P1");
  assert.equal(spot.json.status, "occupied");
});

test("POST /api/sensor validon trupin e kërkesës", async () => {
  const empty = await t.api("POST", "/api/sensor", { apiKey: t.bridgeKey, body: {} });
  assert.equal(empty.status, 400);

  const badStatus = await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P1", status: "flying" }] },
  });
  assert.equal(badStatus.status, 400);

  const badJson = await t.api("POST", "/api/sensor", { apiKey: t.bridgeKey, body: "{jo json" });
  assert.equal(badJson.status, 400);
});

test("matja pa echo (cm: -1 / sensor_ok: false) jep status unknown", async () => {
  const r = await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P1", cm: -1, sensor_ok: false }] },
  });
  assert.equal(r.status, 200);
  const spot = await t.api("GET", "/api/spots/A-P1");
  assert.equal(spot.json.status, "unknown");
});

test("GET /api/spots/:key/readings ruan historikun me faqëzim", async () => {
  const r = await t.api("GET", "/api/spots/A-P1/readings?limit=2");
  assert.equal(r.status, 200);
  assert.ok(r.json.total >= 2);
  assert.ok(r.json.data.length <= 2);
});

test("GET /api/sensors kthen vetëm vendet me sensor", async () => {
  const r = await t.api("GET", "/api/sensors");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.data.map((s) => s.spot_key).sort(),
    ["A-P1", "A-P2", "A-P3", "A-P4", "A-P5", "A-P6"]
  );
});