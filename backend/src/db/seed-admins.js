"use strict";

// Krijon llogaritë e administratorëve të ekipit me fjalëkalime fillestare
// të rastësishme (8 shifra, crypto.randomInt) dhe must_change_password=1 —
// secili detyrohet ta ndryshojë fjalëkalimin në hyrjen e parë.
//
// Përdorimi:
//   npm run seed:admins                      (lokalisht, kundrejt DB_PATH)
//   docker compose exec backend node src/db/seed-admins.js   (në Docker)
//
// Idempotent: llogaritë ekzistuese NUK preken (as fjalëkalimi, as roli).
// Fjalëkalimet shfaqen VETËM një herë në stdout — nuk ruhen askund në tekst
// të hapur dhe nuk futen kurrë në Git. Në databazë ruhet vetëm hash-i scrypt.

const crypto = require("crypto");
const config = require("../config");
const { createDb } = require("./index");
const { hashPassword } = require("../lib/passwords");

const TEAM_ADMINS = ["emir", "erblin", "isra", "erdi", "loresa", "blendi"];

// Vlerat që validimi i fjalëkalimeve i refuzon (shih config.adminAuthStatus)
const FORBIDDEN = new Set(["12345678"]);

function generateNumericPassword(length = 8) {
  let s;
  do {
    s = "";
    for (let i = 0; i < length; i++) s += crypto.randomInt(0, 10);
  } while (FORBIDDEN.has(s));
  return s;
}

// Krijon llogaritë që mungojnë; kthen [{ username, status, password|null }].
function seedTeamAdmins(db, usernames = TEAM_ADMINS) {
  const insert = db.prepare(
    `INSERT INTO admin_users (username, password_hash, role, must_change_password)
     VALUES (?, ?, 'admin', 1)`
  );
  const find = db.prepare("SELECT id FROM admin_users WHERE username = ?");
  return usernames.map((username) => {
    if (find.get(username)) {
      return { username, status: "ekzistonte — e paprekur", password: null };
    }
    const password = generateNumericPassword();
    insert.run(username, hashPassword(password));
    return { username, status: "u krijua", password };
  });
}

if (require.main === module) {
  const db = createDb(config.dbPath);
  const results = seedTeamAdmins(db);
  db.close();

  console.log("Administratorët e ekipit (fjalëkalimet shfaqen VETËM këtu, një herë):\n");
  console.log("  Username   Fjalëkalimi fillestar   Statusi");
  console.log("  --------   ---------------------   -------");
  for (const r of results) {
    const pw = r.password || "—";
    console.log(`  ${r.username.padEnd(10)} ${pw.padEnd(23)} ${r.status}`);
  }
  console.log(
    "\nSecili admin duhet ta ndryshojë fjalëkalimin në hyrjen e parë (e detyruar)."
  );
}

module.exports = { seedTeamAdmins, generateNumericPassword, TEAM_ADMINS };
