"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, ADMIN } = require("./helpers");
const { hashPassword, verifyPassword } = require("../src/lib/passwords");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

test("fjalëkalimet hash-ohen me scrypt dhe verifikohen saktë", () => {
  const h = hashPassword("sekret123");
  assert.notEqual(h, "sekret123");
  assert.ok(h.includes(":"));
  assert.ok(verifyPassword("sekret123", h));
  assert.ok(!verifyPassword("gabim", h));
});

test("login i suksesshëm kthen token dhe përditëson last_login", async () => {
  const r = await t.api("POST", "/api/admin/login", { body: ADMIN });
  assert.equal(r.status, 200);
  assert.ok(r.json.token.startsWith("at_"));
  assert.equal(r.json.role, "admin");

  const user = t.db.prepare("SELECT last_login FROM admin_users WHERE username = ?").get(ADMIN.username);
  assert.ok(user.last_login);

  // Token-i ruhet vetëm si hash në databazë
  const raw = t.db.prepare("SELECT token_hash FROM admin_sessions").all();
  assert.ok(raw.every((s) => s.token_hash !== r.json.token));
});

test("login i gabuar kthen 401 dhe regjistrohet në audit_log", async () => {
  const r = await t.api("POST", "/api/admin/login", {
    body: { username: ADMIN.username, password: "i-gabuar" },
  });
  assert.equal(r.status, 401);
  const failed = t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'login_failed'").get();
  assert.ok(failed);
});

test("rrugët admin refuzohen pa token ose me token të pavlefshëm", async () => {
  const noToken = await t.api("GET", "/api/admin/me");
  assert.equal(noToken.status, 401);

  const badToken = await t.api("GET", "/api/admin/me", { token: "at_i_rremë" });
  assert.equal(badToken.status, 401);
});

test("RBAC: operatori nuk menaxhon dot përdoruesit/çelësat (403)", async () => {
  const adminToken = await t.adminLogin();
  const created = await t.api("POST", "/api/admin/users", {
    token: adminToken,
    body: { username: "operator1", password: "fjalekalim1", role: "operator" },
  });
  assert.equal(created.status, 201);

  const opLogin = await t.api("POST", "/api/admin/login", {
    body: { username: "operator1", password: "fjalekalim1" },
  });
  const opToken = opLogin.json.token;

  const me = await t.api("GET", "/api/admin/me", { token: opToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.role, "operator");

  for (const [method, path] of [
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/api-keys"],
    ["GET", "/api/admin/audit-log"],
  ]) {
    const r = await t.api(method, path, { token: opToken, body: method === "POST" ? { name: "x" } : undefined });
    assert.equal(r.status, 403, `${method} ${path} duhet të kthejë 403 për operatorin`);
  }
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

test("audit_log regjistron veprimet kryesore", async () => {
  const token = await t.adminLogin();
  const r = await t.api("GET", "/api/admin/audit-log?limit=100", { token });
  assert.equal(r.status, 200);
  const actions = r.json.data.map((a) => a.action);
  for (const expected of ["login", "login_failed", "logout", "user_created", "api_key_created", "api_key_revoked"]) {
    assert.ok(actions.includes(expected), `audit_log duhet të përmbajë "${expected}"`);
  }
});

test("validimi i krijimit të përdoruesit: fjalëkalim i shkurtër 400, duplikat 409", async () => {
  const token = await t.adminLogin();
  const short = await t.api("POST", "/api/admin/users", {
    token,
    body: { username: "u2", password: "shkurt" },
  });
  assert.equal(short.status, 400);

  const dup = await t.api("POST", "/api/admin/users", {
    token,
    body: { username: "operator1", password: "fjalekalim1" },
  });
  assert.equal(dup.status, 409);
});