"use strict";

const { HttpError } = require("../middleware/errors");

// Parametrat e sistemit (D5). Pragjet e klasifikimit fillojnë nga config/.env; pasi
// administratori i ndryshon nga paneli, vlera ruhet në tabelën settings dhe ka përparësi.
// Përditësimi ndryshon edhe objektin config në memorie, që parking.js (i cili e lexon
// config-un në çdo klasifikim) të përdorë pragun e ri pa rinisje.
const DEFS = {
  occ_threshold_cm: { label: "Pragu i zënies (cm)", min: 0.5, max: 100, config: "occThresholdCm" },
  max_range_cm: { label: "Rrezja maksimale (cm)", min: 1, max: 400, config: "maxRangeCm" },
  tolerance_cm: { label: "Toleranca e ndryshimit (cm)", min: 0, max: 20 },
  sample_interval_s: { label: "Mostra periodike (s)", min: 10, max: 86400, integer: true },
  sensor_timeout_s: { label: "Sensori offline pas (s)", min: 5, max: 3600, integer: true },
  retention_sample_days: { label: "Ruajtja e mostrave (ditë)", min: 1, max: 3650, integer: true },
  retention_change_days: { label: "Ruajtja e ndryshimeve (ditë)", min: 1, max: 3650, integer: true },
};

function rows(db) {
  return Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r]));
}

function getSettings(db, config) {
  const stored = db.prepare("SELECT key, value, updated_at, updated_by FROM settings").all();
  const byKey = Object.fromEntries(stored.map((r) => [r.key, r]));
  const values = {};
  const meta = {};
  for (const [key, def] of Object.entries(DEFS)) {
    const row = byKey[key];
    values[key] = row ? Number(row.value) : Number(config[def.config]);
    meta[key] = {
      label: def.label,
      min: def.min,
      max: def.max,
      integer: !!def.integer,
      updated_at: row ? row.updated_at : null,
      updated_by: row ? row.updated_by : null,
    };
  }
  return { values, meta };
}

// Në nisje: vlerat e ruajtura të pragjeve kalojnë në config.
function loadSettingsIntoConfig(db, config) {
  const stored = rows(db);
  for (const [key, def] of Object.entries(DEFS)) {
    if (def.config && stored[key]) config[def.config] = Number(stored[key].value);
  }
}

function validatePatch(patch, current) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new HttpError(400, "Trupi i kërkesës duhet të jetë objekt");
  }
  const keys = Object.keys(patch);
  if (!keys.length) throw new HttpError(400, "Asnjë parametër për t'u ndryshuar");
  const next = { ...current };
  for (const key of keys) {
    const def = DEFS[key];
    if (!def) throw new HttpError(400, `Parametër i panjohur: ${key}`);
    const v = patch[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new HttpError(400, `"${key}" duhet të jetë numër`);
    }
    if (def.integer && !Number.isInteger(v)) throw new HttpError(400, `"${key}" duhet të jetë numër i plotë`);
    if (v < def.min || v > def.max) {
      throw new HttpError(400, `"${key}" duhet të jetë ndërmjet ${def.min} dhe ${def.max}`);
    }
    next[key] = v;
  }
  if (next.occ_threshold_cm >= next.max_range_cm) {
    throw new HttpError(400, "Pragu i zënies duhet të jetë më i vogël se rrezja maksimale");
  }
  if (next.retention_change_days < next.retention_sample_days) {
    throw new HttpError(400, "Ndryshimet duhet të ruhen të paktën sa mostrat");
  }
  return { keys, next };
}

function updateSettings(db, config, patch, updatedBy) {
  const { values } = getSettings(db, config);
  const { keys, next } = validatePatch(patch, values);
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                                    updated_by = excluded.updated_by`
  );
  db.transaction(() => {
    for (const key of keys) upsert.run(key, String(next[key]), updatedBy || null);
  })();
  for (const key of keys) if (DEFS[key].config) config[DEFS[key].config] = next[key];
  const changed = Object.fromEntries(keys.map((k) => [k, { from: values[k], to: next[k] }]));
  return { settings: getSettings(db, config), changed };
}

module.exports = { DEFS, getSettings, loadSettingsIntoConfig, updateSettings };
