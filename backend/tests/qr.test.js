"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

test("GET /api/qr/:key kthen kodin e vendit; 404 për vend të panjohur", async () => {
  const r = await t.api("GET", "/api/qr/A-P1");
  assert.equal(r.status, 200);
  assert.equal(r.json.spot_key, "A-P1");
  assert.equal(r.json.code, "A-P1");

  const missing = await t.api("GET", "/api/qr/ZZ-P1");
  assert.equal(missing.status, 404);
});

test("skanimi i QR ruan vendin dhe 'gjeje veturën' e kthen atë", async () => {
  const scan = await t.api("POST", "/api/qr/scan", {
    body: { code: "B-P5", plate: "02-222-bb" },
  });
  assert.equal(scan.status, 201);
  assert.equal(scan.json.key, "B-P5");
  assert.equal(scan.json.plate, "02-222-BB"); // normalizohet me shkronja të mëdha

  const find = await t.api("GET", "/api/qr/find?plate=02-222-bb");
  assert.equal(find.status, 200);
  assert.equal(find.json.spot_key, "B-P5");
});

test("skanimi i dytë e zëvendëson vendin e gjetur", async () => {
  await t.api("POST", "/api/qr/scan", { body: { code: "C-P7", plate: "02-222-BB" } });
  const find = await t.api("GET", "/api/qr/find?plate=02-222-BB");
  assert.equal(find.json.spot_key, "C-P7");
});

test("validimi i QR: kod i panjohur 404, targë që mungon 400", async () => {
  const badCode = await t.api("POST", "/api/qr/scan", { body: { code: "JO-KOD", plate: "03-333-CC" } });
  assert.equal(badCode.status, 404);

  const noPlate = await t.api("POST", "/api/qr/scan", { body: { code: "A-P1" } });
  assert.equal(noPlate.status, 400);

  const noScan = await t.api("GET", "/api/qr/find?plate=09-999-XX");
  assert.equal(noScan.status, 404);
});