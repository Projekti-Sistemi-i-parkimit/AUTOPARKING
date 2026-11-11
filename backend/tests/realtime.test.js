"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");

let t;
before(async () => { t = await startTestServer(); });
after(() => t.close());

// Lexon ngjarje SSE nga rrjedha derisa të plotësohet kushti ose të skadojë koha.
async function collectSse(url, { timeoutMs = 2000, until } = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ value: null, done: false }), 200)),
      ]);
      if (done) break;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = { event: "message", data: null };
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) ev.event = line.slice(7);
            if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.data !== null) events.push(ev);
        }
      }
      if (until && until(events)) break;
    }
  } finally {
    controller.abort();
  }
  return events;
}

test("SSE dërgon spot_update dhe stats kur ndryshon gjendja", async () => {
  const collecting = collectSse(`${t.base}/api/realtime`, {
    until: (evs) => evs.some((e) => e.event === "stats"),
  });
  await new Promise((r) => setTimeout(r, 150)); // klienti lidhet para ndryshimit
  await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P1", cm: 1.0 }] },
  });
  const events = await collecting;

  const spotUpdate = events.find((e) => e.event === "spot_update");
  assert.ok(spotUpdate, "duhet të vijë spot_update");
  assert.equal(spotUpdate.data.key, "A-P1");
  assert.equal(spotUpdate.data.status, "occupied");
  assert.ok(events.some((e) => e.event === "stats"), "duhet të vijë stats");
});

test("SSE nuk dërgon dublikata kur gjendja nuk ndryshon", async () => {
  // Vendos njëherë gjendjen, pastaj dërgo të njëjtën matje me klient të lidhur.
  await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P2", cm: 6.0 }] },
  });
  const collecting = collectSse(`${t.base}/api/realtime`, { timeoutMs: 900 });
  await new Promise((r) => setTimeout(r, 150));
  await t.api("POST", "/api/sensor", {
    apiKey: t.bridgeKey,
    body: { spots: [{ key: "A-P2", cm: 6.0 }] },
  });
  const events = await collecting;
  assert.equal(
    events.filter((e) => e.event === "spot_update" && e.data.key === "A-P2").length,
    0,
    "matja identike s'duhet të prodhojë spot_update"
  );
});

test("SSE mbështet shumë klientë njëkohësisht", async () => {
  const c1 = collectSse(`${t.base}/api/realtime`, { until: (e) => e.some((x) => x.event === "barrier_update") });
  const c2 = collectSse(`${t.base}/api/realtime`, { until: (e) => e.some((x) => x.event === "barrier_update") });
  await new Promise((r) => setTimeout(r, 150));
  await t.api("POST", "/api/barrier", { apiKey: t.bridgeKey, body: { status: "open" } });
  const [e1, e2] = await Promise.all([c1, c2]);
  assert.ok(e1.some((e) => e.event === "barrier_update"));
  assert.ok(e2.some((e) => e.event === "barrier_update"));
});

test("SSE dërgon gate_event për hyrje/dalje", async () => {
  const collecting = collectSse(`${t.base}/api/realtime`, {
    until: (e) => e.some((x) => x.event === "gate_event"),
  });
  await new Promise((r) => setTimeout(r, 150));
  await t.api("POST", "/api/events", { apiKey: t.bridgeKey, body: { type: "entry", plate: "04-000-GG" } });
  const events = await collecting;
  const gate = events.find((e) => e.event === "gate_event");
  assert.ok(gate);
  assert.equal(gate.data.type, "entry");
});