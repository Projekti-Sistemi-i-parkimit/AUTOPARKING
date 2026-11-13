"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, ADMIN } = require("./helpers");
const { safeEqual } = require("../src/lib/passwords");
const { ENV_MANAGED_HASH } = require("../src/db/seed");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

test("safeEqual: krahasim i saktë dhe timing-safe", () => {
  assert.ok(safeEqual("sekret123", "sekret123"));
  assert.ok(!safeEqual("sekret123", "gabim"));
  assert.ok(!safeEqual("sekret123", "sekret1234")); // gjatësi të ndryshme — pa throw
  assert.ok(!safeEqual("", "x"));
});

test("login i suksesshëm me kredencialet nga environment-i kthen token", async () => {
  const r = await t.api("POST", "/api/admin/login", { body: ADMIN });
  assert.equal(r.status, 200);
  assert.ok(r.json.token.startsWith("at_"));
  assert.equal(r.json.role, "admin");
  assert.equal(r.json.username, ADMIN.username);

  const user = t.db.prepare("SELECT last_login FROM admin_users WHERE username = ?").get(ADMIN.username);
  assert.ok(user.last_login);

  // Token-i ruhet vetëm si hash në databazë
  const raw = t.db.prepare("SELECT token_hash FROM admin_sessions").all();
  assert.ok(raw.every((s) => s.token_hash !== r.json.token));
});

test("databaza nuk përmban asnjë kredencial të përdorshëm", () => {
  const rows = t.db.prepare("SELECT username, password_hash FROM admin_users").all();
  assert.equal(rows.length, 1, "vetëm një llogari admini — pa duplikate");
  for (const row of rows) {
    assert.equal(row.password_hash, ENV_MANAGED_HASH, "vetëm sentinel, asnjë hash fjalëkalimi");
    assert.ok(!row.password_hash.includes(":"), "asnjë format scrypt salt:hash");
  }
});

test("fjalëkalim i gabuar → 401 dhe regjistrohet në audit_log", async () => {
  const r = await t.api("POST", "/api/admin/login", {
    body: { username: ADMIN.username, password: "i-gabuar" },
  });
  assert.equal(r.status, 401);
  const failed = t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'login_failed'").get();
  assert.ok(failed);
});

test("username i gabuar → 401 edhe me fjalëkalim të saktë", async () => {
  const r = await t.api("POST", "/api/admin/login", {
    body: { username: "i-panjohur", password: ADMIN.password },
  });
  assert.equal(r.status, 401);
});

test("placeholder si ADMIN_PASSWORD → autentikimi çaktivizohet (503)", async () => {
  const srv = await startTestServer({ adminPassword: "ndrysho-kete-fjalekalim" });
  try {
    // Edhe vetë placeholder-i si përpjekje hyrjeje refuzohet
    const r = await srv.api("POST", "/api/admin/login", {
      body: { username: ADMIN.username, password: "ndrysho-kete-fjalekalim" },
    });
    assert.equal(r.status, 503);
    // Asnjë rresht identiteti nuk krijohet kur auth-i është i çaktivizuar
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n, 0);
  } finally {
    srv.close();
  }
});

test("variabla që mungojnë → login-i kthen 503, asnjë hyrje e mundur", async () => {
  const srv = await startTestServer({ adminUsername: "", adminPassword: "" });
  try {
    const r = await srv.api("POST", "/api/admin/login", { body: ADMIN });
    assert.equal(r.status, 503);
    const any = await srv.api("POST", "/api/admin/login", {
      body: { username: "admin", password: "admin" },
    });
    assert.equal(any.status, 503);
  } finally {
    srv.close();
  }
});

test("fjalëkalim shumë i shkurtër në environment → 503", async () => {
  const srv = await startTestServer({ adminPassword: "shkurt" });
  try {
    const r = await srv.api("POST", "/api/admin/login", {
      body: { username: ADMIN.username, password: "shkurt" },
    });
    assert.equal(r.status, 503);
  } finally {
    srv.close();
  }
});

test("rrugët admin refuzohen pa token ose me token të pavlefshëm", async () => {
  const noToken = await t.api("GET", "/api/admin/me");
  assert.equal(noToken.status, 401);

  const badToken = await t.api("GET", "/api/admin/me", { token: "at_i_rremë" });
  assert.equal(badToken.status, 401);
});

test("krijimi i përdoruesve nga paneli është hequr (410)", async () => {
  const token = await t.adminLogin();
  const r = await t.api("POST", "/api/admin/users", {
    token,
    body: { username: "operator1", password: "fjalekalim1", role: "operator" },
  });
  assert.equal(r.status, 410);
  // Asnjë llogari e re nuk u krijua
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n, 1);
});

test("logout e fshin sesionin dhe token-i s'punon më", async () => {
  const token = await t.adminLogin();
  const out = await t.api("POST", "/api/admin/logout", { token });
  assert.equal(out.status, 200);
  const me = await t.api("GET", "/api/admin/me", { token });
  assert.equal(me.status, 401);
});

test("çelësat API: krijohen, ruhen si hash, çaktivizohen", async () => {
  const token = await t.adminLogin();
  const created = await t.api("POST", "/api/admin/api-keys", {
    token,
    body: { name: "test-bridge-2" },
  });
  assert.equal(created.status, 201);
  const rawKey = created.json.key;
  assert.ok(rawKey.startsWith("pk_"));

  // Në databazë nuk ruhet kurrë çelësi i plotë
  const stored = t.db.prepare("SELECT key_hash FROM api_keys").all();
  assert.ok(stored.every((k) => k.key_hash !== rawKey));

  // Çelësi i ri funksionon për urën
  const use = await t.api("POST", "/api/sensor", {
    apiKey: rawKey,
    body: { spots: [{ key: "A-P1", cm: 5 }] },
  });
  assert.equal(use.status, 200);

  // Lista nuk ekspozon hash-e as çelësa
  const list = await t.api("GET", "/api/admin/api-keys", { token });
  assert.ok(list.json.data.every((k) => !k.key_hash && !k.key));

  // Pas çaktivizimit, çelësi refuzohet
  const revoke = await t.api("DELETE", `/api/admin/api-keys/${created.json.id}`, { token });
  assert.equal(revoke.status, 200);
  const rejected = await t.api("POST", "/api/sensor", {
    apiKey: rawKey,
    body: { spots: [{ key: "A-P1", cm: 5 }] },
  });
  assert.equal(rejected.status, 401);
});

test("audit_log regjistron veprimet kryesore dhe s'përmban fjalëkalime", async () => {
  const token = await t.adminLogin();
  const r = await t.api("GET", "/api/admin/audit-log?limit=100", { token });
  assert.equal(r.status, 200);
  const actions = r.json.data.map((a) => a.action);
  for (const expected of ["login", "login_failed", "logout", "api_key_created", "api_key_revoked"]) {
    assert.ok(actions.includes(expected), `audit_log duhet të përmbajë "${expected}"`);
  }
  // Asnjë fjalëkalim nuk shfaqet në detajet e audit-it
  const details = JSON.stringify(r.json.data);
  assert.ok(!details.includes(ADMIN.password));
});
