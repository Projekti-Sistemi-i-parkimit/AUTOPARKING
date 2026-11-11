"use strict";

/* ============================================================
   Shërbimi i centralizuar i API-së.
   - Një pikë e vetme për URL-në bazë, gabimet HTTP, JSON dhe autentikimin.
   - Token-ët: admini (sessionStorage/localStorage), vizitori (localStorage).
   - Asnjë kredencial apo çelës nuk është i koduar në këtë skedar.
   ============================================================ */

const API = (() => {
  // E njëjta origjinë — backend-i shërben edhe frontend-in (port 3000 lokalisht).
  const BASE = "";

  const store = {
    get adminToken() { return localStorage.getItem("pi_admin_token"); },
    set adminToken(v) { v ? localStorage.setItem("pi_admin_token", v) : localStorage.removeItem("pi_admin_token"); },
    get admin() { try { return JSON.parse(localStorage.getItem("pi_admin") || "null"); } catch { return null; } },
    set admin(v) { v ? localStorage.setItem("pi_admin", JSON.stringify(v)) : localStorage.removeItem("pi_admin"); },
    get visitor() { try { return JSON.parse(localStorage.getItem("pi_visitor") || "null"); } catch { return null; } },
    set visitor(v) { v ? localStorage.setItem("pi_visitor", JSON.stringify(v)) : localStorage.removeItem("pi_visitor"); },
    get bridgeKey() { return localStorage.getItem("pi_bridge_key") || ""; },
    set bridgeKey(v) { v ? localStorage.setItem("pi_bridge_key", v) : localStorage.removeItem("pi_bridge_key"); },
    get rememberedUser() { return localStorage.getItem("pi_remember_user") || ""; },
    set rememberedUser(v) { v ? localStorage.setItem("pi_remember_user", v) : localStorage.removeItem("pi_remember_user"); },
  };

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // Thirrja bazë: kthen JSON ose hedh ApiError me mesazhin e serverit.
  async function request(method, path, { body, auth, apiKey } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth === "admin" && store.adminToken) headers["Authorization"] = `Bearer ${store.adminToken}`;
    if (auth === "visitor" && store.visitor?.token) headers["Authorization"] = `Bearer ${store.visitor.token}`;
    if (apiKey) headers["x-api-key"] = apiKey;

    let res;
    try {
      res = await fetch(BASE + path, {
        method, headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, "S'ka lidhje me serverin — kontrollo që backend-i është duke punuar");
    }
    let json = null;
    try { json = await res.json(); } catch { /* trup bosh */ }
    if (!res.ok) {
      // Token admini i skaduar/i pavlefshëm → pastro sesionin dhe njofto UI-në.
      if (res.status === 401 && auth === "admin" && store.adminToken) {
        store.adminToken = null; store.admin = null;
        document.dispatchEvent(new CustomEvent("admin:expired"));
      }
      if (res.status === 401 && auth === "visitor" && store.visitor) {
        store.visitor = null;
      }
      throw new ApiError(res.status, json?.error || `Gabim ${res.status}`);
    }
    return json;
  }

  const get = (p, o) => request("GET", p, o);
  const post = (p, body, o = {}) => request("POST", p, { ...o, body });
  const del = (p, o) => request("DELETE", p, o);

  return {
    ApiError, store,

    // Publike / lexim
    health: () => get("/api/health"),
    state: () => get("/api/state"),
    stats: (sector) => get(`/api/stats${sector ? `?sector=${encodeURIComponent(sector)}` : ""}`),
    spots: (params = {}) => get(`/api/spots?${new URLSearchParams(params)}`),
    spot: (key) => get(`/api/spots/${encodeURIComponent(key)}`),
    readings: (key, params = {}) => get(`/api/spots/${encodeURIComponent(key)}/readings?${new URLSearchParams(params)}`),
    sensors: () => get("/api/sensors"),
    gateEvents: (params = {}) => get(`/api/events?${new URLSearchParams(params)}`),
    barrier: () => get("/api/barrier"),
    barrierEvents: (params = {}) => get(`/api/barrier/events?${new URLSearchParams(params)}`),

    // QR
    qrInfo: (key) => get(`/api/qr/${encodeURIComponent(key)}`),
    qrScan: (code, plate) => post("/api/qr/scan", { code, plate }),
    qrFind: (plate) => get(`/api/qr/find?plate=${encodeURIComponent(plate)}`),

    // Vizitorët
    visitorLogin: async (name, plate) => {
      const r = await post("/api/login", { name, plate });
      store.visitor = { token: r.token, name: r.name, plate: r.plate };
      return r;
    },
    visitorLogout: () => { store.visitor = null; },
    reserve: (key, end) => post("/api/reserve", { key, end }, { auth: "visitor" }),
    cancelReserve: (key) => del(`/api/reserve/${encodeURIComponent(key)}`, { auth: "visitor" }),

    // Ura (çelësi jepet nga operatori në pajisjen me Arduino — s'ka çelës të koduar)
    pushSensor: (spots, apiKey) => post("/api/sensor", { spots }, { apiKey }),
    bridgeEvent: (type, apiKey) => post("/api/events", { type }, { apiKey }),
    bridgeBarrier: (status, apiKey) => post("/api/barrier", { status }, { apiKey }),

    // Admin
    adminLogin: async (username, password) => {
      const r = await post("/api/admin/login", { username, password });
      store.adminToken = r.token;
      store.admin = { username: r.username, role: r.role, expires_at: r.expires_at };
      return r;
    },
    adminLogout: async () => {
      try { await post("/api/admin/logout", undefined, { auth: "admin" }); } catch { /* sesioni mund të ketë skaduar */ }
      store.adminToken = null; store.admin = null;
    },
    adminMe: () => get("/api/admin/me", { auth: "admin" }),
    adminUsers: () => get("/api/admin/users", { auth: "admin" }),
    adminCreateUser: (u) => post("/api/admin/users", u, { auth: "admin" }),
    adminApiKeys: () => get("/api/admin/api-keys", { auth: "admin" }),
    adminCreateApiKey: (body) => post("/api/admin/api-keys", body, { auth: "admin" }),
    adminRevokeApiKey: (id) => del(`/api/admin/api-keys/${id}`, { auth: "admin" }),
    adminAudit: (params = {}) => get(`/api/admin/audit-log?${new URLSearchParams(params)}`, { auth: "admin" }),
    adminBarrier: (status, reason) => post("/api/admin/barrier", { status, reason }, { auth: "admin" }),
  };
})();