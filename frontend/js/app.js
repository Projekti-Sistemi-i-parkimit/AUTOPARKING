"use strict";

/* ============================================================
   Aplikacioni kryesor: tema, routing, SSE, pamjet publike.
   Pamjet: Ballina, Harta, Rezervimet, Gjej Veturën, QR i Vizitorit.
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
    await this.render();
    if (r.spotKey) Views.openSpot(r.spotKey);
  },

  async render() {
    const v = UI.$("view");
    const r = this.current || { route: "home" };
    try {
      switch (r.route) {
        case "home": case "": await Views.home(v); break;
        case "map": await Views.map(v); break;
        case "reserve": await Views.reserve(v); break;
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
        <h1>Parkim <em>inteligjent</em>, pa kërkime të kota.</h1>
        <p>Monitorim i vendeve në kohë reale me sensorë ultrasonikë, rezervime të thjeshta dhe gjetje e veturës me QR.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="#/map">Shiko hartën</a>
          <a class="btn" href="#/reserve">Rezervo një vend</a>
          <a class="btn btn-ghost" href="#/find">Gjej veturën time</a>
        </div>
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
              <div class="row-item"><span>4. Kur parkon, merr QR-in personal te "QR i Vizitorit"</span></div>
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

    const myRes = Data.state.res.find((r) => r.plate === visitor.plate);
    // Rezervohen vetëm sektorët ONLINE (B/C) — Sektori A është demo fizike.
    const freeSpots = Object.keys(SECTOR_META).filter((k) => SECTOR_META[k].online).flatMap((k) =>
      (Data.sectors[k] || []).filter((s) => Data.displayStatus(s.spot_key) === "free")
    );
    const defTime = UI.hm(Date.now() + 3600_000);

    v.innerHTML = `
      <div class="page-head">
        <div><h1>Rezervimet</h1><p>I kyçur si <b>${UI.esc(visitor.name)}</b> · <span class="mono">${UI.esc(visitor.plate)}</span></p></div>
        <button class="btn btn-sm btn-ghost" id="visitorOut">Dil</button>
      </div>
      <div class="grid-2">
        <div class="card card-pad">
          <h3>${myRes ? "Rezervimi im aktiv" : "Rezervo një vend"}</h3>
          <div id="resAlert"></div>
          ${myRes ? `
            <div class="list-rows">
              <div class="row-item"><span>Vendi</span><b>${UI.esc(myRes.key)}</b></div>
              <div class="row-item"><span>Sektori</span><b>${UI.esc(SECTOR_META[myRes.key.split("-")[0]]?.name || "")}</b></div>
              <div class="row-item"><span>Statusi</span>${UI.badge("reserved")}</div>
              <div class="row-item"><span>Deri në orën</span><b>${UI.hm(myRes.end)}</b></div>
            </div>
            <div class="mt" style="display:flex;gap:10px">
              <button class="btn btn-danger" id="btnCancelRes">Anulo rezervimin</button>
              <a class="btn btn-ghost" href="#/qr">QR i vizitorit →</a>
            </div>`
          : `
            <form id="resForm">
              <div class="field"><label for="resSpot">Vendi i parkimit</label>
                <select id="resSpot">${freeSpots.length
                  ? freeSpots.map((s) => `<option value="${s.spot_key}" ${s.spot_key === preKey ? "selected" : ""}>${s.spot_key} — ${SECTOR_META[s.sector]?.name} (${SECTOR_META[s.sector]?.floor})</option>`).join("")
                  : `<option value="">S'ka vende të lira</option>`}</select>
              </div>
              <div class="field"><label for="resTime">Do dal në orën (parkingu hapur 24/7)</label>
                <input type="time" id="resTime" value="${defTime}"></div>
              <button class="btn btn-primary btn-block" id="resBtn" type="submit" ${freeSpots.length ? "" : "disabled"}>Konfirmo rezervimin</button>
            </form>`}
        </div>
        <div class="card">
          <div class="card-bar"><h2>Vendet e lira tani<small>${freeSpots.length} të disponueshme</small></h2></div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Vendi</th><th>Sektori</th><th>Kati</th><th>Statusi</th><th></th></tr></thead>
            <tbody>${freeSpots.slice(0, 12).map((s) => `
              <tr><td class="mono">${s.spot_key}</td><td>${SECTOR_META[s.sector]?.name}</td><td>${SECTOR_META[s.sector]?.floor}</td>
              <td>${UI.badge("free")}</td>
              <td><button class="btn btn-sm" data-pick="${s.spot_key}">Zgjidh</button></td></tr>`).join("") ||
              `<tr><td colspan="5" class="tbl-empty">S'ka vende të lira për momentin.</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>`;

    UI.$("visitorOut").onclick = () => { API.visitorLogout(); UI.toast("U çkyçe si vizitor"); Router.rerender(); };
    v.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { const sel = UI.$("resSpot"); if (sel) { sel.value = b.dataset.pick; sel.focus(); } }));

    const form = UI.$("resForm");
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const key = UI.$("resSpot").value;
      const tVal = UI.$("resTime").value || defTime;
      if (!key) return;
      const [h, m] = tVal.split(":").map(Number);
      const end = new Date(); end.setHours(h, m, 0, 0);
      if (end.getTime() <= Date.now()) end.setDate(end.getDate() + 1);
      const btn = UI.$("resBtn");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Duke rezervuar…`;
      try {
        await API.reserve(key, end.getTime());
        UI.toast(`Vendi ${key} u rezervua deri në ${tVal}`, "ok");
        await Live.refreshAnd();
      } catch (err) {
        UI.$("resAlert").innerHTML = `<div class="alert error">${UI.esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Konfirmo rezervimin";
      }
    };
    const cancel = UI.$("btnCancelRes");
    if (cancel) cancel.onclick = async () => {
      try { await API.cancelReserve(myRes.key); UI.toast("Rezervimi u anulua", "ok"); await Live.refreshAnd(); }
      catch (e) { UI.toast(e.message, "error"); }
    };
  },

  /* ===== Gjej Veturën ===== */
  async find(v, q = {}) {
    const plate = (q.plate || API.store.visitor?.plate || "").toUpperCase();
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
          <a class="btn mt" href="#/qr">Shko te QR i Vizitorit →</a>
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

  /* ===== QR i Vizitorit ===== */
  async visitorQr(v) {
    const visitor = API.store.visitor;
    if (!visitor) {
      v.innerHTML = `
        <div class="page-head"><div><h1>QR i Vizitorit</h1><p>QR-i yt personal për gjetjen e veturës dhe informacionin e parkimit.</p></div></div>
        <div class="card card-pad" style="max-width:520px">
          <div class="alert info">Regjistrohu fillimisht si vizitor te <b>Rezervimet</b> për të marrë QR-in tënd personal.</div>
          <a class="btn btn-primary" href="#/reserve">Regjistrohu si vizitor →</a>
        </div>`;
      return;
    }
    try { await Data.refreshState(); } catch { /* vazhdon */ }
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
        <div><h1>QR i Vizitorit</h1><p>Skanoje me telefon për të hapur faqen tënde të parkimit.</p></div>
      </div>
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