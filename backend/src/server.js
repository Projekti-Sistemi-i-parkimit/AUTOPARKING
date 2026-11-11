"use strict";

const config = require("./config");
const { createApp } = require("./app");

const app = createApp({ config });

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