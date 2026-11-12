"use strict";

// Rrjedha e re e rezervimeve: dy mënyrat (me orar / pa orar daljeje),
// mbivendosjet, QR-ja me token unik, check-in/check-out me kohë reale,
// dhe siguria e URL-së së rezervimit.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

const hour = 3600_000;

test("Mënyra A: rezervim me datë, orë hyrjeje dhe orë daljeje (edhe në të ardhmen)", async () => {
  const token = await t.visitorLogin("Agon", "04-100-AA");
  const start = Date.now() + 2 * hour;
  const r = await t.api("POST", "/api/reserve", {
    token,
    body: { key: "C-P1", start, end: start + 3 * hour },
  });
  assert.equal(r.status, 201);
  assert.ok(r.json.token.startsWith("rt_"), "kthehet token-i i QR-së");
  assert.equal(r.json.qr_path, `/#/r/${r.json.token}`);
  assert.equal(r.json.open_ended, false);

  // Rezervimi i ardhshëm NUK e shënon vendin si 'rezervuar' tani në hartë,
  // por shfaqet në listën e rezervimeve me starts_at në të ardhmen.
  const state = await t.api("GET", "/api/state");
  const row = state.json.res.find((x) => x.key === "C-P1");
  assert.ok(row && row.start === start);
});

test("Mënyra B: rezervim pa orar daljeje ('nuk e di ende kur do të dal')", async () => {
  const token = await t.visitorLogin("Blerta", "04-200-BB");
  const r = await t.api("POST", "/api/reserve", { token, body: { key: "C-P2", open_ended: true } });
  assert.equal(r.status, 201);
  assert.equal(r.json.end, null);
  assert.equal(r.json.open_ended, true);

  const info = await t.api("GET", `/api/reservation/${r.json.token}`);
  assert.equal(info.json.until, null, "pa orar daljeje");
  assert.equal(info.json.status, "reserved");
});

test("validimet: pa end dhe pa open_ended → 400; end para start → 400; e kaluara → 400", async () => {
  const token = await t.visitorLogin("Vesa", "04-300-CC");
  assert.equal((await t.api("POST", "/api/reserve", { token, body: { key: "C-P3" } })).status, 400);
  const start = Date.now() + hour;
  assert.equal(
    (await t.api("POST", "/api/reserve", { token, body: { key: "C-P3", start, end: start - 1000 } })).status,
    400
  );
  assert.equal(
    (await t.api("POST", "/api/reserve", { token, body: { key: "C-P3", start: Date.now() - hour, end: Date.now() + hour } })).status,
    400
  );
});

test("dy rezervime që përplasen refuzohen; intervalet e ndara lejohen", async () => {
  const t1 = await t.visitorLogin("Dion", "04-400-DD");
  const t2 = await t.visitorLogin("Era", "04-500-EE");
  const start = Date.now() + 24 * hour;

  const a = await t.api("POST", "/api/reserve", { token: t1, body: { key: "C-P4", start, end: start + 2 * hour } });
  assert.equal(a.status, 201);

  // Mbivendosje e pjesshme → 409
  const b = await t.api("POST", "/api/reserve", {
    token: t2,
    body: { key: "C-P4", start: start + hour, end: start + 3 * hour },
  });
  assert.equal(b.status, 409);

  // Interval i veçuar pas tij → OK
  const c = await t.api("POST", "/api/reserve", {
    token: t2,
    body: { key: "C-P4", start: start + 2 * hour, end: start + 4 * hour },
  });
  assert.equal(c.status, 201);

  // Rezervimi pa orar bllokon 24h për disponueshmërinë
  const d = await t.api("POST", "/api/reserve", { token: t1, body: { key: "C-P5", open_ended: true } });
  assert.equal(d.status, 201);
  const e = await t.api("POST", "/api/reserve", {
    token: t2,
    body: { key: "C-P5", start: Date.now() + 5 * hour, end: Date.now() + 6 * hour },
  });
  assert.equal(e.status, 409, "rezervimi i hapur mban vendin brenda 24h");
});

