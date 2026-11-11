"use strict";

const path = require("path");
const fs = require("fs");

// Ngarkon .env nëse ekziston (Node 20.12+ e ka të integruar).
const envFile = path.join(__dirname, "..", ".env");
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
  // Pragjet e klasifikimit të distancës (shih README: ≤3cm = e zënë, ≤10cm = e lirë)
  occThresholdCm: parseFloat(process.env.OCC_THRESHOLD_CM || "3"),
  maxRangeCm: parseFloat(process.env.MAX_RANGE_CM || "10"),
};

module.exports = config;