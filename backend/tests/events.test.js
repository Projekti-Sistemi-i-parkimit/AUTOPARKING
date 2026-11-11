"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

test("POST /api/events kërkon çelës API dhe tip të vlefshëm", async () => {
  const noKey = await t.api("POST", "/api/events", { body: { type: "entry" } });
  assert.equal(noKey.status, 401);

  const badType = await t.api("POST", "/api/events", { apiKey: t.bridgeKey, body: { type: "teleport" } });
  assert.equal(badType.status, 400);
});

test("ngjarjet e hyrjes/daljes regjistrohen dhe lexohen me filtrim", async () => {
  const entry = await t.api("POST", "/api/events", {
    apiKey: t.bridgeKey,
    body: { type: "entry", plate: "01-111-AA" },
  });
  assert.equal(entry.status, 201);
  assert.equal(entry.json.type, "entry");

  const exit = await t.api("POST", "/api/events", { apiKey: t.bridgeKey, body: { type: "exit" } });
  assert.equal(exit.status, 201);

  const all = await t.api("GET", "/api/events");
  assert.equal(all.status, 200);
  assert.equal(all.json.total, 2);

  const entries = await t.api("GET", "/api/events?type=entry");
  assert.equal(entries.json.total, 1);
  assert.equal(entries.json.data[0].plate, "01-111-AA");
});

test("barriera: gjendja fillestare, përditësimi dhe historiku", async () => {
  const initial = await t.api("GET", "/api/barrier");
  assert.equal(initial.status, 200);
  assert.equal(initial.json.status, "closed");

  const open = await t.api("POST", "/api/barrier", {
    apiKey: t.bridgeKey,
    body: { status: "open", reason: "hyrje e autorizuar" },
  });
  assert.equal(open.status, 200);
  assert.equal(open.json.changed, true);

  const same = await t.api("POST", "/api/barrier", { apiKey: t.bridgeKey, body: { status: "open" } });
  assert.equal(same.json.changed, false);

  const now = await t.api("GET", "/api/barrier");
  assert.equal(now.json.status, "open");

  const history = await t.api("GET", "/api/barrier/events");
  assert.equal(history.json.total, 2);

  const bad = await t.api("POST", "/api/barrier", { apiKey: t.bridgeKey, body: { status: "half-open" } });
  assert.equal(bad.status, 400);
});
test("POST /api/admin/barrier lejon kontrollin e barrierës nga admini me audit", async () => {
  const noAuth = await t.api("POST", "/api/admin/barrier", { body: { status: "open" } });
  assert.equal(noAuth.status, 401);

  const token = await t.adminLogin();
  const bad = await t.api("POST", "/api/admin/barrier", { token, body: { status: "error" } });
  assert.equal(bad.status, 400, "admini s'vendos dot statusin 'error' manualisht");

  const r = await t.api("POST", "/api/admin/barrier", { token, body: { status: "closed", reason: "test manual" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "closed");

  const now = await t.api("GET", "/api/barrier");
  assert.equal(now.json.status, "closed");

  const audit = t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'barrier_control'").get();
  assert.ok(audit, "kontrolli i barrierës duhet të regjistrohet në audit_log");
});
