"use strict";

/* ============================================================
   Aplikacioni kryesor: tema, routing, SSE, pamjet publike.
   Pamjet: Ballina, Harta, Rezervo Parking, Gjej Veturën, QR Parking, Rezervimi (#/r/:token).
   Paneli admin jeton te js/admin.js (window.Admin).
   ============================================================ */

/* ---------- Ndihmës të përbashkët (përdoren edhe nga admin.js) ---------- */
const UI = (window.UI = {
  $: (id) => document.getElementById(id),
  esc: (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  STATUS_SQ: { free: "I lirë", occupied: "I zënë", reserved: "Rezervuar", unknown: "Pa sinjal" },
  badge: (status) => `<span class="badge ${status}">${UI.STATUS_SQ[status] || UI.esc(status)}</span>`,
  fmtDur: (ms) => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : m >= 1 ? `${m} min` : `${Math.floor(ms / 1000)} s`; },
  hm: (t) => new Date(t).toTimeString().slice(0, 5),
  fmtDt: (s) => { if (!s) return "—"; const d = new Date(typeof s === "number" ? s : s.includes("T") ? s : s + "Z"); return isNaN(d) ? UI.esc(s) : d.toLocaleString("sq-AL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); },

  toast(msg, type = "info", ms = 3500) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    UI.$("toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
  },

  modal(html, { wide = false } = {}) {
    const box = UI.$("modalBox");
    box.className = "modal-box" + (wide ? " wide" : "");
    box.innerHTML = `<button class="modal-close" onclick="UI.closeModal()" aria-label="Mbyll">✕</button>` + html;
    UI.$("modal").hidden = false;
  },
  closeModal() { UI.$("modal").hidden = true; },

  qrSvg(text, cells = 3) {
    try { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag(cells, 0); }
    catch { return "<small>QR s'u gjenerua</small>"; }
  },

  // Validimi i targës: 2-3 blloqe alfanumerike me vija ndarëse, p.sh. 01-234-AB
  validPlate: (p) => /^[A-Z0-9]{1,4}(-[A-Z0-9]{1,4}){1,2}$/.test(p),

  // Baza e URL-ve në kodet QR, me përparësi:
  //   1) mbivendosja lokale (Admin → Cilësimet, localStorage)
  //   2) PUBLIC_BASE_URL e serverit (merret nga /api/config në nisje)
  //   3) adresa aktuale e shfletuesit (zhvillim lokal)
  // Kështu QR-të e printuara nuk përmbajnë "localhost" (telefonat s'e hapin dot).
  serverPublicUrl: "",
  qrBase: () =>
    (localStorage.getItem("pi_public_url") || "").trim().replace(/\/+$/, "") ||
    UI.serverPublicUrl ||
    location.origin,
});
UI.$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") UI.closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") UI.closeModal(); });
// Ndërrimi i faqes (hash) e mbyll modalin — të mos mbetet i hapur mbi faqen e re
window.addEventListener("hashchange", () => UI.closeModal());

/* ---------- Tema ---------- */
const Theme = {
  set(name) {
    document.documentElement.setAttribute("data-theme", name);
    localStorage.setItem("pi_theme", name);
    UI.$("themeGlass").classList.toggle("on", name === "glass");
    UI.$("themeDark").classList.toggle("on", name === "dark");
  },
  init() {
    this.set(localStorage.getItem("pi_theme") || "glass");
    UI.$("themeGlass").onclick = () => this.set("glass");
    UI.$("themeDark").onclick = () => this.set("dark");
  },
};

/* ---------- Arkitektura hibride e sektorëve ----------
   A: prototip FIZIK me Arduino/sensorë — vetëm demonstrime, s'rezervohet online.
   B/C: parking ONLINE — rezervime nga çdo pajisje, pa varësi nga hardueri. */
const SECTOR_META = {
  A: { name: "Sektori A", floor: "Kati B1", live: true, online: false,
       label: "Prototip fizik – Arduino IoT", badge: "Demo fizike" },
  B: { name: "Sektori B", floor: "Kati B2", live: false, online: true,
       label: "Parking Online", badge: "Rezervime online" },
  C: { name: "Sektori C", floor: "Parkingu i jashtëm", live: false, online: true,
       label: "Parking Online", badge: "Rezervime online" },
};

/* ---------- Cache i të dhënave nga backend-i ---------- */
const Data = {
  state: { spots: {}, res: [], sessions: [] },
  stats: null,
  sectors: {}, // { A: [ {spot_key,label,...}, ... ] }

  async refreshState() { this.state = await API.state(); },
  async refreshStats() { this.stats = await API.stats(); },
  async refreshSpots() {
    const r = await API.spots({ limit: 200 });
    this.sectors = {};
    for (const s of r.data) (this.sectors[s.sector] = this.sectors[s.sector] || []).push(s);
  },

  reservationOf(key) { return this.state.res.find((r) => r.key === key) || null; },
  // Statusi vizual: "reserved" kur vendi është i lirë por ka rezervim aktiv.
  displayStatus(key) {
    const st = this.state.spots[key]?.status || "unknown";
    return st === "free" && this.reservationOf(key) ? "reserved" : st;
  },
};

/* ---------- SSE: përditësimet në kohë reale ---------- */
const Live = {
  es: null,
  refreshTimer: null,

  connect() {
    this.es = new EventSource("/api/realtime"); // rilidhje automatike nga shfletuesi
    this.es.onopen = () => this.setStatus(true);
    this.es.onerror = () => this.setStatus(false);

    this.es.addEventListener("spot_update", (e) => {
      const d = JSON.parse(e.data);
      Data.state.spots[d.key] = { status: d.status, cm: d.cm };
      this.rerender();
    });
    this.es.addEventListener("stats", (e) => { Data.stats = JSON.parse(e.data); this.rerender(); });
    this.es.addEventListener("reservation", () => this.refreshAnd());
    this.es.addEventListener("qr_scan", () => this.refreshAnd());
    this.es.addEventListener("gate_event", (e) => {
      const d = JSON.parse(e.data);
      UI.toast(`${d.type === "entry" ? "Hyrje" : "Dalje"} në parking${d.plate ? ` · ${d.plate}` : ""}`, "info");
      this.rerender();
    });
    this.es.addEventListener("barrier_update", (e) => {
      const d = JSON.parse(e.data);
      UI.toast(`Barriera: ${d.status === "open" ? "u hap" : d.status === "closed" ? "u mbyll" : "gabim"}`, d.status === "error" ? "error" : "ok");
      this.rerender();
    });
  },

  setStatus(on) {
    UI.$("liveChip").classList.toggle("on", on);
    UI.$("liveText").textContent = on ? "Live" : "Offline";
  },

  // Rifreskim i buferuar — shmang render-e të shumëfishta për breshëri ngjarjesh.
  rerender() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => Router.rerender(), 180);
  },
  async refreshAnd() {
    try { await Data.refreshState(); } catch { /* kalon */ }
    this.rerender();
  },
};

