"use strict";

// D7: skema e databazës ndryshon vetëm me migrim të ri + fotografi të përditësuar,
// që çdo ndryshim të shihet dhe të rishikohet në Git.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { currentSchema, SNAPSHOT } = require("../scripts/schema-snapshot");
const { runMigrations, listMigrations } = require("../src/db/migrate");
const { createDb } = require("../src/db");

test("D7: skema përputhet me src/db/schema.snapshot.sql (npm run db:snapshot pas një migrimi)", () => {
  const expected = fs.readFileSync(SNAPSHOT, "utf8").replace(/\r\n/g, "\n");
  assert.equal(currentSchema(), expected);
});

test("D7: emrat e migrimeve janë të numëruar pa vrima dhe pa dublikime", () => {
  const nums = listMigrations().map((f) => Number(f.slice(0, 3)));
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

test("D7: një migrim i aplikuar që ndryshohet më pas refuzohet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parkimi-mig-"));
  fs.writeFileSync(path.join(dir, "001_test.sql"), "CREATE TABLE t1 (id INTEGER);");
  const db = createDb(":memory:");
  db.exec("DELETE FROM schema_migrations");
  assert.deepEqual(runMigrations(db, dir), ["001_test.sql"]);
  fs.writeFileSync(path.join(dir, "001_test.sql"), "CREATE TABLE t1 (id INTEGER, x TEXT);");
  assert.throws(() => runMigrations(db, dir), /ndryshuar pasi u aplikua/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
