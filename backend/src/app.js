"use strict";

const path = require("path");
const express = require("express");
const { createDb } = require("./db");
const { createParkingService } = require("./services/parking");
const { SseHub } = require("./realtime/sse");
const { notFound, errorHandler } = require("./middleware/errors");
const openapi = require("./docs/openapi");

const spotsRoutes = require("./routes/spots");
const bridgeRoutes = require("./routes/bridge");
const eventsRoutes = require("./routes/events");
const qrRoutes = require("./routes/qr");
const visitorRoutes = require("./routes/visitors");
const adminRoutes = require("./routes/admin");

// Faqja e Swagger UI — ngarkon asetet nga CDN për të mos shtuar varësi.
const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="sq"><head><meta charset="utf-8"><title>Parkimi API — Dokumentimi</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:"/api/openapi.json",dom_id:"#ui"});</script>
</body></html>`;

function createApp({ db, config }) {
  const app = express();
  const database = db || createDb(config.dbPath);
  const hub = new SseHub();
  const parking = createParkingService(database, config, hub);

  app.use(express.json({ limit: "256kb" }));

  // Frontend-i shërbehet nga dosja frontend/ (prototipi i vjetër mbetet në rrënjë).
  const frontendDir = path.join(__dirname, "..", "..", "frontend");
  app.use(express.static(frontendDir));
  app.get("/", (req, res) => res.sendFile(path.join(frontendDir, "index.html")));

  app.get("/api/health", (req, res) => res.json({ ok: true, uptime_s: Math.round(process.uptime()) }));
  app.get("/api/realtime", hub.handler());
  app.get("/api/openapi.json", (req, res) => res.json(openapi));
  app.get("/api/docs", (req, res) => res.type("html").send(SWAGGER_HTML));

  app.use("/api", spotsRoutes(database, parking));
  app.use("/api", bridgeRoutes(database, parking, hub));
  app.use("/api", eventsRoutes(database));
  app.use("/api", qrRoutes(database, hub));
  app.use("/api", visitorRoutes(database, parking, hub));
  app.use("/api", adminRoutes(database, config, hub));

  app.use(notFound);
  app.use(errorHandler);

  // Ekspozohen për testet dhe mbylljen e pastër.
  app.locals.db = database;
  app.locals.hub = hub;
  app.locals.parking = parking;
  return app;
}

module.exports = { createApp };