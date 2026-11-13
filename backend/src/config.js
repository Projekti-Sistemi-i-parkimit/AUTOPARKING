"use strict";

const path = require("path");
const fs = require("fs");

// Burimi i VETËM i konfigurimit: .env në rrënjën e repo-s (Node 20.12+ e ka
// të integruar; nuk mbishkruan variablat e vendosura tashmë në environment).
// Docker Compose dhe Render i japin variablat direkt — .env është për zhvillim lokal.
const envFile = path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  dbPath: process.env.DB_PATH || path.join(__dirname, "..", "data", "parking.db"),
  adminUsername: process.env.ADMIN_USERNAME || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  bridgeApiKey: process.env.BRIDGE_API_KEY || "",
  sessionTtlHours: parseFloat(process.env.SESSION_TTL_HOURS || "12"),
  // URL-ja publike e faqes (p.sh. https://autoparkoje.onrender.com) — përdoret
  // në kodet QR që ato të hapen nga telefonat, jo "localhost". Bosh në zhvillim
  // lokal: frontend-i atëherë përdor adresën aktuale të shfletuesit.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
  // Pragjet e klasifikimit të distancës (shih README: ≤3cm = e zënë, ≤10cm = e lirë)
  occThresholdCm: parseFloat(process.env.OCC_THRESHOLD_CM || "3"),
  maxRangeCm: parseFloat(process.env.MAX_RANGE_CM || "10"),
  // Pas sa sekondash heshtjeje të Arduino-s vendet me sensor shënohen OFFLINE
  sensorOfflineS: parseFloat(process.env.SENSOR_OFFLINE_S || "45"),
};

// Validimi i kredencialeve të adminit nga environment-i — i NJËJTI mekanizëm
// lokalisht, në Docker dhe në Render (process.env). Placeholder-ët refuzohen
// GJITHMONË; pa variabla të vlefshme, autentikimi i adminit çaktivizohet.
const PLACEHOLDER_PASSWORDS = new Set([
  "ndrysho-kete-fjalekalim",
  "ndrysho-ketë-password",
  "ndrysho-kete-password",
  "changeme",
  "password",
  "admin",
  "12345678",
]);

function adminAuthStatus(username, password) {
  if (!username || !password) {
    return { enabled: false, reason: "ADMIN_USERNAME / ADMIN_PASSWORD mungojnë në environment" };
  }
  if (PLACEHOLDER_PASSWORDS.has(String(password).trim().toLowerCase())) {
    return { enabled: false, reason: "ADMIN_PASSWORD është placeholder — vendos një fjalëkalim real" };
  }
  if (String(password).length < 8) {
    return { enabled: false, reason: "ADMIN_PASSWORD është shumë i shkurtër (min. 8 karaktere)" };
  }
  return { enabled: true, reason: null };
}

module.exports = config;
module.exports.adminAuthStatus = adminAuthStatus;