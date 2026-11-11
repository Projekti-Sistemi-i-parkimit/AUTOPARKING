"use strict";

/* ============================================================
   Ura e Arduino-s (Web Serial) + modaliteti demo.
   - Lexon serialin e Arduino-s (9600 baud) dhe dërgon matjet te backend-i
     me çelësin API që operatori e vendos vetë (ruhet vetëm në këtë pajisje).
   - Formati i linjës serial (nga firmware ekzistues):
     "Sensori 1 (D8/D9): 4.2 cm  |  Sensori 2 (D6/D7): Nuk ka matje"
   - Demo: matje të simuluara, vetëm për prezantim — shënohet qartë në UI.
   ============================================================ */

const SerialBridge = (() => {
  const RX_S1 = /Sensori\s*1\s*\(D8\/D9\):\s*(Nuk ka matje|[\d.]+)\s*(cm)?/i;
  const RX_S2 = /Sensori\s*2\s*\(D6\/D7\):\s*(Nuk ka matje|[\d.]+)\s*(cm)?/i;

  const state = {
    port: null, reader: null, reading: false,
    demoTimer: null, demoPhase: 0,
    onLog: () => {}, onStatus: () => {},
    pushedSig: {}, // dedupe: dërgo vetëm kur ndryshon vlera e rrumbullakosur
    occThreshold: 3, maxRange: 10,
  };

  const supported = () => "serial" in navigator;
  const isConnected = () => !!state.port;
  const isDemo = () => !!state.demoTimer;

  function parseSensor(m) {
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

  function ingestLine(line) {
    if (!/Sensori\s*1/i.test(line)) return;
    const s1 = parseSensor(line.match(RX_S1));
    const s2 = parseSensor(line.match(RX_S2));
    state.onLog(line.trim(), s1.ok && s2.ok ? "ok" : "err");
    push([
      { key: "A-P1", cm: s1.cm, ok: s1.ok },
      { key: "A-P2", cm: s2.cm, ok: s2.ok },
    ]);
  }

  async function connect() {
    if (!supported()) throw new Error("Web Serial s'mbështetet — përdor Chrome ose Edge në desktop");
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: 9600 });
    state.onStatus();
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
    state.onStatus();
    state.onLog("USB serial u shkëput");
  }

  function startDemo() {
    if (state.demoTimer) return;
    state.demoPhase = 0;
    state.onLog("Modaliteti DEMO — matje të simuluara (jo nga hardueri)", "err");
    state.demoTimer = setInterval(() => {
      const t = ++state.demoPhase;
      const p1 = +(1.5 + 1.2 * Math.sin(t / 2)).toFixed(1);
      const p2 = +(5.0 + 3.5 * Math.sin(t / 3 + 1)).toFixed(1);
      state.onLog(`[demo] Sensori 1: ${p1} cm | Sensori 2: ${p2} cm`, "ok");
      push([
        { key: "A-P1", cm: p1, ok: true },
        { key: "A-P2", cm: p2, ok: true },
      ]);
    }, 1800);
    state.onStatus();
  }

  function stopDemo() {
    if (!state.demoTimer) return;
    clearInterval(state.demoTimer);
    state.demoTimer = null;
    state.onLog("Demo u ndal");
    state.onStatus();
  }

  return {
    supported, isConnected, isDemo, connect, disconnect, startDemo, stopDemo,
    setHandlers({ onLog, onStatus }) {
      if (onLog) state.onLog = onLog;
      if (onStatus) state.onStatus = onStatus;
    },
  };
})();