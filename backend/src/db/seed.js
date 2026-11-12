"use strict";

// Inicializimi i të dhënave bazë — JO i kredencialeve!
// Kredencialet e adminit lexohen VETËM nga Environment Variables
// (ADMIN_USERNAME / ADMIN_PASSWORD) dhe verifikohen në kohë hyrjeje;
// databaza mban vetëm rreshtin e identitetit (për sesione dhe audit log).
//
// Përdorim: npm run seed  → gjeneron çelësin API të urës nëse mungon.

const config = require("../config");
const { createDb } = require("./index");
const { generateToken, hashToken } = require("../lib/tokens");

// Vlerë sentinel në kolonën password_hash — NUK është hash i vlefshëm scrypt,
// prandaj asnjë fjalëkalim i ruajtur në databazë s'mund të përdoret për hyrje.
const ENV_MANAGED_HASH = "env-managed";

// Siguron rreshtin e identitetit të adminit të environment-it (ADMIN_USERNAME).
// Idempotent, pa duplikate. NUK prek llogaritë e tjera të databazës (adminët
// me hash scrypt nga "npm run seed:admins") — vetëm rreshtin e vet. Nëse
// username-i përplaset me një llogari ekzistuese me hash scrypt, hash-i
// ruhet: të dyja mënyrat e hyrjes (env dhe databazë) mbeten të vlefshme.
function ensureEnvAdmin(db, username) {
  const existing = db
    .prepare("SELECT id, role FROM admin_users WHERE username = ?")
    .get(username);
  if (existing) {
    if (existing.role !== "admin") {
      db.prepare("UPDATE admin_users SET role = 'admin' WHERE id = ?").run(existing.id);
    }
    return { id: existing.id, username };
  }
  const info = db
    .prepare("INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run(username, ENV_MANAGED_HASH);
  return { id: info.lastInsertRowid, username };
}

function seedBridgeKey(db, rawKey) {
  const name = "arduino-bridge";
  const exists = db.prepare("SELECT 1 FROM api_keys WHERE name = ? AND is_active = 1").get(name);
  if (exists) return { created: false, reason: `çelësi aktiv "${name}" ekziston tashmë` };
  const key = rawKey || generateToken("pk_");
  db.prepare("INSERT INTO api_keys (key_hash, name) VALUES (?, ?)").run(hashToken(key), name);
  // Çelësi shfaqet vetëm nëse u gjenerua tani — ruaje, nuk rikthehet dot më.
  return { created: true, name, key: rawKey ? null : key };
}

// Seed-i i nisjes së serverit (idempotent, pa sekrete në logje).
// Çelësi API regjistrohet këtu VETËM kur jepet nga env (BRIDGE_API_KEY);
// gjenerimi automatik mbetet te "npm run seed" / CMD i Docker-it.
function bootstrap(db, cfg) {
  if (cfg.bridgeApiKey) {
    const bridge = seedBridgeKey(db, cfg.bridgeApiKey);
    console.log(
      bridge.created
        ? "✔ Çelësi API i urës u regjistrua nga BRIDGE_API_KEY"
        : `• Çelësi API: ${bridge.reason}`
    );
  }
}

if (require.main === module) {
  const db = createDb(config.dbPath);
  const bridge = seedBridgeKey(db, config.bridgeApiKey);
  if (bridge.created && bridge.key) {
    console.log(`✔ Çelësi API i urës (ruaje, shfaqet VETËM një herë):\n  ${bridge.key}`);
  } else if (bridge.created) {
    console.log("✔ Çelësi API i urës u regjistrua nga BRIDGE_API_KEY");
  } else {
    console.log(`• Çelësi API: ${bridge.reason}`);
  }
  console.log("• Admini: kredencialet lexohen nga ADMIN_USERNAME / ADMIN_PASSWORD (environment)");
  db.close();
}

module.exports = { seedBridgeKey, bootstrap, ensureEnvAdmin, ENV_MANAGED_HASH };
