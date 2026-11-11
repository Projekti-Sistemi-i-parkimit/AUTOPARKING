"use strict";

const { hashToken } = require("../lib/tokens");

function bearerToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

// Vërteton token-in e adminit (sesion i ruajtur si hash në databazë).
function requireAdmin(db) {
  return (req, res, next) => {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: "Kërkohet autentikim (Bearer token)" });
    const session = db
      .prepare(
        `SELECT s.id AS session_id, s.expires_at, u.id, u.username, u.role
         FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
         WHERE s.token_hash = ?`
      )
      .get(hashToken(token));
    if (!session) return res.status(401).json({ error: "Token i pavlefshëm" });
    if (new Date(session.expires_at).getTime() < Date.now()) {
      db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(session.session_id);
      return res.status(401).json({ error: "Sesioni ka skaduar" });
    }
    req.admin = { id: session.id, username: session.username, role: session.role };
    req.adminSessionId = session.session_id;
    next();
  };
}

// RBAC: lejon vetëm rolet e dhëna (p.sh. requireRole('admin')).
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      return res.status(403).json({ error: "Nuk keni të drejta për këtë veprim" });
    }
    next();
  };
}

// Vërteton çelësin API të urës së Arduino-s (header: x-api-key).
// Në databazë krahasohet vetëm hash-i SHA-256 i çelësit.
function requireApiKey(db) {
  return (req, res, next) => {
    const key = req.headers["x-api-key"];
    if (!key) return res.status(401).json({ error: "Kërkohet çelësi API (header x-api-key)" });
    const row = db
      .prepare("SELECT id, name, expires_at, is_active FROM api_keys WHERE key_hash = ?")
      .get(hashToken(key));
    if (!row || !row.is_active) return res.status(401).json({ error: "Çelës API i pavlefshëm" });
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ error: "Çelësi API ka skaduar" });
    }
    req.apiKey = { id: row.id, name: row.name };
    next();
  };
}

// Vërteton token-in e vizitorit (hyrja emër+targë nga frontend-i).
function requireVisitor(db) {
  return (req, res, next) => {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: "Duhet të kyçeni fillimisht" });
    const row = db
      .prepare("SELECT id, name, plate FROM visitor_tokens WHERE token_hash = ?")
      .get(hashToken(token));
    if (!row) return res.status(401).json({ error: "Token i pavlefshëm, kyçuni përsëri" });
    req.visitor = row;
    next();
  };
}

module.exports = { requireAdmin, requireRole, requireApiKey, requireVisitor };