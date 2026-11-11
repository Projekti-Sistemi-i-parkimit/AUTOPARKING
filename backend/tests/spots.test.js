"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

test("GET /api/health kthen ok", async () => {
  const r = await t.api("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("GET /api/spots kthen listë të faqëzuar", async () => {
  const r = await t.api("GET", "/api/spots?limit=5");
  assert.equal(r.status, 200);
  assert.equal(r.json.data.length, 5);
  assert.equal(r.json.page, 1);
  assert.ok(r.json.total >= 34);
  assert.ok(r.json.total_pages > 1);
});

test("GET /api/spots filtron sipas sektorit dhe statusit", async () => {
  const r = await t.api("GET", "/api/spots?sector=A");
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 6);
  assert.ok(r.json.data.every((s) => s.sector === "A"));

  const bad = await t.api("GET", "/api/spots?status=invalid");
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error);
});

test("GET /api/spots/:key kthen detaje; 404 për vend që s'ekziston", async () => {
  const r = await t.api("GET", "/api/spots/A-P1");
  assert.equal(r.status, 200);
  assert.equal(r.json.spot_key, "A-P1");
  assert.equal(r.json.status, "unknown");
  assert.equal(r.json.reservation, null);

  const missing = await t.api("GET", "/api/spots/ZZ-P99");
  assert.equal(missing.status, 404);
  assert.ok(missing.json.error);
});

test("GET /api/stats llogarit statistikat", async () => {
  const r = await t.api("GET", "/api/stats?sector=A");
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 6);
  assert.equal(typeof r.json.occupancy_pct, "number");
});

test("GET /api/state kthen formatin e frontend-it", async () => {
  const r = await t.api("GET", "/api/state");
  assert.equal(r.status, 200);
  assert.ok(r.json.spots["A-P1"]);
  assert.ok(Array.isArray(r.json.res));
  assert.ok(Array.isArray(r.json.sessions));
});

test("rruga e panjohur kthen 404 JSON", async () => {
  const r = await t.api("GET", "/api/nuk-ekziston");
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
});