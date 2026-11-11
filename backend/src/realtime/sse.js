"use strict";

// Qendra e Server-Sent Events (SSE).
// SSE u zgjodh në vend të WebSocket sepse: frontend-i është HTML statik dhe
// EventSource ka rilidhje automatike të integruar; komunikimi i nevojshëm është
// vetëm server → klient (ura dërgon me POST); nuk kërkon asnjë varësi shtesë.

const HEARTBEAT_MS = 25000;

class SseHub {
  constructor() {
    this.clients = new Set();
    this.lastPayload = new Map(); // dedupe: event+key → JSON i fundit i dërguar
    this.heartbeat = null;
  }

  // Express handler për GET /api/realtime
  handler() {
    return (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n"); // klienti ribëhet lidhja pas 3s nëse bie
      this.clients.add(res);
      if (!this.heartbeat) {
        this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
        this.heartbeat.unref?.();
      }
      req.on("close", () => {
        this.clients.delete(res);
        if (this.clients.size === 0 && this.heartbeat) {
          clearInterval(this.heartbeat);
          this.heartbeat = null;
        }
      });
    };
  }

  ping() {
    for (const res of this.clients) res.write(": ping\n\n");
  }

  // Dërgon një ngjarje te të gjithë klientët. dedupeKey (opsionale) shmang
  // dërgimin e të njëjtës përmbajtje dy herë radhazi për të njëjtin çelës.
  broadcast(event, data, dedupeKey) {
    const payload = JSON.stringify(data);
    if (dedupeKey) {
      const k = `${event}:${dedupeKey}`;
      if (this.lastPayload.get(k) === payload) return;
      this.lastPayload.set(k, payload);
    }
    const frame = `event: ${event}\ndata: ${payload}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

module.exports = { SseHub };