test("QR: skanimi hap rezervimin; i pavlefshëm/i anuluar/i skaduar raportohen qartë", async () => {
  const token = await t.visitorLogin("Fisnik", "04-600-FF");
  const r = await t.api("POST", "/api/reserve", { token, body: { key: "C-P6", end: Date.now() + 2 * hour } });
  const qr = r.json.token;

  // Skanim nga "telefon tjetër" (pa asnjë auth) — hap rezervimin, i njëjti çdo herë
  const s1 = await t.api("GET", `/api/reservation/${qr}`);
  assert.equal(s1.status, 200);
  assert.equal(s1.json.key, "C-P6");
  assert.equal(s1.json.status, "reserved");
  assert.ok(!JSON.stringify(s1.json).includes("04-600-FF"), "targa e plotë nuk ekspozohet");
  const s2 = await t.api("GET", `/api/reservation/${qr}`);
  assert.deepEqual(s2.json, s1.json, "skanimi i përsëritur s'krijon/ndryshon asgjë");

  // Token i pavlefshëm → 404, pa informacion
  assert.equal((await t.api("GET", "/api/reservation/rt_i-trilluar-123")).status, 404);
  assert.equal((await t.api("GET", "/api/reservation/1")).status, 404, "ID numerike s'hap asgjë");

  // I anuluar → statusi shfaqet
  await t.api("DELETE", "/api/reserve/C-P6", { token });
  const s3 = await t.api("GET", `/api/reservation/${qr}`);
  assert.equal(s3.json.status, "cancelled");

  // I skaduar → statusi shfaqet (rezervim 1-sekondësh në të shkuarën e afërt)
  const r2 = await t.api("POST", "/api/reserve", { token, body: { key: "C-P6", end: Date.now() + 1000 } });
  await new Promise((done) => setTimeout(done, 1100));
  const s4 = await t.api("GET", `/api/reservation/${r2.json.token}`);
  assert.equal(s4.json.status, "expired");
});

test("check-in/check-out me QR: kohët reale, statuset dhe idempotenca", async () => {
  const token = await t.visitorLogin("Genta", "04-700-GG");
  const r = await t.api("POST", "/api/reserve", { token, body: { key: "C-P7", open_ended: true } });
  const qr = r.json.token;

  // Check-out para check-in → 409
  assert.equal((await t.api("POST", `/api/reservation/${qr}/checkout`)).status, 409);

  const inR = await t.api("POST", `/api/reservation/${qr}/checkin`);
  assert.equal(inR.status, 200);
  assert.equal(inR.json.status, "active");
  assert.ok(inR.json.checked_in_at, "hyrja reale regjistrohet");

  // Vendi u zu realisht dhe qëndrimi mban emrin e rezervuesit
  const spot = await t.api("GET", "/api/spots/C-P7");
  assert.equal(spot.json.status, "occupied");
  assert.equal(spot.json.active_session.name, "Genta");

  // Check-in i dytë → 409 me mesazh të qartë, pa rezervim të ri
  assert.equal((await t.api("POST", `/api/reservation/${qr}/checkin`)).status, 409);

  const outR = await t.api("POST", `/api/reservation/${qr}/checkout`);
  assert.equal(outR.status, 200);
  assert.equal(outR.json.status, "completed");
  assert.ok(outR.json.checked_out_at >= outR.json.checked_in_at);
  assert.ok(outR.json.duration_s >= 0, "kohëzgjatja reale llogaritet");

  // Vendi u lirua dhe check-out-i i dytë → 409
  assert.equal((await t.api("GET", "/api/spots/C-P7")).json.status, "free");
  assert.equal((await t.api("POST", `/api/reservation/${qr}/checkout`)).status, 409);
});

test("rezervimi që fillon tani mbi vend të zënë → 409; check-in mbi vend të zënë → 409", async () => {
  const admin = await t.adminLogin();
  const token = await t.visitorLogin("Hana", "04-800-HH");

  // Rezervim i ardhshëm OK edhe pse vendi është i zënë tani
  await t.api("POST", "/api/admin/spots/C-P8/status", { token: admin, body: { status: "occupied" } });
  const future = await t.api("POST", "/api/reserve", {
    token,
    body: { key: "C-P8", start: Date.now() + 30 * hour, end: Date.now() + 32 * hour },
  });
  assert.equal(future.status, 201);

  // Por rezervimi "tani" → 409
  const nowRes = await t.api("POST", "/api/reserve", { token, body: { key: "C-P8", end: Date.now() + hour } });
  assert.equal(nowRes.status, 409);

  // Check-in kur dikush (walk-in) e ka zënë vendin → 409
  await t.api("POST", "/api/admin/spots/C-P9/status", { token: admin, body: { status: "free" } });
  const r = await t.api("POST", "/api/reserve", { token, body: { key: "C-P9", open_ended: true } });
  await t.api("POST", "/api/admin/spots/C-P9/status", { token: admin, body: { status: "occupied" } });
  assert.equal((await t.api("POST", `/api/reservation/${r.json.token}/checkin`)).status, 409);

  await t.api("POST", "/api/admin/spots/C-P8/status", { token: admin, body: { status: "free" } });
  await t.api("POST", "/api/admin/spots/C-P9/status", { token: admin, body: { status: "free" } });
});

test("kufiri: maksimumi 3 rezervime në fuqi për një targë", async () => {
  const token = await t.visitorLogin("Ilir", "04-900-II");
  const start = Date.now() + 48 * hour;
  for (let i = 0; i < 3; i++) {
    const r = await t.api("POST", "/api/reserve", {
      token,
      body: { key: `C-P${11 + i}`, start: start + i * 5 * hour, end: start + i * 5 * hour + hour },
    });
    assert.equal(r.status, 201);
  }
  const fourth = await t.api("POST", "/api/reserve", {
    token,
    body: { key: "C-P14", start: start + 20 * hour, end: start + 21 * hour },
  });
  assert.equal(fourth.status, 409);
});