/* ---------- Router-i (hash) ---------- */
const Router = {
  current: null,

  parse() {
    const h = location.hash || "#/";
    // Formati i vjetër i QR-ve të vendeve: "#A-P1" → hap vendin në hartë
    const legacy = h.match(/^#([A-C])-(P\d+)$/);
    if (legacy) return { route: "map", spotKey: `${legacy[1]}-${legacy[2]}` };
    const m = h.match(/^#\/([a-z-]*)(?:\/([^?]*))?(?:\?(.*))?$/);
    if (!m) return { route: "home" };
    const q = Object.fromEntries(new URLSearchParams(m[3] || ""));
    if (m[1] === "spot" && m[2]) return { route: "map", spotKey: decodeURIComponent(m[2]) };
    return { route: m[1] || "home", sub: m[2] || null, q };
  },

  async go() {
    const r = this.parse();
    this.current = r;
    document.querySelectorAll(".nav-links a").forEach((a) =>
      a.classList.toggle("on", a.dataset.route === (r.route === "" ? "home" : r.route))
    );
    UI.$("navLinks").classList.remove("open");
    if (r.spotKey) Views.activeSector = r.spotKey.split("-")[0] || Views.activeSector;
    await this.render();
    if (r.spotKey) {
      Views.openSpot(r.spotKey);
      // Theksim vizual i vendit në planimetri (p.sh. nga "Gjej Veturën")
      document.querySelector(`[data-spot="${CSS.escape(r.spotKey)}"]`)?.classList.add("pulse");
    }
  },

  async render() {
    const v = UI.$("view");
    const r = this.current || { route: "home" };
    try {
      switch (r.route) {
        case "home": case "": await Views.home(v); break;
        case "map": await Views.map(v); break;
        case "reserve": await Views.reserve(v); break;
        case "r": await Views.reservation(v, r.sub); break; // faqja e QR-së së rezervimit
        case "find": await Views.find(v, r.q); break;
        case "qr": await Views.visitorQr(v); break;
        case "admin": await Admin.render(v, r.sub); break;
        default: v.innerHTML = `<div class="card card-pad"><h3>404</h3><p class="muted">Faqja nuk u gjet.</p></div>`;
      }
    } catch (e) {
      v.innerHTML = `<div class="alert error">Gabim në ngarkim: ${UI.esc(e.message)}</div>`;
    }
  },

  rerender() { this.render(); },
};
window.addEventListener("hashchange", () => Router.go());

/* ---------- Pamjet publike ---------- */
const Views = {
  /* ===== Ballina ===== */
  async home(v) {
    try { await Promise.all([Data.refreshStats(), Data.refreshState()]); } catch { /* shfaqet çfarë ka */ }
    let barrier = null, events = { data: [] };
    try { [barrier, events] = await Promise.all([API.barrier(), API.gateEvents({ limit: 5 })]); } catch { /* opsionale */ }
    const s = Data.stats || { total: 0, free: 0, occupied: 0, unknown: 0, reserved: 0, occupancy_pct: 0 };

    v.innerHTML = `
      <section class="card hero">
        <div class="hero-stripe"></div>
        <h1><em>AutoParking</em> — parkimi yt, pa kërkime të kota.</h1>
        <p>Rezervo vendin, skano QR-in dhe gjej veturën — gjithçka në tre hapa të thjeshtë.</p>
        <div class="home-actions">
          <a class="card action-card" href="#/reserve">
            <span class="a-icon">🅿️</span><b>Rezervo Parking</b>
            <small>Zgjidh vendin dhe orarin — ose rezervo pa orar daljeje</small></a>
          <a class="card action-card" href="#/qr">
            <span class="a-icon">▦</span><b>QR Parking</b>
            <small>Skano QR-in e rezervimit — statusi dhe check-in/out</small></a>
          <a class="card action-card" href="#/find">
            <span class="a-icon">🚗</span><b>Gjej Veturën</b>
            <small>Shih sektorin dhe vendin e veturës në hartën e parkingut</small></a>
        </div>
        <div class="hero-actions mt"><a class="btn btn-ghost" href="#/map">Shiko hartën e plotë →</a></div>
      </section>

      <div class="stats-grid">
        <div class="card stat-card"><span class="s-label">Vende gjithsej</span><span class="s-value">${s.total}</span><span class="s-icon">🅿️</span><span class="s-sub">në ${Object.keys(SECTOR_META).length} sektorë</span></div>
        <div class="card stat-card c-free"><span class="s-label">Të lira</span><span class="s-value">${s.free - s.reserved < 0 ? 0 : s.free - s.reserved}</span><span class="s-icon">✓</span><span class="s-sub">gati për parkim</span></div>
        <div class="card stat-card c-occ"><span class="s-label">Të zëna</span><span class="s-value">${s.occupied}</span><span class="s-icon">🚗</span><span class="s-sub">${s.occupancy_pct}% zënie</span></div>
        <div class="card stat-card c-warn"><span class="s-label">Rezervuar</span><span class="s-value">${s.reserved}</span><span class="s-icon">🕒</span><span class="s-sub">rezervime aktive</span></div>
        <div class="card stat-card c-off"><span class="s-label">Pa sinjal</span><span class="s-value">${s.unknown}</span><span class="s-icon">⚠</span><span class="s-sub">sensorë offline / pa mbulim</span></div>
      </div>

      <div class="grid-3 mt">
        <div class="card card-pad">
          <h3>Zënia e parkingut</h3>
          <div class="ring" style="--p:${s.occupancy_pct}"><div><span><b>${s.occupancy_pct}%</b><small>e zënë</small></span></div></div>
          <div class="bars">${Object.keys(SECTOR_META).map((k) => this.sectorBar(k)).join("")}</div>
        </div>
        <div class="card card-pad">
          <h3>Barriera &amp; hyrjet e fundit</h3>
          ${barrier ? `<div class="row-item" style="display:flex;justify-content:space-between;padding:8px 0"><span class="muted small">Gjendja e barrierës</span><span class="badge ${barrier.status}">${barrier.status === "open" ? "E hapur" : barrier.status === "closed" ? "E mbyllur" : "Gabim"}</span></div>` : `<p class="muted small">Barriera: pa të dhëna</p>`}
          <div class="list-rows">
            ${events.data.length ? events.data.map((e) => `
              <div class="row-item"><span><span class="badge ${e.type}">${e.type === "entry" ? "Hyrje" : "Dalje"}</span> ${e.plate ? `<span class="mono small">${UI.esc(e.plate)}</span>` : ""}</span><span class="muted small">${UI.fmtDt(e.created_at)}</span></div>`).join("")
            : `<p class="muted small" style="padding:10px 0">Ende pa ngjarje hyrje/dalje.</p>`}
          </div>
        </div>
        <div class="card card-pad">
          <h3>Qëndrimet e fundit</h3>
          <div class="list-rows">
            ${Data.state.sessions.slice(0, 6).map((ss) => `
              <div class="row-item"><span>${UI.esc(ss.name)} · <b>${UI.esc(ss.key)}</b></span><span class="muted small">${UI.fmtDur((ss.end || Date.now()) - ss.start)}${ss.end ? "" : " ●"}</span></div>`).join("") || `<p class="muted small" style="padding:10px 0">Ende pa qëndrime.</p>`}
          </div>
        </div>
      </div>`;
  },

  sectorBar(k) {
    const spots = Object.entries(Data.state.spots).filter(([key]) => key.startsWith(k + "-"));
    const occ = spots.filter(([, s]) => s.status === "occupied").length;
    const known = spots.filter(([, s]) => s.status !== "unknown").length;
    const pct = known ? Math.round((occ / known) * 100) : 0;
    return `<div class="bar-row"><span>${SECTOR_META[k].name}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><b>${pct}%</b></div>`;
  },

  /* ===== Harta e parkimit ===== */
  activeSector: "A",
  async map(v) {
    try { await Promise.all([Data.refreshSpots(), Data.refreshState()]); } catch { /* vazhdon me cache */ }
    const k = this.activeSector;
    const meta = SECTOR_META[k];
    const spots = Data.sectors[k] || [];
    const half = Math.ceil(spots.length / 2);
    const top = spots.length > 2 ? spots.slice(0, half) : [];
    const bottom = spots.length > 2 ? spots.slice(half) : spots;

    const freeCount = (sec) =>
      (Data.sectors[sec] || []).filter((s) => Data.displayStatus(s.spot_key) === "free").length;

    v.innerHTML = `
      <div class="page-head">
        <div><h1>Harta e Parkimit</h1><p>${UI.esc(meta.name)} · ${UI.esc(meta.floor)}</p></div>
        <div class="legend">
          <span><i style="background:var(--success)"></i>I lirë</span>
          <span><i style="background:var(--danger)"></i>I zënë</span>
          <span><i style="background:var(--warning)"></i>Rezervuar</span>
          <span><i style="background:var(--offline)"></i>Pa sinjal</span>
        </div>
      </div>
      <div class="sector-tabs">
        ${Object.entries(SECTOR_META).map(([sec, m]) => `
          <button class="sector-tab ${sec === k ? "on" : ""}" data-sector="${sec}">
            <div><b>${m.name}</b><small>${m.label} · ${(Data.sectors[sec] || []).length} vende</small>
            <div class="live-tag ${m.online ? "online" : "demo"}">● ${m.badge.toUpperCase()}</div></div>
            <div class="n">${freeCount(sec)}</div>
          </button>`).join("")}
      </div>
      <div class="map-grid">
        <section class="card">
          <div class="card-bar">
            <h2>${UI.esc(meta.name)}<small>${UI.esc(meta.label)} · ${UI.esc(meta.floor)}</small></h2>
            ${k === "A" ? `<span class="badge unknown" id="arduinoChip">Arduino: …</span>`
                        : `<span class="badge free">${UI.esc(meta.badge)}</span>`}
          </div>
          <div class="lot" style="--cols:${Math.max(top.length, bottom.length || 1)}">
            ${top.length ? `<div class="lot-row top" style="grid-template-columns:repeat(${top.length},1fr)">${top.map((s) => this.slotHtml(s)).join("")}</div>` : ""}
            <div class="lot-lane"><div class="lane-entry">HYRJA →</div><span class="lane-arrow">➜</span><span class="lane-arrow">➜</span><span class="lane-arrow">➜</span></div>
            <div class="lot-row bottom" style="grid-template-columns:repeat(${bottom.length || 1},1fr)">${bottom.map((s) => this.slotHtml(s)).join("")}</div>
          </div>
        </section>
        <aside class="card card-pad">
          <h3>Zënia · ${UI.esc(meta.name)}</h3>
          ${this.sectorStatsHtml(k)}
        </aside>
      </div>`;

    v.querySelectorAll("[data-sector]").forEach((b) => (b.onclick = () => { this.activeSector = b.dataset.sector; this.map(v); }));
    v.querySelectorAll("[data-spot]").forEach((b) => (b.onclick = () => this.openSpot(b.dataset.spot)));

    // Sektori A: statusi i lidhjes me Arduino-n (nga matja e fundit e sensorëve)
    if (k === "A") {
      API.sensors().then((r) => {
        const chip = document.getElementById("arduinoChip");
        if (!chip) return;
        const newest = Math.max(0, ...r.data.map((s) => s.last_reading_at ? Date.parse(s.last_reading_at + "Z") : 0));
        const liveNow = newest && Date.now() - newest < 60_000 && r.data.some((s) => s.sensor_ok);
        chip.className = `badge ${liveNow ? "free" : "unknown"}`;
        chip.textContent = liveNow ? "Arduino: LIVE" : "Arduino: offline — pa sinjal";
      }).catch(() => { /* paneli mbetet siç është */ });
    }
  },

  slotHtml(s) {
    const key = s.spot_key;
    const st = Data.displayStatus(key);
    const cm = Data.state.spots[key]?.cm;
    const icon = { free: "P", occupied: "🚗", reserved: "R", unknown: "?" }[st];
    return `<div class="slot ${st}" data-spot="${key}" title="${key} — ${UI.STATUS_SQ[st]}">
      <span class="slot-id">${UI.esc(s.label)}</span>
      <span class="slot-icon">${icon}</span>
      <span class="slot-cm">${s.has_sensor && cm != null ? cm.toFixed(1) + " cm" : ""}</span>
    </div>`;
  },

  sectorStatsHtml(k) {
    const list = (Data.sectors[k] || []).map((s) => Data.displayStatus(s.spot_key));
    const c = (x) => list.filter((s) => s === x).length;
    const known = c("free") + c("occupied") + c("reserved");
    const pct = known ? Math.round(((c("occupied") + c("reserved")) / known) * 100) : 0;
    return `
      <div class="ring" style="--p:${pct}"><div><span><b>${pct}%</b><small>e zënë</small></span></div></div>
      <div class="list-rows">
        <div class="row-item"><span>Gjithsej</span><b>${list.length}</b></div>
        <div class="row-item"><span>Të lira</span><b style="color:var(--success)">${c("free")}</b></div>
        <div class="row-item"><span>Të zëna</span><b style="color:var(--danger)">${c("occupied")}</b></div>
        <div class="row-item"><span>Rezervuar</span><b style="color:var(--warning)">${c("reserved")}</b></div>
        <div class="row-item"><span>Pa sinjal</span><b style="color:var(--offline)">${c("unknown")}</b></div>
      </div>`;
  },

  async openSpot(key) {
    let d;
    try { d = await API.spot(key); } catch (e) { UI.toast(e.message, "error"); return; }
    const st = d.status === "free" && d.reservation ? "reserved" : d.status;
    const visitor = API.store.visitor;
    const mine = d.reservation && visitor && d.reservation.plate === visitor.plate;
    const qrUrl = `${UI.qrBase()}/#/spot/${encodeURIComponent(key)}`;

    UI.modal(`
      <h3>${UI.esc(SECTOR_META[d.sector]?.name || d.sector)} · ${UI.esc(d.label)}</h3>
      <p class="m-sub">${UI.esc(SECTOR_META[d.sector]?.floor || "")} · identifikuesi <span class="mono">${UI.esc(key)}</span></p>
      <div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
        <div class="qr-box" style="width:120px;height:120px">${UI.qrSvg(qrUrl, 3)}</div>
        <div style="flex:1;min-width:180px">
          <div class="list-rows">
            <div class="row-item"><span>Gjendja</span>${UI.badge(st)}</div>
            ${d.distance_cm != null ? `<div class="row-item"><span>Distanca</span><b>${d.distance_cm.toFixed(1)} cm</b></div>` : ""}
            <div class="row-item"><span>Sensor</span><span class="muted small">${d.has_sensor ? "Po (HC-SR04)" : "Jo"}</span></div>
            ${d.active_session ? `<div class="row-item"><span>Në parking</span><b>${UI.esc(d.active_session.name)}</b></div>
              <div class="row-item"><span>Qëndron prej</span><b>${UI.fmtDur(Date.now() - d.active_session.started_at)}</b></div>` : ""}
            ${d.reservation ? `<div class="row-item"><span>Rezervuar nga</span><b>${UI.esc(d.reservation.name)}</b></div>
              <div class="row-item"><span>Deri në orën</span><b>${UI.hm(d.reservation.until)}</b></div>` : ""}
          </div>
        </div>
      </div>
      <div class="mt" style="display:flex;gap:10px;flex-wrap:wrap">
        ${st === "free" && SECTOR_META[key.split("-")[0]]?.online ? `<a class="btn btn-primary" href="#/reserve?key=${encodeURIComponent(key)}" onclick="UI.closeModal()">Rezervo këtë vend</a>` : ""}
        ${key.startsWith("A-") ? `<p class="muted small mt">Prototip fizik (Arduino) — vetëm për demonstrime; rezervimet bëhen në sektorët B dhe C.</p>` : ""}
        ${mine ? `<button class="btn btn-danger" id="mCancelRes">Anulo rezervimin tim</button>` : ""}
        <button class="btn btn-ghost" onclick="UI.closeModal()">Mbyll</button>
      </div>`);

    const cancelBtn = UI.$("mCancelRes");
    if (cancelBtn) cancelBtn.onclick = async () => {
      try { await API.cancelReserve(key); UI.toast("Rezervimi u anulua", "ok"); UI.closeModal(); await Live.refreshAnd(); }
      catch (e) { UI.toast(e.message, "error"); }
    };
  },

  /* ===== Rezervimet ===== */
  async reserve(v) {
    try { await Promise.all([Data.refreshSpots(), Data.refreshState()]); } catch { /* vazhdon */ }
    const visitor = API.store.visitor;
    const preKey = Router.current?.q?.key || "";

    if (!visitor) {
      v.innerHTML = `
        <div class="page-head"><div><h1>Rezervimet</h1><p>Regjistrohu si vizitor për të rezervuar një vend parkimi.</p></div></div>
        <div class="grid-2">
          <div class="card card-pad">
            <h3>Regjistrimi i vizitorit</h3>
            <div id="regAlert"></div>
            <form id="regForm" novalidate>
              <div class="form-row">
                <div class="field"><label for="rFirst">Emri *</label><input id="rFirst" maxlength="20" autocomplete="given-name" required></div>
                <div class="field"><label for="rLast">Mbiemri *</label><input id="rLast" maxlength="20" autocomplete="family-name" required></div>
              </div>
              <div class="field"><label for="rPlate">Targa e veturës *</label>
                <input id="rPlate" maxlength="12" placeholder="p.sh. 01-234-AB" style="text-transform:uppercase">
                <div class="hint">Formati: blloqe me vija ndarëse, p.sh. 01-234-AB</div>
              </div>
              <button class="btn btn-primary btn-block" id="regBtn" type="submit">Regjistrohu</button>
              <p class="hint" style="margin-top:10px">Ruajmë vetëm emrin dhe targën — asgjë tjetër nuk kërkohet.</p>
            </form>
          </div>
          <div class="card card-pad">
            <h3>Si funksionon?</h3>
            <div class="list-rows">
              <div class="row-item"><span>1. Regjistrohu me emër dhe targë</span></div>
              <div class="row-item"><span>2. Zgjidh vendin e lirë dhe orën e daljes</span></div>
              <div class="row-item"><span>3. Vendi mbahet i rezervuar deri në ardhjen tënde</span></div>
              <div class="row-item"><span>4. Pas rezervimit merr QR-in — skanoje për check-in dhe "Gjej Veturën"</span></div>
            </div>
          </div>
        </div>`;
      UI.$("regForm").onsubmit = async (e) => {
        e.preventDefault();
        const first = UI.$("rFirst").value.trim(), last = UI.$("rLast").value.trim();
        const plate = UI.$("rPlate").value.trim().toUpperCase();
        const alertBox = UI.$("regAlert");
        if (!first || !last) { alertBox.innerHTML = `<div class="alert error">Emri dhe mbiemri janë të detyrueshëm.</div>`; return; }
        if (!UI.validPlate(plate)) { alertBox.innerHTML = `<div class="alert error">Targa s'është e vlefshme (p.sh. 01-234-AB).</div>`; return; }
        const btn = UI.$("regBtn");
        btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Duke u regjistruar…`;
        try {
          await API.visitorLogin(`${first} ${last}`, plate);
          UI.toast(`Mirë se erdhe, ${first}!`, "ok");
          Router.rerender();
        } catch (err) {
          alertBox.innerHTML = `<div class="alert error">${UI.esc(err.message)}</div>`;
          btn.disabled = false; btn.textContent = "Regjistrohu";
        }
      };
      return;
    }

    // Rezervohen vetëm sektorët ONLINE (B/C) — Sektori A është demo fizike.
    const freeSpots = Object.keys(SECTOR_META).filter((k) => SECTOR_META[k].online).flatMap((k) =>
      (Data.sectors[k] || []).filter((s) => Data.displayStatus(s.spot_key) === "free")
    );
    let myList = [];
    try { myList = (await API.myReservations()).data.filter((r) => ["reserved", "active"].includes(r.status)); }
    catch { /* lista mbetet bosh */ }
    const tokenOf = (key) => [...API.store.myReservations].reverse().find((x) => x.key === key)?.token;
    const today = new Date().toISOString().slice(0, 10);
    const defTime = UI.hm(Date.now() + 5 * 60_000);

    v.innerHTML = `
      <div class="page-head">
        <div><h1>Rezervo Parking</h1><p>I kyçur si <b>${UI.esc(visitor.name)}</b> · <span class="mono">${UI.esc(visitor.plate)}</span></p></div>
        <button class="btn btn-sm btn-ghost" id="visitorOut">Dil</button>
      </div>
      <div class="grid-2">
        <div class="card card-pad">
          <h3>Hapi 1 — Zgjidh vendin dhe kohën</h3>
          <div id="resAlert"></div>
          <form id="resForm">
            <div class="field"><label for="resSpot">Vendi i parkimit (vetëm të lirët)</label>
              <select id="resSpot">${freeSpots.length
                ? freeSpots.map((s) => `<option value="${s.spot_key}" ${s.spot_key === preKey ? "selected" : ""}>${s.spot_key} — ${SECTOR_META[s.sector]?.name} (${SECTOR_META[s.sector]?.floor})</option>`).join("")
                : `<option value="">S'ka vende të lira</option>`}</select>
            </div>
            <div class="form-row">
              <div class="field"><label for="resDate">Data</label>
                <input type="date" id="resDate" value="${today}" min="${today}"></div>
              <div class="field"><label for="resStart">Ora e hyrjes</label>
                <input type="time" id="resStart" value="${defTime}"></div>
            </div>
            <div class="field checkbox-row">
              <input type="checkbox" id="resOpen">
              <label for="resOpen" style="margin:0">Nuk e di ende kur do të dal</label>
            </div>
            <div class="field" id="endField"><label for="resEnd">Ora e planifikuar e daljes</label>
              <input type="time" id="resEnd" value="${UI.hm(Date.now() + 2 * 3600_000)}"></div>
            <button class="btn btn-primary btn-block" id="resBtn" type="submit" ${freeSpots.length ? "" : "disabled"}>Hapi 2 — Konfirmo &amp; merr QR-in</button>
            <p class="hint" style="margin-top:8px">Pa orar daljeje: qëndron sa të duash — vendi mbahet deri në daljen reale (check-out).</p>
          </form>
        </div>
        <div class="card card-pad">
          <h3>Rezervimet e mia</h3>
          <div class="list-rows">
            ${myList.length ? myList.map((r) => {
              const tk = tokenOf(r.key);
              return `<div class="row-item"><span><b>${UI.esc(r.key)}</b> · ${UI.fmtDt(r.starts_at)}${r.until ? " – " + UI.hm(r.until) : " · pa orar daljeje"}</span>
                <span>${UI.badge(r.status === "active" ? "occupied" : "reserved")}
                ${tk ? `<a class="btn btn-sm" href="#/r/${encodeURIComponent(tk)}">QR →</a>` : ""}</span></div>`;
            }).join("") : `<p class="muted small" style="padding:10px 0">Ende pa rezervime aktive.</p>`}
          </div>
          <div class="table-wrap mt"><table class="tbl">
            <thead><tr><th>Vendi</th><th>Sektori</th><th>Kati</th><th></th></tr></thead>
            <tbody>${freeSpots.slice(0, 8).map((s) => `
              <tr><td class="mono">${s.spot_key}</td><td>${SECTOR_META[s.sector]?.name}</td><td>${SECTOR_META[s.sector]?.floor}</td>
              <td><button class="btn btn-sm" data-pick="${s.spot_key}">Zgjidh</button></td></tr>`).join("") ||
              `<tr><td colspan="4" class="tbl-empty">S'ka vende të lira për momentin.</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>`;

    UI.$("visitorOut").onclick = () => { API.visitorLogout(); UI.toast("U çkyçe si vizitor"); Router.rerender(); };
    v.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { const sel = UI.$("resSpot"); if (sel) { sel.value = b.dataset.pick; sel.focus(); } }));
    UI.$("resOpen").onchange = () => { UI.$("endField").style.display = UI.$("resOpen").checked ? "none" : ""; };

    UI.$("resForm").onsubmit = async (e) => {
      e.preventDefault();
      const key = UI.$("resSpot").value;
      if (!key) return;
      const openEnded = UI.$("resOpen").checked;
      const [sy, sm, sd] = (UI.$("resDate").value || today).split("-").map(Number);
      const [sh, smin] = (UI.$("resStart").value || defTime).split(":").map(Number);
      const start = new Date(sy, sm - 1, sd, sh, smin, 0, 0).getTime();
      let end = null;
      if (!openEnded) {
        const [eh, emin] = (UI.$("resEnd").value || "00:00").split(":").map(Number);
        end = new Date(sy, sm - 1, sd, eh, emin, 0, 0).getTime();
        if (end <= start) end += 24 * 3600_000; // dalja pas mesnate → dita tjetër
      }
      const btn = UI.$("resBtn");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Duke rezervuar…`;
      try {
        const r = await API.reserve(key, openEnded
          ? { start: Math.max(start, Date.now()), open_ended: true }
          : { start: Math.max(start, Date.now()), end });
        UI.toast(`Vendi ${key} u rezervua — ja QR-ja jote`, "ok");
        location.hash = `#/r/${encodeURIComponent(r.token)}`; // Hapi 3: QR-ja
      } catch (err) {
        UI.$("resAlert").innerHTML = `<div class="alert error">${UI.esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Hapi 2 — Konfirmo & merr QR-in";
      }
    };
  },

  /* ===== Faqja e rezervimit (hapet nga skanimi i QR-së) ===== */
  async reservation(v, token) {
    if (!token) { location.hash = "#/reserve"; return; }
    let r;
    try { r = await API.reservation(token); }
    catch (e) {
      v.innerHTML = `
        <div class="card card-pad" style="max-width:560px;margin:40px auto;text-align:center">
          <h2>QR i pavlefshëm</h2>
          <p class="muted">${UI.esc(e.status === 404 ? "Ky kod QR nuk njihet — rezervimi mund të jetë fshirë ose kodi është i gabuar." : e.message)}</p>
          <a class="btn btn-primary mt" href="#/reserve">Bëj një rezervim të ri</a>
        </div>`;
      return;
    }
    const meta = SECTOR_META[r.sector] || {};
    const qrUrl = `${UI.qrBase()}/#/r/${encodeURIComponent(token)}`;
    const ST = {
      reserved: ["reserved", "Rezervuar — në pritje të ardhjes"],
      active: ["occupied", "Aktiv — vetura është në parking"],
      completed: ["free", "Përfunduar — faleminderit!"],
      cancelled: ["unknown", "Anuluar"],
      expired: ["unknown", "Skaduar — rezervimi nuk u përdor në kohë"],
    }[r.status] || ["unknown", r.status];
    const mine = API.store.visitor && API.store.myReservations.some((x) => x.token === token);

    v.innerHTML = `
      <div class="page-head"><div><h1>Rezervimi im</h1><p>AutoParking · ${UI.esc(meta.name || r.sector)} · ${UI.esc(meta.floor || "")}</p></div></div>
      <div class="grid-2">
        <div class="card card-pad" style="text-align:center">
          <div class="qr-box" style="width:200px;height:200px">${UI.qrSvg(qrUrl, 4)}</div>
          <p class="muted small mt">Skanoje me kamerën e telefonit — hap direkt këtë faqe.</p>
          <div class="alert ${r.status === "active" ? "ok" : r.status === "reserved" ? "info" : "error"}" style="margin-top:10px">${ST[1]}</div>
        </div>
        <div class="card card-pad">
          <h3>Detajet</h3>
          <div class="list-rows">
            <div class="row-item"><span>Vendi</span><b class="mono" style="font-size:1.2em">${UI.esc(r.key)}</b></div>
            <div class="row-item"><span>Sektori / Kati</span><b>${UI.esc(meta.name || r.sector)} · ${UI.esc(meta.floor || "—")}</b></div>
            <div class="row-item"><span>Statusi</span>${UI.badge(ST[0])}</div>
            <div class="row-item"><span>Hyrja e planifikuar</span><b>${UI.fmtDt(r.starts_at)}</b></div>
            <div class="row-item"><span>Dalja e planifikuar</span><b>${r.until ? UI.fmtDt(r.until) : "Pa orar — qëndro sa të duash"}</b></div>
            ${r.checked_in_at ? `<div class="row-item"><span>Hyrja reale</span><b>${UI.fmtDt(r.checked_in_at)}</b></div>` : ""}
            ${r.checked_out_at ? `<div class="row-item"><span>Dalja reale</span><b>${UI.fmtDt(r.checked_out_at)}</b></div>` : ""}
            ${r.duration_s != null ? `<div class="row-item"><span>${r.status === "active" ? "Në parking prej" : "Qëndrimi zgjati"}</span><b>${UI.fmtDur(r.duration_s * 1000)}</b></div>` : ""}
            <div class="row-item"><span>Rezervuar nga</span><b>${UI.esc(r.name)} · <span class="mono">${UI.esc(r.plate_masked)}</span></b></div>
          </div>
          <div class="mt" style="display:flex;gap:10px;flex-wrap:wrap">
            ${r.status === "reserved" ? `<button class="btn btn-primary" id="btnCheckin">✓ Check-in — Parkova</button>` : ""}
            ${r.status === "active" ? `<button class="btn btn-danger" id="btnCheckout">Check-out — Po dal</button>` : ""}
            ${["reserved", "active"].includes(r.status) ? `<a class="btn" href="#/find?key=${encodeURIComponent(r.key)}">🚗 Gjej veturën</a>` : ""}
            ${mine && r.status === "reserved" ? `<button class="btn btn-ghost" id="btnCancelR">Anulo</button>` : ""}
            ${["completed", "cancelled", "expired"].includes(r.status) ? `<a class="btn btn-primary" href="#/reserve">Rezervim i ri</a>` : ""}
          </div>
          ${r.status === "reserved" ? `<p class="hint mt">Check-in hapet 15 minuta para orës së rezervimit. Skanimi i QR-së vetëm e hap faqen — asgjë nuk ndryshon pa e shtypur ti butonin.</p>` : ""}
        </div>
      </div>`;

    const act = async (fn, okMsg) => {
      try { await fn(); UI.toast(okMsg, "ok"); Views.reservation(v, token); }
      catch (e) { UI.toast(e.message, "error"); }
    };
    const ci = UI.$("btnCheckin");
    if (ci) ci.onclick = () => act(() => API.reservationCheckin(token), "Mirë se erdhe! Check-in u krye");
    const co = UI.$("btnCheckout");
    if (co) co.onclick = () => act(() => API.reservationCheckout(token), "Check-out u krye — rrugë të mbarë!");
    const cx = UI.$("btnCancelR");
    if (cx) cx.onclick = () => act(() => API.cancelReserve(r.key), "Rezervimi u anulua");
  },

  /* ===== Gjej Veturën ===== */
  async find(v, q = {}) {
    const plate = (q.plate || API.store.visitor?.plate || "").toUpperCase();

    // Rezervimet e mia aktive/në pritje — gjetja me NJË klikim, pa kërkim
    let myActive = [];
    if (API.store.visitor) {
      try {
        myActive = (await API.myReservations()).data.filter((r) => ["active", "reserved"].includes(r.status));
      } catch { /* kalon te kërkimi me targë */ }
    }
    if (q.key) myActive = myActive.filter((r) => r.key === q.key);
    const tokenOf = (key) => [...API.store.myReservations].reverse().find((x) => x.token && x.key === key)?.token;

    const carCard = (r) => {
      const meta = SECTOR_META[r.sector] || {};
      const tk = tokenOf(r.key);
      return `
        <div class="alert ok">🚗 Vetura jote ${r.status === "active" ? "është e parkuar" : "ka vend të rezervuar"} te <b>${UI.esc(r.key)}</b></div>
        <div class="list-rows">
          <div class="row-item"><span>Sektori</span><b>${UI.esc(meta.name || r.sector)}</b></div>
          <div class="row-item"><span>Kati</span><b>${UI.esc(meta.floor || "—")}</b></div>
          <div class="row-item"><span>Vendparkimi</span><b class="mono" style="font-size:1.15em">${UI.esc(r.label)}</b></div>
          <div class="row-item"><span>Statusi</span>${UI.badge(r.status === "active" ? "occupied" : "reserved")}</div>
          ${r.checked_in_at ? `<div class="row-item"><span>Në parking prej</span><b>${UI.fmtDur(Date.now() - r.checked_in_at)}</b></div>` : ""}
        </div>
        <div class="mt" style="display:flex;gap:10px;flex-wrap:wrap">
          <a class="btn btn-primary" href="#/spot/${encodeURIComponent(r.key)}">🗺 Shihe në hartën e parkingut</a>
          ${tk ? `<a class="btn btn-ghost" href="#/r/${encodeURIComponent(tk)}">Rezervimi &amp; QR →</a>` : ""}
        </div>`;
    };

    if (myActive.length === 1) {
      v.innerHTML = `
        <div class="page-head"><div><h1>Gjej Veturën</h1><p>Vendndodhja nga rezervimi yt — pa GPS, direkt nga planimetria.</p></div></div>
        <div class="card card-pad" style="max-width:620px">${carCard(myActive[0])}</div>`;
      return;
    }
    if (myActive.length > 1) {
      v.innerHTML = `
        <div class="page-head"><div><h1>Gjej Veturën</h1><p>Ke disa rezervime — zgjidh të duhurin.</p></div></div>
        <div class="grid-2">${myActive.map((r) => `<div class="card card-pad">${carCard(r)}</div>`).join("")}</div>`;
      return;
    }

    v.innerHTML = `
      <div class="page-head"><div><h1>Gjej Veturën Time</h1><p>Shkruaj targën ose skano QR-in tënd personal.</p></div></div>
      <div class="grid-2">
        <div class="card card-pad">
          <h3>Kërko me targë</h3>
          <form id="findForm">
            <div class="field"><label for="findPlate">Targa e veturës</label>
              <input id="findPlate" maxlength="12" placeholder="p.sh. 01-234-AB" value="${UI.esc(plate)}" style="text-transform:uppercase"></div>
            <button class="btn btn-primary btn-block" type="submit">Gjej veturën</button>
          </form>
          <div id="findResult" class="mt"></div>
        </div>
        <div class="card card-pad">
          <h3>Si ruhet vendndodhja?</h3>
          <div class="list-rows">
            <div class="row-item"><span>Kur parkon, skano QR-in e vendit (te çdo vend parkimi)</span></div>
            <div class="row-item"><span>Sistemi e lidh targën tënde me atë vend</span></div>
            <div class="row-item"><span>Këtu e gjen në çdo moment vendndodhjen e fundit</span></div>
          </div>
          <a class="btn mt" href="#/qr">Shko te QR Parking →</a>
        </div>
      </div>`;

    const doFind = async () => {
      const p = UI.$("findPlate").value.trim().toUpperCase();
      const out = UI.$("findResult");
      if (!UI.validPlate(p)) { out.innerHTML = `<div class="alert error">Shkruaj një targë të vlefshme.</div>`; return; }
      out.innerHTML = `<p class="muted small"><span class="spinner"></span> Duke kërkuar…</p>`;
      try {
        const r = await API.qrFind(p);
        const meta = SECTOR_META[r.sector] || {};
        out.innerHTML = `
          <div class="alert ok">Vetura u gjet! 🚗</div>
          <div class="list-rows">
            <div class="row-item"><span>Targa</span><b class="mono">${UI.esc(p)}</b></div>
            <div class="row-item"><span>Vendi</span><b>${UI.esc(r.spot_key)}</b></div>
            <div class="row-item"><span>Sektori</span><b>${UI.esc(meta.name || r.sector)}</b></div>
            <div class="row-item"><span>Kati</span><b>${UI.esc(meta.floor || "—")}</b></div>
            <div class="row-item"><span>Skanuar më</span><b>${UI.fmtDt(r.scanned_at)}</b></div>
            <div class="row-item"><span>Gjendja tani</span>${UI.badge(r.status)}</div>
          </div>
          <div class="alert info mt">🧭 Udhëzim: shko te ${UI.esc(meta.floor || "kati përkatës")}, ndiq shenjat për ${UI.esc(meta.name || "sektorin")} dhe kërko vendin <b>${UI.esc(r.label)}</b>.</div>
          <a class="btn btn-block mt" href="#/spot/${encodeURIComponent(r.spot_key)}">Shihe në hartë</a>`;
      } catch (e) {
        out.innerHTML = `<div class="alert error">${UI.esc(e.message)}</div>`;
      }
    };
    UI.$("findForm").onsubmit = (e) => { e.preventDefault(); doFind(); };
    if (q.plate) doFind();
  },

  /* ===== QR Parking ===== */
  async visitorQr(v) {
    const visitor = API.store.visitor;
    if (!visitor) {
      v.innerHTML = `
        <div class="page-head"><div><h1>QR Parking</h1><p>QR-të e rezervimeve të tua dhe QR-i personal për gjetjen e veturës.</p></div></div>
        <div class="card card-pad" style="max-width:520px">
          <div class="alert info">Regjistrohu fillimisht si vizitor te <b>Rezervo Parking</b> — çdo rezervim merr QR-in e vet.</div>
          <a class="btn btn-primary" href="#/reserve">Regjistrohu &amp; rezervo →</a>
        </div>`;
      return;
    }
    try { await Data.refreshState(); } catch { /* vazhdon */ }

    // QR-të e rezervimeve të mia (nga kjo pajisje) — hapen me një skanim
    const myQrs = [...API.store.myReservations].reverse().slice(0, 4);
    let myQrsHtml = "";
    if (myQrs.length) {
      const rows = [];
      for (const m of myQrs) {
        try {
          const r = await API.reservation(m.token);
          if (!["reserved", "active"].includes(r.status)) continue;
          rows.push(`
            <div class="card card-pad" style="text-align:center">
              <div class="qr-box" style="width:140px;height:140px">${UI.qrSvg(`${UI.qrBase()}/#/r/${encodeURIComponent(m.token)}`, 3)}</div>
              <p style="margin:8px 0 2px"><b>${UI.esc(r.key)}</b> ${UI.badge(r.status === "active" ? "occupied" : "reserved")}</p>
              <a class="btn btn-sm" href="#/r/${encodeURIComponent(m.token)}">Hap rezervimin →</a>
            </div>`);
        } catch { /* token i vjetër — kalohet */ }
      }
      if (rows.length) {
        myQrsHtml = `
          <div class="page-head" style="margin-top:0"><div><h3>QR-të e rezervimeve të mia</h3></div></div>
          <div class="grid-3">${rows.join("")}</div><hr style="border:none;border-top:1px solid var(--border);margin:22px 0">`;
      }
    }
    const myRes = Data.state.res.find((r) => r.plate === visitor.plate);
    const mySession = Data.state.sessions.find((s) => s.plate === visitor.plate && !s.end);
    let lastScan = null;
    try { lastScan = await API.qrFind(visitor.plate); } catch { /* s'ka skanim ende */ }
    const spotKey = mySession?.key || myRes?.key || lastScan?.spot_key || null;
    const sector = spotKey ? spotKey.split("-")[0] : null;
    const [first, ...rest] = visitor.name.split(" ");
    // QR-i përmban vetëm një URL me targën — pa të dhëna të tjera personale.
    const myUrl = `${UI.qrBase()}/#/find?plate=${encodeURIComponent(visitor.plate)}`;

    v.innerHTML = `
      <div class="page-head">
        <div><h1>QR Parking</h1><p>QR-të e rezervimeve dhe QR-i yt personal për gjetjen e veturës.</p></div>
      </div>
      ${myQrsHtml}
      <div class="grid-2">
        <div class="card card-pad" style="text-align:center">
          <div class="qr-box" style="width:210px;height:210px">${UI.qrSvg(myUrl, 4)}</div>
          <p class="muted small mt">${UI.esc(myUrl)}</p>
        </div>
        <div class="card card-pad">
          <h3>Informacioni i parkimit</h3>
          <div class="list-rows">
            <div class="row-item"><span>Emri</span><b>${UI.esc(first)}</b></div>
            <div class="row-item"><span>Mbiemri</span><b>${UI.esc(rest.join(" ") || "—")}</b></div>
            <div class="row-item"><span>Targa</span><b class="mono">${UI.esc(visitor.plate)}</b></div>
            <div class="row-item"><span>Vendi</span><b>${spotKey ? UI.esc(spotKey) : "—"}</b></div>
            <div class="row-item"><span>Sektori</span><b>${sector ? UI.esc(SECTOR_META[sector]?.name || sector) : "—"}</b></div>
            <div class="row-item"><span>Kati</span><b>${sector ? UI.esc(SECTOR_META[sector]?.floor || "—") : "—"}</b></div>
            <div class="row-item"><span>Statusi i rezervimit</span>${myRes ? UI.badge("reserved") : mySession ? UI.badge("occupied") : `<span class="muted small">pa rezervim aktiv</span>`}</div>
            ${myRes ? `<div class="row-item"><span>Dalja e planifikuar</span><b>${UI.hm(myRes.end)}</b></div>` : ""}
            ${mySession ? `<div class="row-item"><span>Në parking prej</span><b>${UI.fmtDur(Date.now() - mySession.start)}</b></div>` : ""}
          </div>
          <div class="mt">
            <h3>Parkova — regjistro vendin</h3>
            <p class="muted small" style="margin-bottom:10px">Skano QR-in e vendit, ose shkruaje kodin e tij (p.sh. A-P1):</p>
            <form id="scanForm" style="display:flex;gap:10px">
              <input id="scanCode" placeholder="A-P1" maxlength="12" aria-label="Kodi i vendit të parkimit" style="flex:1;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--card2);color:var(--text);text-transform:uppercase">
              <button class="btn btn-primary" type="submit">Regjistro</button>
            </form>
            <div id="scanAlert" class="mt"></div>
          </div>
        </div>
      </div>`;

    UI.$("scanForm").onsubmit = async (e) => {
      e.preventDefault();
      const code = UI.$("scanCode").value.trim().toUpperCase();
      const out = UI.$("scanAlert");
      if (!code) return;
      try {
        const r = await API.qrScan(code, visitor.plate);
        out.innerHTML = `<div class="alert ok">Vendndodhja u ruajt: <b>${UI.esc(r.key)}</b>. Tani mund ta gjesh veturën me QR-in tënd.</div>`;
      } catch (err) {
        out.innerHTML = `<div class="alert error">${UI.esc(err.message)}</div>`;
      }
    };
  },
};

/* ---------- Nisja ---------- */
function updateAdminButton() {
  const admin = API.store.admin;
  UI.$("btnAdminText").textContent = admin ? `Paneli (${admin.username})` : "Hyrja Admin";
}
UI.$("btnAdmin").onclick = () => {
  if (API.store.admin) location.hash = "#/admin";
  else Admin.openLogin();
};
UI.$("hamburger").onclick = () => {
  const open = UI.$("navLinks").classList.toggle("open");
  UI.$("hamburger").setAttribute("aria-expanded", String(open));
};
// Në telefon: menyja mbyllet sapo zgjidhet një lidhje
UI.$("navLinks").addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    UI.$("navLinks").classList.remove("open");
    UI.$("hamburger").setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("admin:expired", () => {
  updateAdminButton();
  UI.toast("Sesioni i adminit skadoi — kyçu përsëri", "error");
  if (Router.current?.route === "admin") location.hash = "#/";
});
document.addEventListener("admin:changed", updateAdminButton);

// Treguesi global i modalitetit DEMO — i dukshëm në çdo faqe.
SerialBridge.onModeChange = () => { UI.$("demoChip").hidden = !SerialBridge.isDemo(); };

Theme.init();
updateAdminButton();
Live.connect();

// Merr URL-në publike nga serveri (PUBLIC_BASE_URL) për kodet QR.
API.config()
  .then((c) => { UI.serverPublicUrl = (c?.public_base_url || "").replace(/\/+$/, ""); })
  .catch(() => { /* zhvillim lokal pa konfigurim — përdoret location.origin */ });
Router.go();