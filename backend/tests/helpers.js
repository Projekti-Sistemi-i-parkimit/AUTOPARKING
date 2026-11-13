"use strict";

// Ndihmës për testet: ngre një server me databazë në memorie dhe kthen
// funksione të gatshme për kërkesa, admin token dhe çelës API.

const { createApp } = require("../src/app");
const { createDb } = require("../src/db");
const { seedBridgeKey } = require("../src/db/seed");

const TEST_CONFIG = {
  dbPath: ":memory:",
  occThresholdCm: 3,
  maxRangeCm: 10,
  sessionTtlHours: 1,
};

const ADMIN = { username: "admin-test", password: "fjalekalim-i-forte" };

async function startTestServer(configOverrides = {}) {
  const db = createDb(":memory:");
  const bridge = seedBridgeKey(db);
  // Kredencialet e adminit jepen përmes config-ut (si nga environment-i) —
  // databaza nuk është burim kredencialesh.
  const app = createApp({
    db,
    config: {
      ...TEST_CONFIG,
      adminUsername: ADMIN.username,
      adminPassword: ADMIN.password,
      ...configOverrides,
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;

  async function api(method, path, { body, token, apiKey, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* trupa jo-JSON (p.sh. HTML) */
    }
    return { status: res.status, json };
  }

  async function adminLogin() {
    const r = await api("POST", "/api/admin/login", { body: ADMIN });
    return r.json.token;
  }

  async function visitorLogin(name = "Testuesi", plate = "01-999-ZZ") {
    const r = await api("POST", "/api/login", { body: { name, plate } });
    return r.json.token;
  }

  function close() {
    app.locals.hub.close();
    server.close();
    db.close();
  }

  return { api, base, db, app, adminLogin, visitorLogin, bridgeKey: bridge.key, close };
}

module.exports = { startTestServer, ADMIN };