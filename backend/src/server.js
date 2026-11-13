"use strict";

const config = require("./config");
const { createApp } = require("./app");
const { bootstrap } = require("./db/seed");

const app = createApp({ config });

// Regjistron çelësin API të urës nga env nëse jepet (idempotent, pa sekrete
// në logje). Kredencialet e adminit NUK ruhen në databazë — verifikohen në
// kohë hyrjeje kundrejt ADMIN_USERNAME / ADMIN_PASSWORD nga environment-i.
bootstrap(app.locals.db, config);

// Sektori A (prototipi fizik): kontroll periodik — nëse Arduino nuk ka dërguar
// matje brenda pragut, vendet me sensor kalojnë në OFFLINE ("unknown").
const offlineSweep = setInterval(() => {
  try {
    app.locals.parking.sweepOfflineSensors(config.sensorOfflineS);
  } catch (e) {
    console.error("Sweep i sensorëve dështoi:", e.message);
  }
}, 15000);
offlineSweep.unref?.();

const server = app.listen(config.port, () => {
  console.log(`✔ Parkimi backend: http://localhost:${config.port}`);
  console.log(`  Dokumentimi i API-së: http://localhost:${config.port}/api/docs`);
});

function shutdown() {
  console.log("\nPo mbyllet serveri…");
  app.locals.hub.close();
  server.close(() => {
    app.locals.db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);