"use strict";

const crypto = require("crypto");

// Krahasim i sigurt (timing-safe) i dy vargjeve, edhe me gjatësi të ndryshme:
// të dyja hash-ohen me SHA-256 dhe digest-et krahasohen me timingSafeEqual,
// që koha e përgjigjes të mos japë asnjë informacion për vlerën e saktë.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Hash me scrypt (i integruar në Node) — pa varësi shtesë si bcrypt.
// Formati i ruajtur në databazë: "<salt hex>:<hash hex>"
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

module.exports = { safeEqual, hashPassword, verifyPassword };
