"use strict";

// Regjistron veprimet e rëndësishme administrative në audit_log (skema auth).
function logAction(db, adminUserId, action, details) {
  db.prepare(
    "INSERT INTO audit_log (admin_user_id, action, details) VALUES (?, ?, ?)"
  ).run(adminUserId ?? null, action, details == null ? null : JSON.stringify(details));
}

module.exports = { logAction };