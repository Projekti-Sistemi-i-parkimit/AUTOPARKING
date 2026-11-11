"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

test("vizitori kyçet dhe rezervon një vend të lirë", async () => {
  const token = await t.visitorLogin("Arta", "03-100-AA");
  const end = Date.now() + 3600_000;

  const noAuth = await t.api("POST", "/api/reserve", { body: { key: "B-P1", end } });
  assert.equal(noAuth.status, 401);

  const r = await t.api("POST", "/api/reserve", { token, body: { key: "B-P1", end } });
  assert.equal(r.status, 201);

  const state = await t.api("GET", "/api/state");
  assert.equal(state.json.res.length, 1);
  assert.equal(state.json.res[0].key, "B-P1");
});

test("rezervimi i një vendi të zënë refuzohet me 409", async () => {
  await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P1", cm: 1.5 }] },
  });
  const token = await t.visitorLogin("Besa", "03-200-BB");
  const r = await t.api("POST", "/api/reserve", {
    token,
    body: { key: "A-P1", end: Date.now() + 3600_000 },
  });
  assert.equal(r.status, 409);
});

test("rezervimi me orë në të kaluarën refuzohet me 400", async () => {
  const token = await t.visitorLogin("Vera", "03-300-CC");
  const r = await t.api("POST", "/api/reserve", {
    token,
    body: { key: "B-P2", end: Date.now() - 1000 },
  });
  assert.equal(r.status, 400);
});

test("vizitori anulon vetëm rezervimin e vet", async () => {
  const token1 = await t.visitorLogin("Drini", "03-400-DD");
  const token2 = await t.visitorLogin("Era", "03-500-EE");
  await t.api("POST", "/api/reserve", { token: token1, body: { key: "B-P3", end: Date.now() + 3600_000 } });

  const foreign = await t.api("DELETE", "/api/reserve/B-P3", { token: token2 });
  assert.equal(foreign.status, 403);

  const own = await t.api("DELETE", "/api/reserve/B-P3", { token: token1 });
  assert.equal(own.status, 200);
});

test("kur vendi i rezervuar zihet, hapet qëndrim me emrin e rezervuesit", async () => {
  const token = await t.visitorLogin("Fjolla", "03-600-FF");
  await t.api("POST", "/api/reserve", { token, body: { key: "A-P2", end: Date.now() + 3600_000 } });

  await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P2", cm: 2.0 }] },
  });

  const state = await t.api("GET", "/api/state");
  const session = state.json.sessions.find((s) => s.key === "A-P2" && !s.end);
  assert.ok(session, "duhet të ketë qëndrim të hapur për A-P2");
  assert.equal(session.name, "Fjolla");
  assert.ok(!state.json.res.some((r) => r.key === "A-P2"), "rezervimi konsumohet nga qëndrimi");

  // Kur vendi lirohet, qëndrimi mbyllet
  await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P2", cm: 8.0 }] },
  });
  const after = await t.api("GET", "/api/state");
  const closed = after.json.sessions.find((s) => s.key === "A-P2");
  assert.ok(closed.end, "qëndrimi duhet të jetë i mbyllur");
});