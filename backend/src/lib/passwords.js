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

module.exports = { safeEqual };
