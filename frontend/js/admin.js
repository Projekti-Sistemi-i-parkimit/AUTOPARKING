"use strict";

/* ============================================================
   Paneli administrativ.
   - Hyrja përmes POST /api/admin/login (autentikimi real i backend-it).
   - Token-i Bearer ruhet nga API.store; RBAC-ja zbatohet nga serveri —
     UI vetëm fsheh seksionet që roli s'i përdor dot (jo si siguri).
   - Asnjë kredencial, çelës apo sekret s'është i koduar këtu.
   ============================================================ */

const Admin = (window.Admin = {
  section: "overview",

  /* ---------- Hyrja ---------- */
  openLogin() {
    const remembered = API.store.rememberedUser;
    UI.modal(`
      <h3>Hyrja e Administratorit</h3>
      <p class="m-sub">Qasje vetëm për stafin e autorizuar. Të gjitha veprimet regjistrohen.</p>
      <div id="loginAlert"></div>
      <form id="loginForm">
        <div class="field">
          <label for="lgUser">Emri i përdoruesit</label>
          <input id="lgUser" autocomplete="username" value="${UI.esc(remembered)}" required>
        </div>
        <div class="field">
          <label for="lgPass">Fjalëkalimi</label>
          <div class="pw-wrap">
            <input id="lgPass" type="password" autocomplete="current-password" required>
            <button type="button" class="pw-toggle" id="pwToggle" aria-label="Shfaq fjalëkalimin">👁</button>
          </div>
        </div>
        <div class="field checkbox-row">
          <input type="checkbox" id="lgRemember" ${remembered ? "checked" : ""}>
          <label for="lgRemember" style="margin:0">Mbaj mend emrin e përdoruesit</label>
        </div>
        <button class="btn btn-primary btn-block" id="lgBtn" type="submit">Kyçu</button>
      </form>`);

    UI.$("pwToggle").onclick = () => {
      const p = UI.$("lgPass");
      p.type = p.type === "password" ? "text" : "password";
    };
    UI.$(remembered ? "lgPass" : "lgUser").focus();

    UI.$("loginForm").onsubmit = async (e) => {
      e.preventDefault();
      const username = UI.$("lgUser").value.trim();
      const password = UI.$("lgPass").value;
      if (!username || !password) return;
      const btn = UI.$("lgBtn");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Duke u kyçur…`;
      try {
        await API.adminLogin(username, password);
        API.store.rememberedUser = UI.$("lgRemember").checked ? username : "";
        document.dispatchEvent(new CustomEvent("admin:changed"));
        UI.closeModal();
        UI.toast(`Mirë se erdhe, ${username}!`, "ok");
        location.hash = "#/admin";
      } catch (err) {
        // Mesazh i njëjtë pavarësisht se cila fushë ishte gabim.
        UI.$("loginAlert").innerHTML = `<div class="alert error">${
          err.status === 401 ? "Kredencialet janë të pasakta." : UI.esc(err.message)
        }</div>`;
        btn.disabled = false; btn.textContent = "Kyçu";
      }
    };
  },

  async logout() {
    await API.adminLogout();
    document.dispatchEvent(new CustomEvent("admin:changed"));
    UI.toast("U çkyçe me sukses");
    location.hash = "#/";
  },

  /* ---------- Korniza e panelit ---------- */
  NAV: [
    { id: "overview", icon: "▦", label: "Përmbledhja" },
    { id: "spots", icon: "🅿", label: "Vendet e Parkimit" },
    { id: "visitors", icon: "👥", label: "Vizitorët" },
    { id: "reservations", icon: "🕒", label: "Rezervimet" },
    { id: "qr", icon: "▣", label: "Menaxhimi i QR" },
    { id: "sensors", icon: "📡", label: "Sensorët" },
    { id: "arduino", icon: "🔌", label: "Lidhja Arduino" },
    { id: "gate", icon: "🚧", label: "Kontrolli i Barrierës" },
    { sep: true, adminOnly: true },
    { id: "users", icon: "👤", label: "Përdoruesit", adminOnly: true },
    { id: "keys", icon: "🔑", label: "Çelësat API", adminOnly: true },
    { id: "audit", icon: "🗒", label: "Audit Log", adminOnly: true },
    { sep: true },
    { id: "settings", icon: "⚙", label: "Cilësimet" },
  ],

  async render(v, sub) {
    if (!API.store.admin) {
      v.innerHTML = `
        <div class="card card-pad" style="max-width:480px;margin:40px auto;text-align:center">
          <h3>Kërkohet autentikim</h3>
          <p class="muted small" style="margin:10px 0 18px">Ky seksion është vetëm për administratorët e sistemit.</p>
          <button class="btn btn-primary" onclick="Admin.openLogin()">Hyrja Admin</button>
        </div>`;
      return;
    }
    // Verifiko që sesioni është ende i vlefshëm (skadimi trajtohet nga API).
    try { await API.adminMe(); } catch { return; }

    this.section = sub || this.section || "overview";
    const me = API.store.admin;
    const isAdmin = me.role === "admin";

    v.innerHTML = `
      <div class="admin-layout">
        <aside class="card admin-side">
          <div class="side-user">
            <div class="avatar">${UI.esc(me.username[0].toUpperCase())}</div>
            <div><b>${UI.esc(me.username)}</b><small>${UI.esc(me.role)}</small></div>
          </div>
          <nav class="side-nav" id="adminNav">
            ${this.NAV.filter((n) => !n.adminOnly || isAdmin).map((n) =>
              n.sep ? `<div class="side-sep"></div>` :
              `<button data-sec="${n.id}" class="${n.id === this.section ? "on" : ""}"><span class="icon">${n.icon}</span>${n.label}</button>`
            ).join("")}
            <div class="side-sep"></div>
            <button id="adminLogout"><span class="icon">⎋</span>Çkyçu</button>
          </nav>
        </aside>
        <div id="adminContent"></div>
      </div>`;

    v.querySelectorAll("[data-sec]").forEach((b) => (b.onclick = () => { location.hash = `#/admin/${b.dataset.sec}`; }));
    UI.$("adminLogout").onclick = () => this.logout();

    const c = UI.$("adminContent");
    try {
      await (this.sections[this.section] || this.sections.overview).call(this, c);
    } catch (e) {
      c.innerHTML = `<div class="alert error">${UI.esc(e.message)}</div>`;
    }
  },

  /* ---------- Seksionet ---------- */
  sections: {
    /* === Përmbledhja === */
    async overview(c) {
      const [stats, state, sensors, events, barrier] = await Promise.all([
        API.stats(), API.state(), API.sensors(), API.gateEvents({ limit: 6 }), API.barrier(),
      ]);
      const offline = sensors.data.filter((s) => s.sensor_ok === false || s.status === "unknown").length;
      const activeSessions = state.sessions.filter((s) => !s.end).length;
      const uniqueVisitors = new Set(state.sessions.map((s) => s.plate).filter((p) => p !== "-")).size;

      c.innerHTML = `
        <div class="page-head"><div><h1>Përmbledhja</h1><p>Gjendja e sistemit në kohë reale.</p></div>
          <span class="badge ${barrier.status}">Barriera: ${barrier.status === "open" ? "E hapur" : "E mbyllur"}</span></div>
        <div class="stats-grid">
          <div class="card stat-card"><span class="s-label">Vende gjithsej</span><span class="s-value">${stats.total}</span><span class="s-icon">🅿️</span></div>
          <div class="card stat-card c-free"><span class="s-label">Të lira</span><span class="s-value">${stats.free}</span><span class="s-icon">✓</span></div>
          <div class="card stat-card c-occ"><span class="s-label">Të zëna</span><span class="s-value">${stats.occupied}</span><span class="s-icon">🚗</span></div>
          <div class="card stat-card c-warn"><span class="s-label">Rezervime aktive</span><span class="s-value">${stats.reserved}</span><span class="s-icon">🕒</span></div>
          <div class="card stat-card c-off"><span class="s-label">Sensorë offline</span><span class="s-value">${offline}</span><span class="s-icon">📡</span></div>
          <div class="card stat-card"><span class="s-label">Qëndrime aktive</span><span class="s-value">${activeSessions}</span><span class="s-icon">⏱</span></div>
          <div class="card stat-card"><span class="s-label">Vizitorë gjithsej</span><span class="s-value">${uniqueVisitors}</span><span class="s-icon">👥</span></div>
        </div>
        <div class="grid-3 mt">
          <div class="card card-pad">
            <h3>Zënia (${stats.occupancy_pct}%)</h3>
            <div class="ring" style="--p:${stats.occupancy_pct}"><div><span><b>${stats.occupancy_pct}%</b><small>e zënë</small></span></div></div>
            <div class="bars">${["A", "B", "C"].map((k) => {
              const sp = Object.entries(state.spots).filter(([key]) => key.startsWith(k + "-"));
              const occ = sp.filter(([, s]) => s.status === "occupied").length;
              const known = sp.filter(([, s]) => s.status !== "unknown").length;
              const pct = known ? Math.round((occ / known) * 100) : 0;
              return `<div class="bar-row"><span>Sektori ${k}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><b>${pct}%</b></div>`;
            }).join("")}</div>
          </div>
          <div class="card card-pad">
            <h3>Aktiviteti i fundit i vizitorëve</h3>
            <div class="list-rows">${state.sessions.slice(0, 7).map((s) => `
              <div class="row-item"><span>${UI.esc(s.name)} · <b>${UI.esc(s.key)}</b></span>
              <span class="muted small">${UI.fmtDur((s.end || Date.now()) - s.start)}${s.end ? "" : " ●"}</span></div>`).join("") ||
              `<p class="muted small">Ende pa aktivitet.</p>`}</div>
          </div>
          <div class="card card-pad">
            <h3>Hyrje / dalje të fundit</h3>
            <div class="list-rows">${events.data.map((e) => `
              <div class="row-item"><span><span class="badge ${e.type}">${e.type === "entry" ? "Hyrje" : "Dalje"}</span>
              ${e.plate ? `<span class="mono small">${UI.esc(e.plate)}</span>` : ""}</span>
              <span class="muted small">${UI.fmtDt(e.created_at)}</span></div>`).join("") ||
              `<p class="muted small">Ende pa ngjarje.</p>`}</div>
            <h3 class="mt">Sensorët</h3>
            <div class="list-rows">${sensors.data.map((s) => `
              <div class="row-item"><span class="mono">${UI.esc(s.spot_key)}</span>
              <span>${s.sensor_ok === false || s.status === "unknown" ? `<span class="badge unknown">Offline</span>` : `<span class="badge free">OK</span>`}</span></div>`).join("")}</div>
          </div>
        </div>`;
    },

    /* === Vendet e Parkimit === */
    async spots(c, page = 1) {
      const sectorF = c.dataset.sector || "";
      const statusF = c.dataset.status || "";
      const search = c.dataset.search || "";
      const params = { page, limit: 15 };
      if (sectorF) params.sector = sectorF;
      if (statusF) params.status = statusF;
      const r = await API.spots(params);
      const rows = r.data.filter((s) => !search || s.spot_key.toUpperCase().includes(search.toUpperCase()));

      c.innerHTML = `
        <div class="page-head"><div><h1>Vendet e Parkimit</h1><p>${r.total} vende të konfiguruara.</p></div></div>
        <div class="card">
          <div class="card-bar">
            <div class="filters">
              <input id="fSearch" placeholder="Kërko (p.sh. A-P1)…" value="${UI.esc(search)}">
              <select id="fSector">
                <option value="">Të gjithë sektorët</option>
                ${["A", "B", "C"].map((k) => `<option value="${k}" ${sectorF === k ? "selected" : ""}>Sektori ${k}</option>`).join("")}
              </select>
              <select id="fStatus">
                <option value="">Çdo status</option>
                <option value="free" ${statusF === "free" ? "selected" : ""}>I lirë</option>
                <option value="occupied" ${statusF === "occupied" ? "selected" : ""}>I zënë</option>
                <option value="unknown" ${statusF === "unknown" ? "selected" : ""}>Pa sinjal</option>
              </select>
            </div>
          </div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Vendi</th><th>Sektori</th><th>Statusi</th><th>Distanca</th><th>Sensor</th><th>Përditësuar</th><th></th></tr></thead>
            <tbody>${rows.map((s) => `
              <tr>
                <td class="mono"><b>${UI.esc(s.spot_key)}</b></td>
                <td>${UI.esc(s.sector)}</td>
                <td>${UI.badge(s.status)}</td>
                <td>${s.distance_cm != null ? s.distance_cm.toFixed(1) + " cm" : "—"}</td>
                <td>${s.has_sensor ? "📡 Po" : "—"}</td>
                <td class="muted small">${UI.fmtDt(s.updated_at)}</td>
                <td><button class="btn btn-sm" data-detail="${s.spot_key}">Detajet</button></td>
              </tr>`).join("") || `<tr><td colspan="7" class="tbl-empty">Asnjë vend nuk përputhet me filtrat.</td></tr>`}</tbody>
          </table></div>
          <div class="pager">
            <span>Faqja ${r.page} / ${r.total_pages}</span>
            <button class="btn btn-sm" id="pgPrev" ${r.page <= 1 ? "disabled" : ""}>←</button>
            <button class="btn btn-sm" id="pgNext" ${r.page >= r.total_pages ? "disabled" : ""}>→</button>
          </div>
        </div>
        <p class="muted small mt">Shënim: krijimi/fshirja e vendeve bëhet në skemën e databazës (pronar: Erdi) — s'ka endpoint për të në backend.</p>`;

      const reload = () => {
        c.dataset.sector = UI.$("fSector").value;
        c.dataset.status = UI.$("fStatus").value;
        c.dataset.search = UI.$("fSearch").value;
        Admin.sections.spots.call(Admin, c, 1);
      };
      UI.$("fSector").onchange = reload;
      UI.$("fStatus").onchange = reload;
      let timer;
      UI.$("fSearch").oninput = () => { clearTimeout(timer); timer = setTimeout(reload, 350); };
      UI.$("pgPrev").onclick = () => Admin.sections.spots.call(Admin, c, r.page - 1);
      UI.$("pgNext").onclick = () => Admin.sections.spots.call(Admin, c, r.page + 1);
      c.querySelectorAll("[data-detail]").forEach((b) => (b.onclick = () => Admin.spotDetail(b.dataset.detail)));
    },

    /* === Vizitorët (qëndrimet) === */
    async visitors(c) {
      const state = await API.state();
      const open = state.sessions.filter((s) => !s.end);
      const done = state.sessions.filter((s) => s.end);
      const row = (s) => `
        <tr><td>${UI.esc(s.name)}</td><td class="mono">${UI.esc(s.plate)}</td><td class="mono"><b>${UI.esc(s.key)}</b></td>
        <td class="muted small">${UI.fmtDt(s.start)}</td>
        <td>${s.until ? UI.hm(s.until) : "—"}</td>
        <td>${s.end ? `<span class="muted small">${UI.fmtDur(s.end - s.start)}</span>` : `<b>${UI.fmtDur(Date.now() - s.start)}</b> <span class="badge active">Aktiv</span>`}</td></tr>`;
      c.innerHTML = `
        <div class="page-head"><div><h1>Vizitorët</h1><p>${open.length} në parking tani · ${done.length} qëndrime të përfunduara.</p></div></div>
        <div class="card">
          <div class="card-bar"><h2>Në parking tani</h2></div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Emri</th><th>Targa</th><th>Vendi</th><th>Hyri</th><th>Del në</th><th>Kohëzgjatja</th></tr></thead>
            <tbody>${open.map(row).join("") || `<tr><td colspan="6" class="tbl-empty">Askush në parking për momentin.</td></tr>`}</tbody>
          </table></div>
        </div>
        <div class="card mt">
          <div class="card-bar"><h2>Historiku i qëndrimeve</h2></div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Emri</th><th>Targa</th><th>Vendi</th><th>Hyri</th><th>Del në</th><th>Kohëzgjatja</th></tr></thead>
            <tbody>${done.slice(0, 20).map(row).join("") || `<tr><td colspan="6" class="tbl-empty">Ende pa historik.</td></tr>`}</tbody>
          </table></div>
        </div>`;
    },

    /* === Rezervimet === */
    async reservations(c) {
      const state = await API.state();
      c.innerHTML = `
        <div class="page-head"><div><h1>Rezervimet</h1><p>${state.res.length} rezervime aktive.</p></div></div>
        <div class="card">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Vendi</th><th>Emri</th><th>Targa</th><th>Krijuar</th><th>Deri në</th><th>Statusi</th></tr></thead>
            <tbody>${state.res.map((r) => `
              <tr><td class="mono"><b>${UI.esc(r.key)}</b></td><td>${UI.esc(r.name)}</td><td class="mono">${UI.esc(r.plate)}</td>
              <td class="muted small">${UI.fmtDt(r.start)}</td><td><b>${UI.hm(r.end)}</b></td>
              <td>${Date.now() > r.end ? `<span class="badge unknown">Skaduar</span>` : UI.badge("reserved")}</td></tr>`).join("") ||
              `<tr><td colspan="6" class="tbl-empty">S'ka rezervime aktive.</td></tr>`}</tbody>
          </table></div>
        </div>
        <p class="muted small mt">Anulimi i rezervimit bëhet vetëm nga vetë vizitori (me token-in e tij) — backend-i s'lejon anulim nga admini.</p>`;
    },

    /* === Menaxhimi i QR === */
    async qr(c) {
      const r = await API.spots({ limit: 200 });
      const base = UI.qrBase();
      const isLocal = /localhost|127\.0\.0\.1/.test(base);
      c.innerHTML = `
        <div class="page-head"><div><h1>Menaxhimi i QR</h1><p>QR-të e vendeve — printohen dhe ngjiten te çdo vend parkimi.</p></div>
          <button class="btn" onclick="window.print()">🖨 Printo faqen</button></div>
        ${isLocal ? `<div class="alert error">⚠ QR-të po gjenerohen me <b>${UI.esc(base)}</b> — telefonat s'e hapin dot "localhost".
          Vendos URL-në publike (IP-ja e rrjetit lokal ose domeni) te <b>Cilësimet → URL publike</b> para se t'i printosh.</div>`
        : `<div class="alert info">QR-të gjenerohen me bazën: <b>${UI.esc(base)}</b></div>`}
        <div class="qr-grid">
          ${r.data.map((s) => `
            <div class="card qr-card">
              <div class="qr-box">${UI.qrSvg(`${base}/#/spot/${encodeURIComponent(s.spot_key)}`, 3)}</div>
              <b class="mono">${UI.esc(s.spot_key)}</b>
              <small>Sektori ${UI.esc(s.sector)}${s.has_sensor ? " · me sensor" : ""}</small>
            </div>`).join("")}
        </div>`;
    },

    /* === Sensorët === */
    async sensors(c) {
      const r = await API.sensors();
      c.innerHTML = `
        <div class="page-head"><div><h1>Sensorët</h1><p>Sensorët HC-SR04 të lidhur me Arduino (Sektori A).</p></div></div>
        <div class="card">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Sensori</th><th>Vendi</th><th>Distanca</th><th>Shëndeti</th><th>Matja e fundit</th><th>Statusi</th><th></th></tr></thead>
            <tbody>${r.data.map((s, i) => `
              <tr>
                <td class="mono">HC-SR04 #${i + 1}</td>
                <td class="mono"><b>${UI.esc(s.spot_key)}</b></td>
                <td>${s.distance_cm != null ? `<b>${s.distance_cm.toFixed(1)} cm</b>` : "—"}</td>
                <td>${s.sensor_ok == null ? `<span class="badge unknown">Pa matje ende</span>`
                     : s.sensor_ok ? `<span class="badge free">Shëndoshë</span>`
                     : `<span class="badge occupied">Pa echo</span>`}</td>
                <td class="muted small">${UI.fmtDt(s.last_reading_at)}</td>
                <td>${UI.badge(s.status)}</td>
                <td><button class="btn btn-sm" data-hist="${s.spot_key}">Historiku</button></td>
              </tr>`).join("") || `<tr><td colspan="7" class="tbl-empty">S'ka sensorë të konfiguruar.</td></tr>`}</tbody>
          </table></div>
        </div>
        <div class="card card-pad mt" id="histCard" hidden>
          <h3 id="histTitle"></h3>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Distanca</th><th>Statusi</th><th>Sensor OK</th><th>Koha</th></tr></thead>
            <tbody id="histBody"></tbody>
          </table></div>
        </div>`;
      c.querySelectorAll("[data-hist]").forEach((b) => (b.onclick = async () => {
        const key = b.dataset.hist;
        const h = await API.readings(key, { limit: 15 });
        UI.$("histCard").hidden = false;
        UI.$("histTitle").textContent = `Matjet e fundit — ${key} (${h.total} gjithsej)`;
        UI.$("histBody").innerHTML = h.data.map((x) => `
          <tr><td>${x.distance_cm != null ? x.distance_cm.toFixed(1) + " cm" : "—"}</td>
          <td>${UI.badge(x.status)}</td><td>${x.sensor_ok ? "✓" : "✗"}</td>
          <td class="muted small">${UI.fmtDt(x.created_at)}</td></tr>`).join("");
        UI.$("histCard").scrollIntoView({ behavior: "smooth" });
      }));
    },

    /* === Lidhja Arduino === */
    async arduino(c) {
      const supported = SerialBridge.supported();
      c.innerHTML = `
        <div class="page-head"><div><h1>Lidhja Arduino</h1><p>Ura serial → backend. Vetëm për kompjuterin e lidhur fizikisht me Arduino.</p></div></div>
        ${supported ? "" : `<div class="alert error">Ky shfletues s'e mbështet Web Serial API — përdor Chrome ose Edge në desktop.</div>`}
        <div class="grid-2">
          <div class="card card-pad">
            <h3>Lidhja USB</h3>
            <div class="list-rows" style="margin-bottom:14px">
              <div class="row-item"><span>Gjendja</span><b id="serStatus">${SerialBridge.isConnected() ? "I lidhur" : "I shkëputur"}</b></div>
              <div class="row-item"><span>Shpejtësia</span><span class="mono small">9600 baud</span></div>
              <div class="row-item"><span>Demo</span><b id="demoStatus">${SerialBridge.isDemo() ? "Aktiv (simulim)" : "Joaktiv"}</b></div>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn btn-primary" id="serConnect" ${!supported || SerialBridge.isConnected() ? "disabled" : ""}>Lidh USB</button>
              <button class="btn" id="serDisconnect" ${SerialBridge.isConnected() ? "" : "disabled"}>Shkëput</button>
              <button class="btn ${SerialBridge.isDemo() ? "btn-danger" : ""}" id="demoToggle">${SerialBridge.isDemo() ? "Ndalo demon" : "Fillo demon"}</button>
            </div>
            <div class="field mt">
              <label for="bridgeKey">Çelësi API i urës (ruhet vetëm në këtë pajisje)</label>
              <div class="pw-wrap">
                <input id="bridgeKey" type="password" autocomplete="off" value="${UI.esc(API.store.bridgeKey)}" placeholder="pk_…">
                <button type="button" class="pw-toggle" id="bkToggle">👁</button>
              </div>
              <div class="hint">Gjenerohet me "npm run seed" ose te seksioni "Çelësat API". Mos e publiko askund.</div>
            </div>
          </div>
          <div class="card card-pad">
            <h3>Log serial</h3>
            <div class="log-box" id="serLog">Në pritje…</div>
            <p class="muted small mt">Formati i pritur: <span class="mono">Sensori 1 (D8/D9): 4.2 cm | Sensori 2 (D6/D7): …</span></p>
          </div>
        </div>`;

      const logBox = UI.$("serLog");
      const log = (msg, cls) => {
        const line = document.createElement("div");
        if (cls) line.className = cls;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logBox.appendChild(line);
        logBox.scrollTop = logBox.scrollHeight;
        while (logBox.childNodes.length > 150) logBox.removeChild(logBox.firstChild);
      };
      const syncButtons = () => {
        const connected = SerialBridge.isConnected(), demo = SerialBridge.isDemo();
        UI.$("serStatus").textContent = connected ? "I lidhur" : "I shkëputur";
        UI.$("demoStatus").textContent = demo ? "Aktiv (simulim)" : "Joaktiv";
        UI.$("serConnect").disabled = !supported || connected;
        UI.$("serDisconnect").disabled = !connected;
        UI.$("demoToggle").textContent = demo ? "Ndalo demon" : "Fillo demon";
        UI.$("demoToggle").classList.toggle("btn-danger", demo);
      };
      SerialBridge.setHandlers({ onLog: log, onStatus: syncButtons });

      UI.$("serConnect").onclick = async () => {
        try { await SerialBridge.connect(); } catch (e) { log(e.message, "err"); UI.toast(e.message, "error"); }
        syncButtons();
      };
      UI.$("serDisconnect").onclick = () => SerialBridge.disconnect();
      UI.$("demoToggle").onclick = () => (SerialBridge.isDemo() ? SerialBridge.stopDemo() : SerialBridge.startDemo());
      UI.$("bridgeKey").oninput = (e) => { API.store.bridgeKey = e.target.value.trim(); };
      UI.$("bkToggle").onclick = () => {
        const i = UI.$("bridgeKey");
        i.type = i.type === "password" ? "text" : "password";
      };
    },

    /* === Kontrolli i Barrierës === */
    async gate(c) {
      const [barrier, events] = await Promise.all([API.barrier(), API.barrierEvents({ limit: 10 })]);
      const isOpen = barrier.status === "open";
      c.innerHTML = `
        <div class="page-head"><div><h1>Kontrolli i Barrierës</h1><p>Hapja/mbyllja manuale regjistrohet në audit log.</p></div></div>
        <div class="grid-2">
          <div class="card card-pad">
            <div class="gate-visual">
              <div class="gate-arm-track">
                <div class="gate-arm ${isOpen ? "open" : ""}" id="gateArm"></div>
                <div class="gate-post"></div>
                <div class="gate-ground"></div>
              </div>
              <span class="badge ${barrier.status}" id="gateBadge">${isOpen ? "E HAPUR" : barrier.status === "closed" ? "E MBYLLUR" : "GABIM"}</span>
              <span class="muted small">Përditësuar: ${UI.fmtDt(barrier.updated_at)}</span>
            </div>
            <div style="display:flex;gap:10px;justify-content:center" class="mt">
              <button class="btn btn-success" id="gateOpen" ${isOpen ? "disabled" : ""}>▲ Hap barrierën</button>
              <button class="btn btn-danger" id="gateClose" ${!isOpen ? "disabled" : ""}>▼ Mbyll barrierën</button>
            </div>
          </div>
          <div class="card">
            <div class="card-bar"><h2>Historiku i barrierës</h2></div>
            <div class="table-wrap"><table class="tbl">
              <thead><tr><th>Statusi</th><th>Arsyeja</th><th>Burimi</th><th>Koha</th></tr></thead>
              <tbody>${events.data.map((e) => `
                <tr><td><span class="badge ${e.status}">${e.status}</span></td>
                <td>${UI.esc(e.reason || "—")}</td><td class="mono small">${UI.esc(e.source)}</td>
                <td class="muted small">${UI.fmtDt(e.created_at)}</td></tr>`).join("") ||
                `<tr><td colspan="4" class="tbl-empty">Ende pa ngjarje.</td></tr>`}</tbody>
            </table></div>
          </div>
        </div>`;

      const control = async (status) => {
        try {
          await API.adminBarrier(status, "komandë manuale nga paneli");
          UI.toast(`Barriera ${status === "open" ? "u hap" : "u mbyll"}`, "ok");
          Admin.sections.gate.call(Admin, c);
        } catch (e) { UI.toast(e.message, "error"); }
      };
      UI.$("gateOpen").onclick = () => control("open");
      UI.$("gateClose").onclick = () => control("closed");
    },

    /* === Përdoruesit (vetëm admin) === */
    async users(c) {
      const r = await API.adminUsers();
      c.innerHTML = `
        <div class="page-head"><div><h1>Përdoruesit</h1><p>Administratorët dhe operatorët e sistemit.</p></div>
          <button class="btn btn-primary" id="newUser">+ Përdorues i ri</button></div>
        <div class="card">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>ID</th><th>Përdoruesi</th><th>Roli</th><th>Hyrja e fundit</th><th>Krijuar</th></tr></thead>
            <tbody>${r.data.map((u) => `
              <tr><td>${u.id}</td><td><b>${UI.esc(u.username)}</b></td>
              <td><span class="badge ${u.role}">${u.role}</span></td>
              <td class="muted small">${UI.fmtDt(u.last_login)}</td>
              <td class="muted small">${UI.fmtDt(u.created_at)}</td></tr>`).join("")}</tbody>
          </table></div>
        </div>`;
      UI.$("newUser").onclick = () => {
        UI.modal(`
          <h3>Përdorues i ri</h3>
          <p class="m-sub">Fjalëkalimi duhet të ketë së paku 8 karaktere.</p>
          <div id="nuAlert"></div>
          <form id="nuForm">
            <div class="field"><label for="nuUser">Emri i përdoruesit</label><input id="nuUser" required maxlength="50"></div>
            <div class="field"><label for="nuPass">Fjalëkalimi</label><input id="nuPass" type="password" required minlength="8"></div>
            <div class="field"><label for="nuRole">Roli</label>
              <select id="nuRole"><option value="operator">operator — qasje bazë</option><option value="admin">admin — qasje e plotë</option></select></div>
            <button class="btn btn-primary btn-block" type="submit">Krijo</button>
          </form>`);
        UI.$("nuForm").onsubmit = async (e) => {
          e.preventDefault();
          try {
            await API.adminCreateUser({ username: UI.$("nuUser").value.trim(), password: UI.$("nuPass").value, role: UI.$("nuRole").value });
            UI.closeModal(); UI.toast("Përdoruesi u krijua", "ok");
            Admin.sections.users.call(Admin, c);
          } catch (err) {
            UI.$("nuAlert").innerHTML = `<div class="alert error">${UI.esc(err.message)}</div>`;
          }
        };
      };
    },

    /* === Çelësat API (vetëm admin) === */
    async keys(c) {
      const r = await API.adminApiKeys();
      c.innerHTML = `
        <div class="page-head"><div><h1>Çelësat API</h1><p>Për urën e Arduino-s. Ruhen vetëm si hash — vlera e plotë shfaqet vetëm në krijim.</p></div>
          <button class="btn btn-primary" id="newKey">+ Çelës i ri</button></div>
        <div id="keyReveal"></div>
        <div class="card">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>ID</th><th>Emri</th><th>Krijuar</th><th>Skadon</th><th>Statusi</th><th></th></tr></thead>
            <tbody>${r.data.map((k) => `
              <tr><td>${k.id}</td><td><b>${UI.esc(k.name)}</b></td>
              <td class="muted small">${UI.fmtDt(k.created_at)}</td>
              <td class="muted small">${k.expires_at ? UI.fmtDt(k.expires_at) : "Kurrë"}</td>
              <td><span class="badge ${k.is_active ? "active" : "inactive"}">${k.is_active ? "Aktiv" : "I çaktivizuar"}</span></td>
              <td>${k.is_active ? `<button class="btn btn-sm btn-danger" data-revoke="${k.id}">Çaktivizo</button>` : ""}</td></tr>`).join("")}</tbody>
          </table></div>
        </div>`;
      UI.$("newKey").onclick = () => {
        UI.modal(`
          <h3>Çelës API i ri</h3>
          <div id="nkAlert"></div>
          <form id="nkForm">
            <div class="field"><label for="nkName">Emri (p.sh. arduino-bridge-2)</label><input id="nkName" required maxlength="50"></div>
            <button class="btn btn-primary btn-block" type="submit">Gjenero çelësin</button>
          </form>`);
        UI.$("nkForm").onsubmit = async (e) => {
          e.preventDefault();
          try {
            const k = await API.adminCreateApiKey({ name: UI.$("nkName").value.trim() });
            UI.closeModal();
            Admin.sections.keys.call(Admin, c).then(() => {
              UI.$("keyReveal").innerHTML = `
                <div class="alert ok">Çelësi <b>${UI.esc(k.name)}</b> u krijua. Kopjoje TANI — s'do të shfaqet më kurrë:
                <div class="key-reveal">${UI.esc(k.key)}</div>
                <button class="btn btn-sm" onclick="navigator.clipboard.writeText('${UI.esc(k.key)}').then(()=>UI.toast('U kopjua','ok'))">📋 Kopjo</button></div>`;
            });
          } catch (err) {
            UI.$("nkAlert").innerHTML = `<div class="alert error">${UI.esc(err.message)}</div>`;
          }
        };
      };
      c.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => {
        if (!confirm("Ta çaktivizoj këtë çelës? Ura që e përdor do të ndalojë së punuari.")) return;
        try { await API.adminRevokeApiKey(b.dataset.revoke); UI.toast("Çelësi u çaktivizua", "ok"); Admin.sections.keys.call(Admin, c); }
        catch (e) { UI.toast(e.message, "error"); }
      }));
    },

    /* === Audit Log (vetëm admin) === */
    async audit(c, page = 1) {
      const r = await API.adminAudit({ page, limit: 20 });
      const LABELS = {
        login: "Hyrje", login_failed: "Hyrje e dështuar", logout: "Dalje",
        user_created: "Përdorues i krijuar", api_key_created: "Çelës API i krijuar",
        api_key_revoked: "Çelës API i çaktivizuar", barrier_control: "Kontroll barriere",
      };
      c.innerHTML = `
        <div class="page-head"><div><h1>Audit Log</h1><p>${r.total} veprime të regjistruara.</p></div></div>
        <div class="card">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>ID</th><th>Përdoruesi</th><th>Veprimi</th><th>Detajet</th><th>Koha</th></tr></thead>
            <tbody>${r.data.map((a) => `
              <tr><td>${a.id}</td><td><b>${UI.esc(a.username || "—")}</b></td>
              <td>${UI.esc(LABELS[a.action] || a.action)}</td>
              <td class="mono small muted">${UI.esc(a.details || "")}</td>
              <td class="muted small">${UI.fmtDt(a.created_at)}</td></tr>`).join("") ||
              `<tr><td colspan="5" class="tbl-empty">Ende pa veprime.</td></tr>`}</tbody>
          </table></div>
          <div class="pager">
            <span>Faqja ${r.page} / ${r.total_pages || 1}</span>
            <button class="btn btn-sm" id="auPrev" ${r.page <= 1 ? "disabled" : ""}>←</button>
            <button class="btn btn-sm" id="auNext" ${r.page >= r.total_pages ? "disabled" : ""}>→</button>
          </div>
        </div>`;
      UI.$("auPrev").onclick = () => Admin.sections.audit.call(Admin, c, r.page - 1);
      UI.$("auNext").onclick = () => Admin.sections.audit.call(Admin, c, r.page + 1);
    },

    /* === Cilësimet === */
    async settings(c) {
      const me = API.store.admin;
      c.innerHTML = `
        <div class="page-head"><div><h1>Cilësimet</h1><p>Preferencat lokale dhe informacioni i sesionit.</p></div></div>
        <div class="grid-2">
          <div class="card card-pad">
            <h3>Pamja</h3>
            <div class="field"><label>Tema</label>
              <div style="display:flex;gap:10px">
                <button class="btn" id="setGlass">☀ White Glass</button>
                <button class="btn" id="setDark">🌙 Black Parking</button>
              </div>
              <div class="hint">Ruhet në shfletues dhe rikthehet në çdo hapje.</div>
            </div>
            <div class="field">
              <label for="publicUrl">URL publike (për kodet QR)</label>
              <input id="publicUrl" placeholder="p.sh. http://192.168.1.50:3000 ose https://parkimi.shembull.com"
                value="${UI.esc(localStorage.getItem("pi_public_url") || "")}">
              <div class="hint">QR-të e printuara duhet të hapen nga telefonat — mos lër "localhost".
                Bosh = përdoret adresa aktuale e shfletuesit.</div>
            </div>
          </div>
          <div class="card card-pad">
            <h3>Sesioni</h3>
            <div class="list-rows">
              <div class="row-item"><span>Përdoruesi</span><b>${UI.esc(me.username)}</b></div>
              <div class="row-item"><span>Roli</span><span class="badge ${me.role}">${me.role}</span></div>
              <div class="row-item"><span>Skadon</span><b>${UI.fmtDt(me.expires_at)}</b></div>
            </div>
            <p class="muted small mt">Pragjet e klasifikimit (≤3 cm i zënë, ≤10 cm i lirë) konfigurohen në backend përmes .env (OCC_THRESHOLD_CM, MAX_RANGE_CM).</p>
          </div>
        </div>`;
      UI.$("setGlass").onclick = () => Theme.set("glass");
      UI.$("setDark").onclick = () => Theme.set("dark");
      UI.$("publicUrl").oninput = (e) => {
        const v = e.target.value.trim();
        if (v) localStorage.setItem("pi_public_url", v);
        else localStorage.removeItem("pi_public_url");
      };
    },
  },

  async spotDetail(key) {
    const d = await API.spot(key);
    const st = d.status === "free" && d.reservation ? "reserved" : d.status;
    UI.modal(`
      <h3>${UI.esc(key)}</h3>
      <p class="m-sub">Sektori ${UI.esc(d.sector)} · ${d.has_sensor ? "me sensor HC-SR04" : "pa sensor"}</p>
      <div class="list-rows">
        <div class="row-item"><span>Statusi</span>${UI.badge(st)}</div>
        ${d.distance_cm != null ? `<div class="row-item"><span>Distanca</span><b>${d.distance_cm.toFixed(1)} cm</b></div>` : ""}
        <div class="row-item"><span>Përditësuar</span><b>${UI.fmtDt(d.updated_at)}</b></div>
        ${d.active_session ? `<div class="row-item"><span>Në parking</span><b>${UI.esc(d.active_session.name)} (${UI.esc(d.active_session.plate)})</b></div>` : ""}
        ${d.reservation ? `<div class="row-item"><span>Rezervuar nga</span><b>${UI.esc(d.reservation.name)} deri ${UI.hm(d.reservation.until)}</b></div>` : ""}
      </div>
      <button class="btn btn-ghost mt" onclick="UI.closeModal()">Mbyll</button>`, { wide: false });
  },
});