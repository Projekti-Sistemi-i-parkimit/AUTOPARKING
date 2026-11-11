"use strict";

const { HttpError } = require("../middleware/errors");

// Ndihmës të vegjël validimi — kthejnë vlerën e pastruar ose hedhin HttpError 400.

function requireString(value, field, { max = 100, min = 1 } = {}) {
  if (typeof value !== "string" || value.trim().length < min) {
    throw new HttpError(400, `Fusha "${field}" është e detyrueshme`);
  }
  const v = value.trim();
  if (v.length > max) throw new HttpError(400, `Fusha "${field}" është shumë e gjatë (max ${max})`);
  return v;
}

function optionalNumber(value, field, { min, max } = {}) {
  if (value == null) return null;
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) throw new HttpError(400, `Fusha "${field}" duhet të jetë numër`);
  if (min !== undefined && n < min) throw new HttpError(400, `Fusha "${field}" duhet ≥ ${min}`);
  if (max !== undefined && n > max) throw new HttpError(400, `Fusha "${field}" duhet ≤ ${max}`);
  return n;
}

function requireEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `Fusha "${field}" duhet të jetë një nga: ${allowed.join(", ")}`);
  }
  return value;
}

function optionalEnum(value, field, allowed) {
  if (value == null) return null;
  return requireEnum(value, field, allowed);
}

// Faqëzimi: ?page=1&limit=50 → { page, limit, offset }
function pagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(1, parseInt(query.page || "1", 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit || String(defaultLimit), 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function paginated(data, { page, limit }, total) {
  return { data, page, limit, total, total_pages: Math.ceil(total / limit) };
}

module.exports = { requireString, optionalNumber, requireEnum, optionalEnum, pagination, paginated };