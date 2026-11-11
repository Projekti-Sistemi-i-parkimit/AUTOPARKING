"use strict";

// Krijon administratorin fillestar dhe çelësin API të urës së Arduino-s.
// Përdorim: npm run seed
// Idempotent: nuk mbishkruan admin ekzistues dhe nuk dyfishon çelësa.

const config = require("../config");
const { createDb } = require("./index");
const { hashPassword } = require("../lib/passwords");
const { generateToken, hashToken } = require("../lib/tokens");

function seedAdmin(db, { username, password }) {
  if (!username || !password) {
    return { created: false, reason: "ADMIN_USERNAME / ADMIN_PASSWORD mungojnë në .env" };
  }
  const exists = db.prepare("SELECT 1 FROM admin_users WHERE username = ?").get(username);
  if (exists) return { created: false, reason: `admini "${username}" ekziston tashmë` };
  db.prepare(
    "INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, 'admin')"
  ).run(username, hashPassword(password));
  return { created: true, username };
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

if (require.main === module) {
  const db = createDb(config.dbPath);
  const admin = seedAdmin(db, {
    username: config.adminUsername,
    password: config.adminPassword,
  });
  console.log(admin.created ? `✔ U krijua admini "${admin.username}"` : `• Admin: ${admin.reason}`);

  const bridge = seedBridgeKey(db, config.bridgeApiKey);
  if (bridge.created && bridge.key) {
    console.log(`✔ Çelësi API i urës (ruaje, shfaqet VETËM një herë):\n  ${bridge.key}`);
  } else if (bridge.created) {
    console.log("✔ Çelësi API i urës u regjistrua nga BRIDGE_API_KEY në .env");
  } else {
    console.log(`• Çelësi API: ${bridge.reason}`);
  }
  db.close();
}

module.exports = { seedAdmin, seedBridgeKey };