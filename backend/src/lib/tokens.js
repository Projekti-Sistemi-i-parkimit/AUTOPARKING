"use strict";

const crypto = require("crypto");

// Token-ët dhe çelësat API ruhen në databazë vetëm si hash SHA-256,
// kështu që një rrjedhje e databazës nuk ekspozon vlerat e përdorshme.

function generateToken(prefix = "") {
  return prefix + crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

module.exports = { generateToken, hashToken };