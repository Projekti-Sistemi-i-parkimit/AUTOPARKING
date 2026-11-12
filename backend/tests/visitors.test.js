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

test("rezervimi i një vendi të zënë refuzohet me 409; Sektori A me 403", async () => {
  // Admini e zë manualisht një vend online (B) — rezervimi "tani" refuzohet
  const admin = await t.adminLogin();
  await t.api("POST", "/api/admin/spots/B-P9/status", { token: admin, body: { status: "occupied" } });

  const token = await t.visitorLogin("Besa", "03-200-BB");
  const r = await t.api("POST", "/api/reserve", {
    token,
    body: { key: "B-P9", end: Date.now() + 3600_000 },
  });
  assert.equal(r.status, 409);

  // Sektori A (prototipi fizik) nuk rezervohet kurrë online
  const a = await t.api("POST", "/api/reserve", {
    token,
    body: { key: "A-P1", end: Date.now() + 3600_000 },
  });
  assert.equal(a.status, 403);

  await t.api("POST", "/api/admin/spots/B-P9/status", { token: admin, body: { status: "free" } });
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
  await t.api("POST", "/api/reserve", { token, body: { key: "B-P4", end: Date.now() + 3600_000 } });

  // Zënia reale (nga paneli i adminit — sektorët online s'kanë sensorë)
  const admin = await t.adminLogin();
  await t.api("POST", "/api/admin/spots/B-P4/status", { token: admin, body: { status: "occupied" } });

  const state = await t.api("GET", "/api/state");
  const session = state.json.sessions.find((s) => s.key === "B-P4" && !s.end);
  assert.ok(session, "duhet të ketë qëndrim të hapur për B-P4");
  assert.equal(session.name, "Fjolla");
  assert.ok(!state.json.res.some((r) => r.key === "B-P4"), "rezervimi kalon në 'active' dhe hiqet nga lista e pritjes");

  // Check-in-i real u regjistrua në rezervim
  const mine = await t.api("GET", "/api/my/reservations", { token });
  const activeRes = mine.json.data.find((r) => r.key === "B-P4");
  assert.equal(activeRes.status, "active");
  assert.ok(activeRes.checked_in_at, "koha reale e hyrjes regjistrohet");

  // Kur vendi lirohet: qëndrimi mbyllet dhe rezervimi përfundon me kohë reale daljeje
  await t.api("POST", "/api/admin/spots/B-P4/status", { token: admin, body: { status: "free" } });
  const after = await t.api("GET", "/api/state");
  const closed = after.json.sessions.find((s) => s.key === "B-P4");
  assert.ok(closed.end, "qëndrimi duhet të jetë i mbyllur");

  const mine2 = await t.api("GET", "/api/my/reservations", { token });
  const done = mine2.json.data.find((r) => r.key === "B-P4");
  assert.equal(done.status, "completed");
  assert.ok(done.checked_out_at >= done.checked_in_at, "koha reale e daljes regjistrohet");
});