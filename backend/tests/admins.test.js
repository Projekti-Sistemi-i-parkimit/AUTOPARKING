"use strict";

// Adminët e ekipit (seed:admins): krijimi idempotent, hyrja me hash scrypt,
// ndryshimi i detyruar i fjalëkalimit fillestar dhe bashkëjetesa me
// adminin e environment-it.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, ADMIN } = require("./helpers");
const { seedTeamAdmins, TEAM_ADMINS, generateNumericPassword } = require("../src/db/seed-admins");
const { ENV_MANAGED_HASH } = require("../src/db/seed");

let t;
let creds; // { username → fjalëkalimi fillestar }
before(async () => {
  t = await startTestServer();
  const results = seedTeamAdmins(t.db);
  creds = Object.fromEntries(results.map((r) => [r.username, r.password]));
});
after(() => t.close());

test("gjenerimi i fjalëkalimit: 8 shifra numerike, jo i parashikueshëm trivialisht", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = generateNumericPassword();
    assert.match(p, /^\d{8}$/);
    assert.notEqual(p, "12345678");
    seen.add(p);
  }
  assert.ok(seen.size > 45, "fjalëkalimet duhet të jenë të rastësishme");
});

test("seed:admins krijon 6 adminët me hash scrypt dhe must_change_password=1", () => {
  const rows = t.db
    .prepare("SELECT username, password_hash, role, must_change_password FROM admin_users WHERE username != ?")
    .all(ADMIN.username);
  assert.deepEqual(rows.map((r) => r.username).sort(), [...TEAM_ADMINS].sort());
  for (const r of rows) {
    assert.equal(r.role, "admin");
    assert.equal(r.must_change_password, 1);
    assert.match(r.password_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/, "format scrypt salt:hash");
    assert.notEqual(r.password_hash, creds[r.username], "kurrë tekst i hapur");
  }
});

test("seed:admins është idempotent — ekzekutimi i dytë nuk prek asgjë", () => {
  const before_ = t.db.prepare("SELECT username, password_hash FROM admin_users ORDER BY id").all();
  const results = seedTeamAdmins(t.db);
  assert.ok(results.every((r) => r.status.startsWith("ekzistonte") && r.password === null));
  const after_ = t.db.prepare("SELECT username, password_hash FROM admin_users ORDER BY id").all();
  assert.deepEqual(after_, before_);
});

test("admini i databazës hyn me fjalëkalimin e vet dhe merr must_change_password", async () => {
  const r = await t.api("POST", "/api/admin/login", {
    body: { username: "erblin", password: creds.erblin },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.username, "erblin");
  assert.equal(r.json.role, "admin");
  assert.equal(r.json.must_change_password, true);
});

test("fjalëkalimi i një admini nuk hap llogarinë e një tjetri", async () => {
  const r = await t.api("POST", "/api/admin/login", {
    body: { username: "isra", password: creds.erblin },
  });
  assert.equal(r.status, 401);
});

test("me fjalëkalim fillestar lejohen vetëm /password, /logout dhe /me", async () => {
  const login = await t.api("POST", "/api/admin/login", {
    body: { username: "erdi", password: creds.erdi },
  });
  const token = login.json.token;

  const users = await t.api("GET", "/api/admin/users", { token });
  assert.equal(users.status, 403);
  assert.equal(users.json.must_change_password, true);

  const barrier = await t.api("POST", "/api/admin/barrier", { token, body: { status: "open" } });
  assert.equal(barrier.status, 403);

  const me = await t.api("GET", "/api/admin/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.must_change_password, true);
});

test("ndryshimi i fjalëkalimit: validimet, suksesi dhe heqja e bllokimit", async () => {
  const login = await t.api("POST", "/api/admin/login", {
    body: { username: "loresa", password: creds.loresa },
  });
  const token = login.json.token;

  // Fjalëkalim aktual i gabuar → 401
  let r = await t.api("POST", "/api/admin/password", {
    token,
    body: { current_password: "00000000", new_password: "FjalekalimIRi1" },
  });
  assert.equal(r.status, 401);

  // I ri shumë i shkurtër → 400
  r = await t.api("POST", "/api/admin/password", {
    token,
    body: { current_password: creds.loresa, new_password: "shkurt" },
  });
  assert.equal(r.status, 400);

  // I njëjtë me aktualin → 400
  r = await t.api("POST", "/api/admin/password", {
    token,
    body: { current_password: creds.loresa, new_password: creds.loresa },
  });
  assert.equal(r.status, 400);

  // Sukses → 200; bllokimi hiqet, i vjetri s'punon më, i riu po
  r = await t.api("POST", "/api/admin/password", {
    token,
    body: { current_password: creds.loresa, new_password: "FjalekalimIRi1" },
  });
  assert.equal(r.status, 200);

  const users = await t.api("GET", "/api/admin/users", { token });
  assert.equal(users.status, 200);

  const oldLogin = await t.api("POST", "/api/admin/login", {
    body: { username: "loresa", password: creds.loresa },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await t.api("POST", "/api/admin/login", {
    body: { username: "loresa", password: "FjalekalimIRi1" },
  });
  assert.equal(newLogin.status, 200);
  assert.equal(newLogin.json.must_change_password, false);
});

test("hyrja e adminit të environment-it nuk prek hash-et e adminëve të databazës", async () => {
  const hashesBefore = t.db
    .prepare("SELECT username, password_hash FROM admin_users WHERE username != ? ORDER BY username")
    .all(ADMIN.username);

  const r = await t.api("POST", "/api/admin/login", { body: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.json.must_change_password, false);

  const envRow = t.db
    .prepare("SELECT password_hash FROM admin_users WHERE username = ?")
    .get(ADMIN.username);
  assert.equal(envRow.password_hash, ENV_MANAGED_HASH);

  const hashesAfter = t.db
    .prepare("SELECT username, password_hash FROM admin_users WHERE username != ? ORDER BY username")
    .all(ADMIN.username);
  assert.deepEqual(hashesAfter, hashesBefore);
});

test("admini env s'mund ta ndryshojë fjalëkalimin nga paneli (menaxhohet në env)", async () => {
  const token = await t.adminLogin();
  const r = await t.api("POST", "/api/admin/password", {
    token,
    body: { current_password: ADMIN.password, new_password: "FjalekalimIRi1" },
  });
  assert.equal(r.status, 400);
});
