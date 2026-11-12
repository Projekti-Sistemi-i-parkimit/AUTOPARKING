"use strict";

const { Router } = require("express");
const { HttpError } = require("../middleware/errors");
const { requireAdmin, requireRole } = require("../middleware/auth");
const { safeEqual } = require("../lib/passwords");
const { ensureEnvAdmin } = require("../db/seed");
const { generateToken, hashToken } = require("../lib/tokens");
const { requireString, requireEnum, pagination, paginated } = require("../lib/validate");
const { logAction } = require("../services/audit");

// Rrugët administrative (M3): hyrja/dalja, menaxhimi i përdoruesve dhe
// çelësave API, dhe leximi i audit log-ut. Të gjitha përveç login-it
// kërkojnë Bearer token; veprimet e ndjeshme kërkojnë rolin "admin" (RBAC).
module.exports = function adminRoutes(db, config, hub, adminAuth, parking) {
  const router = Router();

  // Kufizues i përpjekjeve të dështuara të login-it (mbrojtje nga brute-force).
  // Në memorie, për IP: pas MAX dështimeve brenda dritares kthehet 429.
  const LOGIN_WINDOW_MS = 15 * 60_000;
  const LOGIN_MAX_FAILS = 10;
  const loginFails = new Map(); // ip → { count, first }
  function loginBlocked(ip) {
    const e = loginFails.get(ip);
    if (!e) return false;
    if (Date.now() - e.first > LOGIN_WINDOW_MS) { loginFails.delete(ip); return false; }
    return e.count >= LOGIN_MAX_FAILS;
  }
  function recordLoginFail(ip) {
    const e = loginFails.get(ip);
    if (!e || Date.now() - e.first > LOGIN_WINDOW_MS) {
      loginFails.set(ip, { count: 1, first: Date.now() });
    } else {
      e.count += 1;
    }
  }

  // POST /api/admin/login  { username, password } → { token, role, expires_at }
  // Kredencialet verifikohen VETËM kundrejt Environment Variables
  // (ADMIN_USERNAME / ADMIN_PASSWORD), me krahasim timing-safe.
  // Databaza nuk është burim kredencialesh — mban vetëm identitetin për sesionin.
  router.post("/admin/login", (req, res) => {
    if (loginBlocked(req.ip)) {
      throw new HttpError(429, "Shumë përpjekje të dështuara — provo përsëri pas 15 minutash");
    }
    if (!adminAuth || !adminAuth.enabled) {
      throw new HttpError(503, "Hyrja e adminit nuk është e konfiguruar në server — kontakto administratorin e sistemit");
    }
    const username = requireString((req.body || {}).username, "username", { max: 50 });
    const password = requireString(req.body.password, "password", { max: 200 });
    // Të dyja krahasimet kryhen gjithmonë (pa short-circuit të hershëm)
    const okUser = safeEqual(username, config.adminUsername);
    const okPass = safeEqual(password, config.adminPassword);
    if (!okUser || !okPass) {
      recordLoginFail(req.ip);
      logAction(db, null, "login_failed", { username });
      throw new HttpError(401, "Emri i përdoruesit ose fjalëkalimi është gabim");
    }
    loginFails.delete(req.ip);
    const user = { ...ensureEnvAdmin(db, config.adminUsername), role: "admin" };
    const token = generateToken("at_");
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
    db.prepare(
      "INSERT INTO admin_sessions (admin_user_id, token_hash, expires_at) VALUES (?, ?, ?)"
    ).run(user.id, hashToken(token), expiresAt);
    db.prepare("UPDATE admin_users SET last_login = datetime('now') WHERE id = ?").run(user.id);
    logAction(db, user.id, "login", { username });
    res.json({ token, role: user.role, username: user.username, expires_at: expiresAt });
  });

  const auth = requireAdmin(db);

  // POST /api/admin/logout
  router.post("/admin/logout", auth, (req, res) => {
    db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(req.adminSessionId);
    logAction(db, req.admin.id, "logout");
    res.json({ ok: true });
  });

  // GET /api/admin/me
  router.get("/admin/me", auth, (req, res) => {
    res.json(req.admin);
  });

  // GET /api/admin/users (vetëm roli admin)
  router.get("/admin/users", auth, requireRole("admin"), (req, res) => {
    const rows = db
      .prepare("SELECT id, username, role, last_login, created_at FROM admin_users ORDER BY id")
      .all();
    res.json({ data: rows });
  });

  // POST /api/admin/users — HEQUR: kredencialet nuk ruhen më në databazë.
  // Llogaria e adminit menaxhohet vetëm me ADMIN_USERNAME / ADMIN_PASSWORD
  // në environment (lokalisht .env, Docker Compose, Render Environment).
  router.post("/admin/users", auth, requireRole("admin"), () => {
    throw new HttpError(
      410,
      "Llogaritë nuk krijohen më nga paneli — kredencialet menaxhohen me Environment Variables (ADMIN_USERNAME / ADMIN_PASSWORD)"
    );
  });

  // GET /api/admin/api-keys (vetëm roli admin) — kurrë nuk kthen hash-et
  router.get("/admin/api-keys", auth, requireRole("admin"), (req, res) => {
    const rows = db
      .prepare("SELECT id, name, created_at, expires_at, is_active FROM api_keys ORDER BY id")
      .all();
    res.json({ data: rows.map((r) => ({ ...r, is_active: !!r.is_active })) });
  });

  // POST /api/admin/api-keys  { name, expires_at? } → çelësi i plotë kthehet VETËM këtu
  router.post("/admin/api-keys", auth, requireRole("admin"), (req, res) => {
    const name = requireString((req.body || {}).name, "name", { max: 50 });
    let expiresAt = null;
    if (req.body.expires_at) {
      const t = new Date(req.body.expires_at);
      if (isNaN(t.getTime()) || t.getTime() <= Date.now()) {
        throw new HttpError(400, '"expires_at" duhet të jetë datë e vlefshme në të ardhmen');
      }
      expiresAt = t.toISOString();
    }
    const key = generateToken("pk_");
    const info = db
      .prepare("INSERT INTO api_keys (key_hash, name, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(key), name, expiresAt);
    logAction(db, req.admin.id, "api_key_created", { name, id: info.lastInsertRowid });
    res.status(201).json({ id: info.lastInsertRowid, name, key, expires_at: expiresAt });
  });

  // DELETE /api/admin/api-keys/:id — çaktivizon çelësin (vetëm roli admin)
  router.delete("/admin/api-keys/:id", auth, requireRole("admin"), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const info = db.prepare("UPDATE api_keys SET is_active = 0 WHERE id = ?").run(id);
    if (info.changes === 0) throw new HttpError(404, "Çelësi API nuk u gjet");
    logAction(db, req.admin.id, "api_key_revoked", { id });
    res.json({ ok: true });
  });

  // POST /api/admin/barrier  { status, reason? } — kontrolli i barrierës nga paneli
  // (i lejuar për admin dhe operator; regjistrohet në audit_log dhe barrier_events)
  router.post("/admin/barrier", auth, (req, res) => {
    const status = requireEnum((req.body || {}).status, "status", ["open", "closed"]);
    const reason = req.body.reason ? requireString(req.body.reason, "reason", { max: 200 }) : null;
    const source = `admin:${req.admin.username}`;
    const current = db.prepare("SELECT status FROM barrier_state WHERE id = 1").get();
    db.prepare("UPDATE barrier_state SET status = ?, updated_at = datetime('now') WHERE id = 1").run(status);
    db.prepare("INSERT INTO barrier_events (status, reason, source) VALUES (?, ?, ?)").run(status, reason, source);
    logAction(db, req.admin.id, "barrier_control", { status, reason });
    if (current.status !== status && hub) {
      hub.broadcast("barrier_update", { status, reason }, "barrier");
    }
    res.json({ ok: true, status, changed: current.status !== status });
  });

  // POST /api/admin/spots/:key/status  { status: "free"|"occupied" }
  // Menaxhimi manual i vendeve (admin + operator): statusi i sektorëve ONLINE
  // B/C vendoset nga paneli; Sektori A mbetet i kontrollueshëm për demonstrime
  // (por sensori/sweeper-i mund ta mbishkruajë kur Arduino flet ose hesht).
  router.post("/spots/:key/status", auth, (req, res) => {
    const status = requireEnum((req.body || {}).status, "status", ["free", "occupied"]);
    const spot = db.prepare("SELECT spot_key, has_sensor FROM spots WHERE spot_key = ?").get(req.params.key);
    if (!spot) throw new HttpError(404, `Vendi "${req.params.key}" nuk ekziston`);
    const changes = parking.ingest([{ key: spot.spot_key, status }], { recordReadings: false });
    logAction(db, req.admin.id, "spot_status_set", { key: spot.spot_key, status });
    res.json({ ok: true, key: spot.spot_key, status, changed: changes.length > 0 });
  });

  // GET /api/admin/audit-log?page=1&limit=50
  router.get("/admin/audit-log", auth, requireRole("admin"), (req, res) => {
    const pg = pagination(req.query);
    const total = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
    const rows = db
      .prepare(
        `SELECT a.id, a.action, a.details, a.created_at, u.username
         FROM audit_log a LEFT JOIN admin_users u ON u.id = a.admin_user_id
         ORDER BY a.id DESC LIMIT ? OFFSET ?`
      )
      .all(pg.limit, pg.offset);
    res.json(paginated(rows, pg, total));
  });

  return router;
};