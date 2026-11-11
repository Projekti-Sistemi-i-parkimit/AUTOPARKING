"use strict";

/* ============================================================
   Ura e Arduino-s (Web Serial) + modaliteti demo.
   - Lexon serialin e Arduino-s (9600 baud) dhe dërgon të dhënat te
     backend-i me çelësin API që operatori e vendos vetë (ruhet vetëm
     në këtë pajisje).
   - Mbështet DY formate seriale:
     1) JSON (firmware i ri me 7 sensorë, arduino/parkimi-7-sensore):
        {"t":"spots","d":[{"s":1,"cm":4.2,"ok":1},…]}
        {"t":"gate","e":"entry"}
        {"t":"barrier","s":"open"|"closed"}
     2) Teksti i prototipit të vjetër me 2 sensorë:
        "Sensori 1 (D8/D9): 4.2 cm  |  Sensori 2 (D6/D7): Nuk ka matje"
   - Demo: matje të simuluara VETËM për prezantim — shënohet qartë në UI
     dhe kurrë nuk paraqitet si lexim real harduerik.
   ============================================================ */

const SerialBridge = (() => {
  const RX_S1 = /Sensori\s*1\s*\(D8\/D9\):\s*(Nuk ka matje|[\d.]+)\s*(cm)?/i;
  const RX_S2 = /Sensori\s*2\s*\(D6\/D7\):\s*(Nuk ka matje|[\d.]+)\s*(cm)?/i;
  const NUM_SPOTS = 6; // A-P1 … A-P6 (firmware i ri)

  const state = {
    port: null, reader: null, reading: false,
    demoTimer: null, demoPhase: 0,
    onLog: () => {}, onStatus: () => {},
    pushedSig: {}, // dedupe: dërgo vetëm kur ndryshon vlera e rrumbullakosur
    lastBarrier: null, // dedupe i gjendjes së barrierës
  };

  const supported = () => "serial" in navigator;
  const isConnected = () => !!state.port;
  const isDemo = () => !!state.demoTimer;

  // Hook global (p.sh. shiriti i navigimit tregon "DEMO") — i veçantë nga
  // onStatus i faqes së adminit, që rifreskimet e faqes të mos e mbishkruajnë.
  let onModeChange = () => {};
  function notifyMode() { state.onStatus(); try { onModeChange(); } catch { /* ignorohet */ } }

  function parseSensorText(m) {
    if (!m || m[1].toLowerCase().startsWith("nuk")) return { cm: null, ok: false };
    const v = parseFloat(m[1]);
    return isNaN(v) ? { cm: null, ok: false } : { cm: v, ok: true };
  }

  // Dërgon matjet te backend-i; statusin e klasifikon serveri.
  async function push(readings) {
    const key = API.store.bridgeKey;
    if (!key) { state.onLog("Mungon çelësi API i urës — vendose te fusha më poshtë", "err"); return; }
    const list = [];
    for (const r of readings) {
      const sig = r.cm == null ? "x" : Math.round(r.cm * 10);
      if (state.pushedSig[r.key] === sig) continue;
      state.pushedSig[r.key] = sig;
      list.push({ key: r.key, cm: r.cm, sensor_ok: r.ok });
    }
    if (!list.length) return;
    try {
      await API.pushSensor(list, key);
    } catch (e) {
      state.onLog(`Serveri refuzoi matjet: ${e.message}`, "err");
    }
  }

  async function forwardGate(type) {
    const key = API.store.bridgeKey;
    if (!key) return;
    try { await API.bridgeEvent(type, key); } catch (e) { state.onLog(`Ngjarja e hyrjes dështoi: ${e.message}`, "err"); }
  }

  async function forwardBarrier(status) {
    if (state.lastBarrier === status) return;
    state.lastBarrier = status;
    const key = API.store.bridgeKey;
    if (!key) return;
    try { await API.bridgeBarrier(status, key); } catch (e) { state.onLog(`Barriera dështoi: ${e.message}`, "err"); }
  }

  // Formati i ri JSON i firmware-it me 7 sensorë.
  function ingestJson(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return false; }
    if (!msg || typeof msg.t !== "string") return false;

    if (msg.t === "spots" && Array.isArray(msg.d)) {
      const readings = msg.d
        .filter((x) => Number.isInteger(x.s) && x.s >= 1 && x.s <= NUM_SPOTS)
        .map((x) => ({
          key: `A-P${x.s}`,
          cm: x.ok && typeof x.cm === "number" && x.cm >= 0 ? x.cm : null,
          ok: !!x.ok,
        }));
      if (readings.length) {
        state.onLog(
          readings.map((r) => `${r.key}:${r.cm == null ? "—" : r.cm.toFixed(1) + "cm"}`).join(" "),
          readings.every((r) => r.ok) ? "ok" : "err"
        );
        push(readings);
      }
      return true;
    }
    if (msg.t === "gate" && (msg.e === "entry" || msg.e === "exit")) {
      state.onLog(`Hyrja: u detektua veturë (${msg.e})`, "ok");
      forwardGate(msg.e);
      return true;
    }
    if (msg.t === "barrier" && (msg.s === "open" || msg.s === "closed")) {
      state.onLog(`Barriera: ${msg.s === "open" ? "u hap" : "u mbyll"}`, "ok");
      forwardBarrier(msg.s);
      return true;
    }
    return true; // JSON i vlefshëm por tip i panjohur — mos e provo si tekst
  }

  // Formati i vjetër tekstual (prototipi me 2 sensorë).
  function ingestText(line) {
    if (!/Sensori\s*1/i.test(line)) return;
    const s1 = parseSensorText(line.match(RX_S1));
    const s2 = parseSensorText(line.match(RX_S2));
    state.onLog(line.trim(), s1.ok && s2.ok ? "ok" : "err");
    push([
      { key: "A-P1", cm: s1.cm, ok: s1.ok },
      { key: "A-P2", cm: s2.cm, ok: s2.ok },
    ]);
  }

  function ingestLine(line) {
    if (line.startsWith("{")) { if (ingestJson(line)) return; }
    ingestText(line);
  }

  async function connect() {
    if (!supported()) throw new Error("Web Serial s'mbështetet — përdor Chrome ose Edge në desktop");
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: 9600 });
    notifyMode();
    state.onLog("USB serial u lidh me 9600 baud", "ok");
    readLoop();
  }

  async function readLoop() {
    state.reading = true;
    const decoder = new TextDecoderStream();
    state.port.readable.pipeTo(decoder.writable).catch(() => {});
    const reader = decoder.readable.getReader();
    state.reader = reader;
    let buffer = "";
    try {
      while (state.reading) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line) ingestLine(line);
        }
      }
    } catch (e) {
      if (state.reading) state.onLog(`Gabim serial: ${e.message}`, "err");
    } finally {
      try { reader.releaseLock(); } catch { /* ignorohet */ }
      state.reading = false;
    }
  }

  async function disconnect() {
    state.reading = false;
    try { if (state.reader) await state.reader.cancel(); } catch { /* ignorohet */ }
    try { if (state.port) await state.port.close(); } catch { /* ignorohet */ }
    state.port = null; state.reader = null;
    notifyMode();
    state.onLog("USB serial u shkëput");
  }

  // Modaliteti DEMO — simulon 6 sensorët e Sektorit A. Asnjëherë nuk
  // paraqitet si harduer real: shënohet në log, në faqen Arduino dhe
  // me shenjën "DEMO" në shiritin e navigimit.
  function startDemo() {
    if (state.demoTimer) return;
    state.demoPhase = 0;
    state.onLog("Modaliteti DEMO — matje të simuluara (jo nga hardueri)", "err");
    state.demoTimer = setInterval(() => {
      const t = ++state.demoPhase;
      const readings = [];
      for (let s = 1; s <= NUM_SPOTS; s++) {
        // valë të ndryshme për çdo vend: disa kalojnë pragun 3 cm, disa jo
        const cm = +(4.5 + 3.2 * Math.sin(t / (2 + s * 0.7) + s * 1.3)).toFixed(1);
        readings.push({ key: `A-P${s}`, cm: Math.max(0.5, cm), ok: true });
      }
      state.onLog(`[demo] ${readings.map((r) => `${r.key}:${r.cm}cm`).join(" ")}`, "ok");
      push(readings);
    }, 1800);
    notifyMode();
  }

  function stopDemo() {
    if (!state.demoTimer) return;
    clearInterval(state.demoTimer);
    state.demoTimer = null;
    state.onLog("Demo u ndal");
    notifyMode();
  }

  return {
    supported, isConnected, isDemo, connect, disconnect, startDemo, stopDemo,
    setHandlers({ onLog, onStatus }) {
      if (onLog) state.onLog = onLog;
      if (onStatus) state.onStatus = onStatus;
    },
    set onModeChange(fn) { onModeChange = typeof fn === "function" ? fn : () => {}; },
  };
})();