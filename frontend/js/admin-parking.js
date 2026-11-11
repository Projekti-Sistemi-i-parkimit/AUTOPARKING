/* ============================================================
   Paneli i grupit "parking" (Erdi — D3, D5, D6)
   Shton tre seksione në panelin e adminit pa ndryshuar admin.js:
     • Struktura            — sektorët, katet dhe vendet (CRUD)
     • Parametrat           — pragjet e klasifikimit, politika e leximeve dhe e ruajtjes
     • Raportet & të dhënat — statistikat, eksporti CSV, integriteti, backup, pastrimi
   Regjistrohen përmes Admin.NAV dhe Admin.sections (të ekspozuara nga admin.js).
   Efektet vizuale sipas Magic UI (MIT) nga 21st.dev: NumberTicker, MagicCard, BorderBeam.
   ============================================================ */
(function () {
  "use strict";

  const I = (name, cls) => window.PkIcons.svg(name, cls);
  const esc = (v) => UI.esc(v == null ? "" : String(v));
  const isAdmin = () => API.store.admin && API.store.admin.role === "admin";
  const nf = new Intl.NumberFormat("sq-AL", { maximumFractionDigits: 1 });
  const DAY = 86400000;

  // Paneli i ekipit e rindërton gjithë pamjen në çdo ngjarje live (Live.rerender), pra
  // gjendja e seksioneve ruhet këtu dhe jo në DOM: përzgjedhjet, ndryshimet e paruajtura,
  // rezultatet e kontrolleve dhe fokusi rikthehen pas çdo rindërtimi.
  const state = { sector: null, days: 7, rSector: "", draft: null, checks: null, purge: null, cache: new Map(), focus: null };
  const host = () => document.getElementById("adminContent");
  const reloadSection = (id) => { const c = host(); if (c && Admin.section === id) Admin.sections[id].call(Admin, c); };

  document.addEventListener("focusin", (e) => {
    const el = e.target;
    state.focus = el && el.id && el.closest && el.closest("#adminContent .pk") ? el.id : null;
  });
  function restoreFocus() {
    if (!state.focus) return;
    const el = document.getElementById(state.focus);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }

  // Kërkesat e leximit ruhen 20 s, që ngjarjet live të mos ringarkojnë statistikat çdo herë.
  async function cached(key, fn, ttl = 20000) {
    const hit = state.cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    state.cache.set(key, { v, t: Date.now() });
    return v;
  }

  /* ---------- Klienti HTTP (admin) ---------- */
  async function call(method, path, body) {
    const headers = { Authorization: `Bearer ${API.store.adminToken}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new API.ApiError(0, "S'ka lidhje me serverin");
    }
    let json = null;
    try { json = await res.json(); } catch { /* trup bosh */ }
    if (!res.ok) {
      if (res.status === 401) {
        API.store.adminToken = null; API.store.admin = null;
        document.dispatchEvent(new CustomEvent("admin:expired"));
      }
      throw new API.ApiError(res.status, (json && json.error) || `Gabim ${res.status}`);
    }
    if (method !== "GET") state.cache.clear(); // çdo ndryshim i bën të vjetra statistikat e ruajtura
    return json;
  }

  // Shkarkon një skedar (CSV / backup) me token-in e adminit.
  async function download(path) {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${API.store.adminToken}` } });
    if (!res.ok) {
      let msg = `Gabim ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* jo JSON */ }
      throw new API.ApiError(res.status, msg);
    }
    const cd = res.headers.get("content-disposition") || "";
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || "shkarkim";
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { name, rows: res.headers.get("x-row-count") };
  }

  /* ---------- Efektet ---------- */
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // NumberTicker: numri "rritet" deri te vlera me lehtësim.
  function tickers(root) {
    root.querySelectorAll("[data-tick]").forEach((el) => {
      const to = Number(el.dataset.tick);
      if (!Number.isFinite(to)) return;
      const dec = Number(el.dataset.dec || 0);
      const fmt = new Intl.NumberFormat("sq-AL", { minimumFractionDigits: dec, maximumFractionDigits: dec });
      if (reduced() || to === 0) { el.textContent = fmt.format(to); return; }
      const t0 = performance.now();
      const dur = 900 + Math.min(600, Math.log10(Math.abs(to) + 1) * 200);
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 4);
        el.textContent = fmt.format(to * e);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  // MagicCard: drita ndjek kursorin mbi kartë.
  function spotlights(root) {
    root.querySelectorAll(".pk-card").forEach((el) => {
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });
  }

  function enhance(root) { tickers(root); spotlights(root); restoreFocus(); }

  /* ---------- Copëza të përbashkëta ---------- */
  function head(icon, eyebrow, title, text, actions = "") {
    return `<div class="pk-head"><div>
        <div class="pk-eyebrow">${I(icon)}${esc(eyebrow)}</div>
        <h1>${esc(title)}</h1><p>${text}</p></div>
      <div class="pk-actions">${actions}</div></div>`;
  }

  function kpi(icon, label, value, { dec = 0, unit = "", sub = "", spark = null } = {}) {
    const v = value == null || !Number.isFinite(Number(value))
      ? `<span>—</span>`
      : `<span data-tick="${Number(value)}" data-dec="${dec}">0</span>${unit ? `<small>${esc(unit)}</small>` : ""}`;
    return `<div class="pk-card pk-kpi">
        <div class="k-label">${esc(label)}<span class="k-ico">${I(icon)}</span></div>
        <div class="k-value">${v}</div>${sub ? `<div class="k-sub">${sub}</div>` : ""}${sparkHtml(spark)}</div>`;
  }

  // Shirit i vogël shtyllash (si "barcode" në referencë) — vlerat e fundit në të djathtë.
  function sparkHtml(values) {
    if (!values || values.length < 2) return "";
    const vals = values.slice(-16);
    const max = Math.max(1, ...vals);
    return `<div class="k-spark" aria-hidden="true">${vals.map((v) => `<i style="height:${Math.max(10, (v / max) * 100)}%"></i>`).join("")}</div>`;
  }

  const fail = (box, e) => { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; };

  function formModal(title, sub, fields, onSubmit) {
    UI.modal(`
      <form class="pk pk-form" id="pkForm" novalidate>
        <h3>${esc(title)}</h3>${sub ? `<p class="m-sub">${sub}</p>` : ""}
        <div id="pkFormAlert"></div>
        ${fields}
        <div class="pk-form-actions">
          <button type="button" class="btn btn-ghost" id="pkCancel">Anulo</button>
          <button type="submit" class="btn btn-primary" id="pkSubmit">${I("save")} Ruaj</button>
        </div>
      </form>`);
    UI.$("pkCancel").onclick = () => UI.closeModal();
    const form = UI.$("pkForm");
    const first = form.querySelector("input:not([type=checkbox]):not([disabled]), select");
    if (first) first.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = UI.$("pkSubmit");
      btn.disabled = true;
      try {
        await onSubmit(new FormData(form), form);
        UI.closeModal();
      } catch (err) {
        UI.$("pkFormAlert").innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
  }

  const field = (name, label, { value = "", type = "text", hint = "", attrs = "" } = {}) => `
    <div class="field"><label for="pk_${name}">${esc(label)}</label>
      <input id="pk_${name}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}>
      ${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
  const check = (name, label, on) => `
    <label class="pk-check"><input type="checkbox" name="${name}" ${on ? "checked" : ""}> ${esc(label)}</label>`;
  const intOrUndef = (v) => (v === null || v === "" ? undefined : Number(v));

  // Statusi pa ngjyra: e zënë = pikë e mbushur, e lirë = rreth, pa sinjal = gri.
  function statusChip(status) {
    const st = status || "unknown";
    const label = { occupied: "E zënë", free: "E lirë", unknown: "Pa sinjal" }[st] || st;
    return `<span class="pk-status ${st}"><span class="pk-dot ${st === "free" ? "hollow" : ""}"></span>${esc(label)}</span>`;
  }

  /* =====================================================================
     STRUKTURA — sektorët → katet → vendet
     ===================================================================== */
  async function structure(c) {
    const sectors = (await call("GET", "/api/admin/structure")).data;
    const selected = sectors.find((s) => s.code === state.sector) || sectors[0];
    const spotList = selected ? (await call("GET", `/api/admin/spots?sector=${encodeURIComponent(selected.code)}`)).data : [];
    const admin = isAdmin();

    const totals = sectors.reduce((a, s) => ({
      floors: a.floors + s.floors.length,
      spots: a.spots + s.spot_count,
      sensors: a.sensors + s.sensor_count,
      occupied: a.occupied + s.floors.reduce((x, f) => x + f.occupied, 0),
    }), { floors: 0, spots: 0, sensors: 0, occupied: 0 });

    c.innerHTML = `<div class="pk">
      ${head("building-2", "Struktura e parkingut", "Sektorët, katet dhe vendet",
        "Organizimi fizik i qendrës tregtare. Sektori A është maketa me sensorë live; sektorët DEMO kanë të dhëna të simuluara për prezantim.",
        admin ? `<button class="btn btn-primary" id="pkAddSector">${I("plus")} Sektor i ri</button>` : "")}

      <div class="pk-kpis">
        ${kpi("building-2", "Sektorë", sectors.length, { sub: `${sectors.filter((s) => s.is_demo).length} DEMO · ${sectors.filter((s) => !s.is_demo).length} live` })}
        ${kpi("layers", "Kate", totals.floors, { sub: `${sectors.filter((s) => s.floors.length > 1).length} sektor me shumë kate` })}
        ${kpi("square-parking", "Vende parkimi", totals.spots, { sub: `${totals.occupied} të zëna tani` })}
        ${kpi("radar", "Sensorë HC-SR04", totals.sensors, { sub: "+ 1 sensor te hyrja (S7)" })}
      </div>

      <div class="pk-sectors">
        ${sectors.map((s) => `
          <div class="pk-card pk-sector ${s.is_active ? "" : "off"} ${selected && s.id === selected.id ? "pk-selected" : ""}" data-pick="${esc(s.code)}" tabindex="0" role="button" aria-pressed="${selected && s.id === selected.id}">
            <div class="pk-sector-top">
              <div class="pk-sector-code ${s.is_demo ? "demo" : ""}">${esc(s.code)}</div>
              <div><b>${esc(s.name)}</b>
                <small>${s.spot_count} vende · ${s.floors.length} ${s.floors.length === 1 ? "kat" : "kate"}</small></div>
              ${admin ? `<div class="pk-row-actions">
                <button class="pk-icon-btn" data-edit-sector="${s.id}" title="Ndrysho sektorin" aria-label="Ndrysho sektorin ${esc(s.code)}">${I("pencil")}</button>
                <button class="pk-icon-btn" data-add-floor="${s.id}" title="Shto kat" aria-label="Shto kat në ${esc(s.code)}">${I("plus")}</button>
                <button class="pk-icon-btn danger" data-del-sector="${s.id}" title="Fshi sektorin" aria-label="Fshi sektorin ${esc(s.code)}">${I("trash-2")}</button>
              </div>` : ""}
            </div>
            <div>
              ${s.is_demo ? `<span class="pk-tag">${I("flask-conical")} DEMO</span>` : `<span class="pk-tag solid"><span class="pk-dot pulse"></span> Sensorë live</span>`}
              ${s.is_active ? "" : `<span class="pk-tag off">${I("power")} Joaktiv</span>`}
            </div>
            <div class="pk-floors">
              ${s.floors.map((f) => {
                const pct = f.spot_count ? Math.round((f.occupied / f.spot_count) * 100) : 0;
                return `<div class="pk-floor">
                  <span class="f-code">${esc(f.code)}</span>
                  <div><div>${esc(f.name)} ${f.is_active ? "" : `<span class="pk-tag off">joaktiv</span>`}</div>
                    <div class="pk-meter" title="${pct}% e zënë"><i style="width:${pct}%"></i></div></div>
                  <span class="f-meta">${f.occupied}/${f.spot_count}
                    ${admin ? `<button class="pk-icon-btn" data-edit-floor="${f.id}" title="Ndrysho katin" aria-label="Ndrysho katin ${esc(f.code)}">${I("pencil")}</button>` : ""}</span>
                </div>`;
              }).join("")}
            </div>
          </div>`).join("") || `<div class="pk-empty">Asnjë sektor.</div>`}
      </div>

      ${selected ? `
      <div class="pk-card">
        <div class="pk-card-head ruled">
          <h3>${I("square-parking")} Vendet — ${esc(selected.name)}<small>${spotList.length} gjithsej</small></h3>
          ${admin ? `<button class="btn btn-sm btn-primary" id="pkAddSpot">${I("plus")} Vend i ri</button>` : ""}
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Çelësi</th><th>Kati</th><th>Rreshti</th><th>Nr.</th><th>Burimi</th><th>Sensori</th><th>Statusi</th><th></th></tr></thead>
          <tbody>${spotList.map((s) => `
            <tr class="${s.is_active ? "" : "off"}">
              <td class="mono"><b>${esc(s.spot_key)}</b></td>
              <td class="mono">${esc(s.floor_code || "—")}</td>
              <td>${esc(s.row_label || "—")}</td>
              <td>${s.number ?? "—"}</td>
              <td><span class="pk-tag ${s.source === "sensor" ? "solid" : ""}">${esc({ sensor: "sensor", demo: "DEMO", manual: "manual" }[s.source] || s.source)}</span></td>
              <td class="mono">${s.sensor_code ? `${I("radar")} ${esc(s.sensor_code)}` : "—"}</td>
              <td>${s.is_active ? statusChip(s.status) : `<span class="pk-tag off">joaktiv</span>`}</td>
              <td style="text-align:right">${admin ? `<span class="pk-row-actions">
                <button class="pk-icon-btn" data-edit-spot="${esc(s.spot_key)}" title="Ndrysho" aria-label="Ndrysho ${esc(s.spot_key)}">${I("pencil")}</button>
                <button class="pk-icon-btn" data-toggle-spot="${esc(s.spot_key)}" data-active="${s.is_active ? 1 : 0}" title="${s.is_active ? "Çaktivizo" : "Aktivizo"}" aria-label="${s.is_active ? "Çaktivizo" : "Aktivizo"} ${esc(s.spot_key)}">${I("power")}</button>
                ${s.has_sensor ? "" : `<button class="pk-icon-btn danger" data-del-spot="${esc(s.spot_key)}" title="Fshi" aria-label="Fshi ${esc(s.spot_key)}">${I("trash-2")}</button>`}
              </span>` : ""}</td>
            </tr>`).join("") || `<tr><td colspan="8" class="tbl-empty">Ky sektor s'ka vende ende.</td></tr>`}
          </tbody></table></div>
      </div>` : ""}
    </div>`;

    enhance(c);
    const reload = () => reloadSection("structure");
    const act = (fn, ok) => async () => {
      try { await fn(); if (ok) UI.toast(ok, "ok"); reload(); } catch (e) { UI.toast(e.message, "error"); }
    };
    const byId = (id) => sectors.find((s) => s.id === Number(id));
    const floorById = (id) => sectors.flatMap((s) => s.floors).find((f) => f.id === Number(id));

    c.querySelectorAll("[data-pick]").forEach((el) => {
      const pick = (e) => {
        if (e.target.closest("button")) return;
        state.sector = el.dataset.pick;
        reload();
      };
      el.onclick = pick;
      el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e); } };
    });

    if (!admin) return;

    UI.$("pkAddSector").onclick = () => formModal("Sektor i ri", "Kodi (A–Z) bëhet pjesë e çelësit të çdo vendi, p.sh. <b>D-P1</b>, dhe nuk ndryshohet më.",
      `<div class="pk-form-grid">${field("code", "Kodi", { attrs: 'maxlength="4" required pattern="[A-Za-z]{1,4}" placeholder="D"' })}
        ${field("name", "Emri", { attrs: 'maxlength="60" required placeholder="Sektori D"' })}</div>
        ${check("is_demo", "Sektor DEMO (pa sensorë, të dhëna të simuluara)", true)}`,
      async (fd) => {
        const s = await call("POST", "/api/admin/sectors", { code: fd.get("code"), name: fd.get("name"), is_demo: fd.has("is_demo") });
        state.sector = s.code;
        UI.toast(`Sektori ${s.code} u krijua (me katin F0)`, "ok");
        reload();
      });

    c.querySelectorAll("[data-edit-sector]").forEach((b) => (b.onclick = () => {
      const s = byId(b.dataset.editSector);
      formModal(`Sektori ${s.code}`, "", `
        ${field("name", "Emri", { value: s.name, attrs: 'maxlength="60" required' })}
        ${field("sort_order", "Renditja", { value: s.sort_order, type: "number", attrs: 'min="0" max="999"' })}
        ${check("is_demo", "Sektor DEMO", s.is_demo)}${check("is_active", "Aktiv", s.is_active)}`,
        async (fd) => {
          await call("PATCH", `/api/admin/sectors/${s.id}`, {
            name: fd.get("name"), sort_order: intOrUndef(fd.get("sort_order")),
            is_demo: fd.has("is_demo"), is_active: fd.has("is_active"),
          });
          UI.toast("Sektori u përditësua", "ok");
          reload();
        });
    }));

    c.querySelectorAll("[data-del-sector]").forEach((b) => (b.onclick = () => {
      const s = byId(b.dataset.delSector);
      if (!confirm(`Ta fshij sektorin ${s.code}? Lejohet vetëm kur s'ka asnjë vend.`)) return;
      act(() => call("DELETE", `/api/admin/sectors/${s.id}`), `Sektori ${s.code} u fshi`)();
    }));

    c.querySelectorAll("[data-add-floor]").forEach((b) => (b.onclick = () => {
      const s = byId(b.dataset.addFloor);
      formModal(`Kat i ri — ${s.name}`, "", `<div class="pk-form-grid">
        ${field("code", "Kodi", { attrs: 'maxlength="8" required placeholder="F1"' })}
        ${field("level", "Niveli", { type: "number", value: 1, attrs: 'min="-10" max="50"', hint: "Negativ = nëntokë (p.sh. -1)" })}</div>
        ${field("name", "Emri", { attrs: 'maxlength="60" required placeholder="Kati 1"' })}`,
        async (fd) => {
          await call("POST", "/api/admin/floors", { sector_id: s.id, code: fd.get("code"), name: fd.get("name"), level: intOrUndef(fd.get("level")) });
          UI.toast("Kati u shtua", "ok");
          reload();
        });
    }));

    c.querySelectorAll("[data-edit-floor]").forEach((b) => (b.onclick = () => {
      const f = floorById(b.dataset.editFloor);
      formModal(`Kati ${f.code}`, "Kati fshihet vetëm kur s'ka vende.", `<div class="pk-form-grid">
        ${field("code", "Kodi", { value: f.code, attrs: 'maxlength="8" required' })}
        ${field("level", "Niveli", { type: "number", value: f.level, attrs: 'min="-10" max="50"' })}</div>
        ${field("name", "Emri", { value: f.name, attrs: 'maxlength="60" required' })}
        ${check("is_active", "Aktiv", f.is_active)}
        <button type="button" class="btn btn-sm btn-ghost" id="pkDelFloor">${I("trash-2")} Fshi katin</button>`,
        async (fd) => {
          await call("PATCH", `/api/admin/floors/${f.id}`, { code: fd.get("code"), name: fd.get("name"), level: intOrUndef(fd.get("level")), is_active: fd.has("is_active") });
          UI.toast("Kati u përditësua", "ok");
          reload();
        });
      UI.$("pkDelFloor").onclick = async () => {
        if (!confirm(`Ta fshij katin ${f.code}?`)) return;
        try { await call("DELETE", `/api/admin/floors/${f.id}`); UI.closeModal(); UI.toast("Kati u fshi", "ok"); reload(); }
        catch (e) { UI.$("pkFormAlert").innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
      };
    }));

    const addSpot = UI.$("pkAddSpot");
    if (addSpot) addSpot.onclick = () => formModal(`Vend i ri — ${selected.name}`,
      `Çelësi do të jetë <b class="mono">${esc(selected.code)}-&lt;etiketa&gt;</b>, me kod QR të gatshëm.`,
      `<div class="field"><label for="pk_floor">Kati</label><select id="pk_floor" name="floor_id">
          ${selected.floors.map((f) => `<option value="${f.id}">${esc(f.code)} — ${esc(f.name)}</option>`).join("")}</select></div>
       <div class="pk-form-grid">
        ${field("label", "Etiketa", { attrs: 'maxlength="8" required placeholder="P13"' })}
        ${field("row_label", "Rreshti", { attrs: 'maxlength="8" placeholder="R1"' })}</div>
        ${field("number", "Numri", { type: "number", attrs: 'min="1" max="9999"', hint: "Bosh = merret nga etiketa (P13 → 13)" })}`,
      async (fd) => {
        const s = await call("POST", "/api/admin/spots", {
          floor_id: Number(fd.get("floor_id")), label: fd.get("label"),
          row_label: fd.get("row_label") || undefined, number: intOrUndef(fd.get("number")),
        });
        UI.toast(`Vendi ${s.spot_key} u krijua`, "ok");
        reload();
      });

    c.querySelectorAll("[data-edit-spot]").forEach((b) => (b.onclick = () => {
      const s = spotList.find((x) => x.spot_key === b.dataset.editSpot);
      formModal(`Vendi ${s.spot_key}`, "Çelësi është i printuar në QR dhe nuk ndryshohet.", `
        <div class="field"><label for="pk_floor">Kati</label><select id="pk_floor" name="floor_id">
          ${selected.floors.map((f) => `<option value="${f.id}" ${f.id === s.floor_id ? "selected" : ""}>${esc(f.code)} — ${esc(f.name)}</option>`).join("")}</select></div>
        <div class="pk-form-grid">
          ${field("row_label", "Rreshti", { value: s.row_label || "", attrs: 'maxlength="8"' })}
          ${field("number", "Numri", { type: "number", value: s.number ?? "", attrs: 'min="1" max="9999"' })}</div>`,
        async (fd) => {
          await call("PATCH", `/api/admin/spots/${encodeURIComponent(s.spot_key)}`, {
            floor_id: Number(fd.get("floor_id")), row_label: fd.get("row_label") || null, number: intOrUndef(fd.get("number")),
          });
          UI.toast("Vendi u përditësua", "ok");
          reload();
        });
    }));

    c.querySelectorAll("[data-toggle-spot]").forEach((b) => (b.onclick = act(
      () => call("PATCH", `/api/admin/spots/${encodeURIComponent(b.dataset.toggleSpot)}`, { is_active: b.dataset.active !== "1" }),
      b.dataset.active === "1" ? "Vendi u çaktivizua" : "Vendi u aktivizua")));

    c.querySelectorAll("[data-del-spot]").forEach((b) => (b.onclick = () => {
      if (!confirm(`Ta fshij vendin ${b.dataset.delSpot}? Vendet me histori mund vetëm të çaktivizohen.`)) return;
      act(() => call("DELETE", `/api/admin/spots/${encodeURIComponent(b.dataset.delSpot)}`), "Vendi u fshi")();
    }));
  }

  /* =====================================================================
     PARAMETRAT
     ===================================================================== */
  const PARAM_GROUPS = [
    { icon: "ruler", title: "Klasifikimi i distancës", keys: ["occ_threshold_cm", "max_range_cm"],
      hints: { occ_threshold_cm: "Distanca ≤ prag → vendi i zënë.", max_range_cm: "Mbi këtë distancë leximi trajtohet si i panjohur." } },
    { icon: "activity", title: "Ruajtja e leximeve", keys: ["tolerance_cm", "sample_interval_s", "sensor_timeout_s"],
      hints: {
        tolerance_cm: "Lëvizjet më të vogla se kjo nuk ruhen si ndryshim (zhurma e sensorit).",
        sample_interval_s: "Edhe pa ndryshim, ruhet një mostër kaq shpesh.",
        sensor_timeout_s: "Pa matje kaq sekonda → sensori shfaqet offline.",
      } },
    { icon: "history", title: "Politika e ruajtjes", keys: ["retention_sample_days", "retention_change_days"],
      hints: { retention_sample_days: "Mostrat periodike fshihen pas kaq ditësh.", retention_change_days: "Ndryshimet dhe ngjarjet e statusit fshihen pas kaq ditësh." } },
  ];
  const UNITS = { occ_threshold_cm: "cm", max_range_cm: "cm", tolerance_cm: "cm", sample_interval_s: "s", sensor_timeout_s: "s", retention_sample_days: "ditë", retention_change_days: "ditë" };

  async function params(c) {
    const s = await call("GET", "/api/admin/settings");
    const admin = isAdmin();
    const lastChange = Object.values(s.meta).filter((m) => m.updated_at && m.updated_by).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

    c.innerHTML = `<div class="pk">
      ${head("sliders-horizontal", "Parametrat e sistemit", "Pragjet dhe politika e të dhënave",
        "Ndryshimet zbatohen menjëherë nga serveri — pa rinisje dhe pa ndryshuar firmware-in. Çdo ndryshim regjistrohet në Audit Log.",
        admin ? `<button class="btn" id="pkReset" disabled>${I("refresh-cw")} Rikthe</button>
                 <button class="btn btn-primary" id="pkSave" disabled>${I("save")} Ruaj ndryshimet</button>`
              : `<span class="pk-tag">${I("shield-check")} Vetëm lexim (operator)</span>`)}
      <div class="pk-params">
        <div class="pk-card pk-pad" id="pkParamsCard">
          <div id="pkParamsAlert"></div>
          ${PARAM_GROUPS.map((g) => `<div class="pk-group"><h4>${I(g.icon)} ${esc(g.title)}</h4>
            ${g.keys.map((k) => `<div class="pk-field" data-key="${k}">
              <label for="pk_${k}">${esc(s.meta[k].label)}</label>
              <div class="pk-input"><input id="pk_${k}" type="number" inputmode="decimal" value="${s.values[k]}"
                min="${s.meta[k].min}" max="${s.meta[k].max}" step="${s.meta[k].integer ? 1 : 0.1}" ${admin ? "" : "disabled"}>
                <span>${UNITS[k]}</span></div>
              <div class="hint">${esc(g.hints[k])} Kufijtë: ${s.meta[k].min}–${s.meta[k].max}.</div></div>`).join("")}
          </div>`).join("")}
        </div>
        <div class="pk-side">
          <div class="pk-card pk-pad">
            <h3 style="display:flex;align-items:center;gap:8px">${I("gauge")} Si klasifikohet një matje</h3>
            <div class="pk-scale"><div class="pk-scale-bar" id="pkScale"></div><div class="pk-scale-axis" id="pkAxis"></div></div>
            <p class="muted small" style="margin-top:12px">Sensori HC-SR04 mat distancën deri te vetura (shkallë e maketës).
              Matjet pa echo (<span class="mono">cm: -1</span>) janë gjithmonë <b>të panjohura</b>.</p>
          </div>
          <div class="pk-card pk-pad">
            <h3 style="display:flex;align-items:center;gap:8px">${I("database-backup")} Vlerësimi i hapësirës</h3>
            <div class="list-rows" id="pkEstimate"></div>
            <p class="muted small" style="margin-top:10px">${lastChange
              ? `Ndryshimi i fundit: <b>${UI.fmtDt(lastChange.updated_at)}</b> nga <b>${esc(lastChange.updated_by || "—")}</b>.`
              : "Vlerat vijnë nga konfigurimi i serverit (.env) — ende pa ndryshime nga paneli."}</p>
          </div>
        </div>
      </div></div>`;

    enhance(c);
    const inputs = Object.fromEntries(Object.keys(s.values).map((k) => [k, UI.$(`pk_${k}`)]));
    if (state.draft && admin) for (const [k, el] of Object.entries(inputs)) if (k in state.draft) el.value = state.draft[k];
    const read = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value === "" ? NaN : Number(el.value)]));

    function render() {
      const v = read();
      const occ = Math.max(0, v.occ_threshold_cm || 0);
      const max = Math.max(occ, v.max_range_cm || 0);
      const span = Math.max(max * 1.3, 1);
      UI.$("pkScale").innerHTML = `
        <div class="s-occ" style="flex-basis:${(occ / span) * 100}%">E zënë</div>
        <div class="s-free" style="flex-basis:${((max - occ) / span) * 100}%">E lirë</div>
        <div class="s-unk" style="flex:1">?</div>`;
      UI.$("pkAxis").innerHTML = `<span>0</span><span>≤ ${nf.format(occ)} cm</span><span>≤ ${nf.format(max)} cm</span><span>${nf.format(span)}</span>`;
      // 6 sensorë; në rastin më të keq një ndryshim për matje (2/s) — realisht shumë më pak.
      const perDaySamples = 6 * (86400 / Math.max(10, v.sample_interval_s || 300));
      const rows = perDaySamples * (v.retention_sample_days || 0);
      UI.$("pkEstimate").innerHTML = `
        <div class="row-item"><span>Mostra në ditë (6 sensorë)</span><b>${nf.format(Math.round(perDaySamples))}</b></div>
        <div class="row-item"><span>Mostra të ruajtura maksimalisht</span><b>${nf.format(Math.round(rows))}</b></div>
        <div class="row-item"><span>Madhësia e përafërt</span><b>~${nf.format((rows * 60) / 1048576)} MB</b></div>`;

      let dirty = false;
      let valid = true;
      for (const [k, el] of Object.entries(inputs)) {
        const m = s.meta[k];
        const val = v[k];
        const bad = !Number.isFinite(val) || val < m.min || val > m.max || (m.integer && !Number.isInteger(val));
        const changed = val !== s.values[k];
        el.closest(".pk-field").classList.toggle("dirty", changed && !bad);
        el.closest(".pk-field").classList.toggle("invalid", bad);
        dirty = dirty || changed;
        valid = valid && !bad;
      }
      const cross = [];
      if (v.occ_threshold_cm >= v.max_range_cm) cross.push("Pragu i zënies duhet të jetë më i vogël se rrezja maksimale.");
      if (v.retention_change_days < v.retention_sample_days) cross.push("Ndryshimet duhet të ruhen të paktën sa mostrat.");
      UI.$("pkParamsAlert").innerHTML = cross.map((m) => `<div class="pk-note err">${esc(m)}</div>`).join("");
      if (admin) {
        UI.$("pkSave").disabled = !dirty || !valid || cross.length > 0;
        UI.$("pkReset").disabled = !dirty;
      }
    }
    Object.values(inputs).forEach((el) => (el.oninput = () => {
      state.draft = Object.fromEntries(Object.entries(inputs).map(([k, x]) => [k, x.value]));
      render();
    }));
    render();
    if (!admin) return;

    UI.$("pkReset").onclick = () => { state.draft = null; for (const [k, el] of Object.entries(inputs)) el.value = s.values[k]; render(); };
    UI.$("pkSave").onclick = async () => {
      const v = read();
      const patch = Object.fromEntries(Object.keys(v).filter((k) => v[k] !== s.values[k]).map((k) => [k, v[k]]));
      UI.$("pkSave").disabled = true;
      try {
        await call("PUT", "/api/admin/settings", patch);
        UI.toast(`${Object.keys(patch).length} parametra u ruajtën`, "ok");
        state.draft = null;
        reloadSection("params");
      } catch (e) {
        UI.$("pkParamsAlert").innerHTML = `<div class="pk-note err">${esc(e.message)}</div>`;
        render();
      }
    };
  }

  /* =====================================================================
     RAPORTET & TË DHËNAT
     ===================================================================== */
  const RANGES = [[1, "24 orë"], [7, "7 ditë"], [30, "30 ditë"], [90, "90 ditë"]];
  const REPORT_ICONS = { sessions: "clock", readings: "radar", "status-events": "activity", entrance: "log-in", reservations: "calendar-range" };

  async function reports(c) {
    const days = state.days;
    const sector = state.rSector;
    const to = Math.floor(Date.now() / 60000) * 60000; // e rrumbullakosur në minutë → cache i qëndrueshëm
    const qs = new URLSearchParams({ from: String(to - days * DAY), to: String(to) });
    if (sector) qs.set("sector", sector);
    const admin = isAdmin();

    const [sum, sectors, types] = await Promise.all([
      cached(`sum|${days}|${sector}`, () => call("GET", `/api/stats/summary?${qs}`)),
      cached("sectors", () => call("GET", "/api/sectors"), 60000),
      cached("report-types", () => call("GET", "/api/admin/reports"), 600000),
    ]);
    const occ = sum.occupancy;
    const maxHour = Math.max(1, ...occ.by_hour_of_day.map((h) => h.avg_pct || 0));
    const isDemo = sector && (sectors.data.find((s) => s.code === sector) || {}).is_demo;

    c.innerHTML = `<div class="pk">
      ${head("chart-column", "Raportet & të dhënat", "Statistikat e parkingut",
        `Zënia, kohëzgjatja, hyrjet dhe gjendja e sensorëve — nga databaza, sipas orës lokale (${esc(sum.range.timezone)}).`,
        `<div class="pk-seg" role="group" aria-label="Periudha">${RANGES.map(([d, l]) => `<button data-days="${d}" class="${d === days ? "on" : ""}">${l}</button>`).join("")}</div>
         <select class="pk-select" id="pkSectorSel" aria-label="Sektori">
           <option value="">Të gjithë sektorët</option>
           ${sectors.data.map((s) => `<option value="${esc(s.code)}" ${s.code === sector ? "selected" : ""}>${esc(s.name)}${s.is_demo ? " (DEMO)" : ""}</option>`).join("")}
         </select>`)}

      ${isDemo ? `<div class="pk-note">${I("flask-conical")} Ky sektor ka të dhëna DEMO (të simuluara me <span class="mono">npm run seed:demo</span>).</div>` : ""}

      <div class="pk-kpis">
        ${kpi("gauge", "Zënia mesatare", occ.avg_pct, { dec: 1, unit: "%", sub: `${sum.spots} vende aktive`, spark: occ.daily.map((d) => d.avg_pct) })}
        ${kpi("timer", "Ora e pikut", occ.peak_hour ? occ.peak_hour.hour : null, { unit: ":00",
          sub: occ.peak_hour ? `mesatarisht ${nf.format(occ.peak_hour.avg_pct)}% e zënë` : "ende pa të dhëna" })}
        ${kpi("clock", "Qëndrimi mesatar", sum.sessions.avg_minutes, { dec: 0, unit: "min",
          spark: Object.values(sum.sessions.by_day), sub: sum.sessions.median_minutes != null ? `mediana ${nf.format(sum.sessions.median_minutes)} min · ${sum.sessions.count} qëndrime` : `${sum.sessions.count} qëndrime` })}
        ${kpi("log-in", "Hyrje", sum.entrance.entries, { sub: `${sum.entrance.exits} dalje · sensori S7`, spark: sum.entrance.by_day.map((d) => d.entries) })}
        ${kpi("triangle-alert", "Gabime sensorësh", sum.sensors.total_errors, {
          sub: `${sum.sensors.online}/${sum.sensors.sensors.length} online tani` })}
      </div>

      <div class="pk-card pk-mb">
        <div class="pk-card-head"><h3>${I("chart-column")} Zënia mesatare sipas orës së ditës</h3>
          <small>${occ.peak_hour ? `Piku: <b>${String(occ.peak_hour.hour).padStart(2, "0")}:00</b>` : ""}</small></div>
        <div class="pk-pad">
          <div class="pk-chart-wrap"><div class="pk-yaxis" aria-hidden="true">${[4, 3, 2, 1, 0].map((q) => `<span>${Math.round((maxHour * q) / 4)}%</span>`).join("")}</div>
          <div class="pk-chart" role="img" aria-label="Zënia mesatare për çdo orë të ditës">
            ${occ.by_hour_of_day.map((h, i) => {
              const v = h.avg_pct || 0;
              const cls = !v ? "empty" : occ.peak_hour && h.hour === occ.peak_hour.hour ? "peak" : "";
              return `<div class="pk-bar ${cls}"><i style="height:${Math.max(1, (v / maxHour) * 100)}%;animation-delay:${i * 18}ms"></i>
                <span class="tip">${String(h.hour).padStart(2, "0")}:00 · ${h.avg_pct == null ? "—" : nf.format(v) + "%"}</span></div>`;
            }).join("")}
          </div></div>
          <div class="pk-chart-axis">${occ.by_hour_of_day.map((h) => `<span>${h.hour}</span>`).join("")}</div>
        </div>
      </div>

      <div class="pk-grid-2 pk-mb">
        <div class="pk-card">
          <div class="pk-card-head ruled"><h3>${I("radar")} Sensorët</h3><small>gabime në periudhë</small></div>
          <div class="pk-list">${sum.sensors.sensors.map((s) => `
            <div class="pk-list-item">
              <span class="li-ico">${I(s.online ? "wifi" : "wifi-off")}</span>
              <div class="li-main"><b class="mono">${esc(s.code)}</b> ${s.spot_key ? `· <span class="mono">${esc(s.spot_key)}</span>` : "· hyrja"}
                <small>TRIG ${esc(s.pins.trig)} · ECHO ${esc(s.pins.echo)} · ${s.last_seen_at ? "parë " + UI.fmtDt(s.last_seen_at) : "ende pa matje"}</small></div>
              ${s.read_errors + s.dropouts ? `<span class="pk-tag err" title="${s.read_errors} pa echo · ${s.dropouts} rënie në 'unknown'">${s.read_errors + s.dropouts} gabime</span>` : ""}
              <span class="pk-tag ${s.online ? "solid" : "off"}"><span class="pk-dot ${s.online ? "pulse" : "hollow"}"></span>${s.online ? "online" : "offline"}</span>
            </div>`).join("")}</div>
        </div>

        <div class="pk-card">
          <div class="pk-card-head ruled"><h3>${I("file-spreadsheet")} Eksporto CSV</h3><small>${RANGES.find(([d]) => d === days)[1]} · ${sector ? "Sektori " + esc(sector) : "të gjithë"}</small></div>
          <div class="pk-list">${types.data.map((t) => `
            <div class="pk-list-item">
              <span class="li-ico">${I(REPORT_ICONS[t.type] || "file-spreadsheet")}</span>
              <div class="li-main"><b>${esc(t.title)}</b><small class="mono">${esc(t.columns.join(", "))}</small></div>
              <button class="btn btn-sm" data-csv="${esc(t.type)}" aria-label="Shkarko ${esc(t.title)}">${I("download")} CSV</button>
            </div>`).join("")}</div>
          <div class="pk-foot"><span>Rezervimet: <b>${sum.reservations.fulfilled}</b> të realizuara · <b>${sum.reservations.expired}</b> të skaduara · <b>${sum.reservations.cancelled}</b> të anuluara</span>
          </div>
        </div>
      </div>

      <div class="pk-grid-2">
        <div class="pk-card" id="pkIntegrity">
          <div class="pk-card-head ruled"><h3>${I("shield-check")} Integriteti i databazës</h3>
            <button class="btn btn-sm" id="pkRunCheck">${I("refresh-cw")} Kontrollo</button></div>
          <div id="pkChecks"><div class="pk-empty">Kontrollet e strukturës, çelësave të huaj dhe të qëndrimeve. Shtyp “Kontrollo”.</div></div>
        </div>
        <div class="pk-card">
          <div class="pk-card-head ruled"><h3>${I("hard-drive-download")} Backup & pastrimi</h3>${admin ? "" : `<small>vetëm admin</small>`}</div>
          <div class="pk-list">
            <div class="pk-list-item"><span class="li-ico">${I("database-backup")}</span>
              <div class="li-main"><b>Shkarko backup</b><small>Kopje e plotë SQLite (online, e verifikuar). Rikthimi: <span class="mono">npm run db:restore</span></small></div>
              <button class="btn btn-sm btn-primary" id="pkBackup" ${admin ? "" : "disabled"}>${I("download")} .db</button></div>
            <div class="pk-list-item"><span class="li-ico">${I("eraser")}</span>
              <div class="li-main"><b>Pastro sipas politikës</b><small id="pkPurgeInfo">Fshin leximet më të vjetra se afati i ruajtjes (Parametrat).</small></div>
              <button class="btn btn-sm" id="pkPurge" ${admin ? "" : "disabled"}>${I("eraser")} Provë</button></div>
          </div>
        </div>
      </div>
    </div>`;

    enhance(c);
    const reload = () => reloadSection("reports");
    c.querySelectorAll("[data-days]").forEach((b) => (b.onclick = () => { state.days = Number(b.dataset.days); reload(); }));
    UI.$("pkSectorSel").onchange = (e) => { state.rSector = e.target.value; reload(); };
    if (state.checks) UI.$("pkChecks").innerHTML = state.checks;
    if (state.purge) UI.$("pkPurgeInfo").innerHTML = state.purge;

    c.querySelectorAll("[data-csv]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await download(`/api/admin/reports/${b.dataset.csv}.csv?${qs}`);
        UI.toast(`${r.name} · ${r.rows} rreshta`, "ok");
      } catch (e) { UI.toast(e.message, "error"); }
      b.disabled = false;
    }));

    UI.$("pkRunCheck").onclick = async () => {
      UI.$("pkChecks").innerHTML = `<div class="pk-pad"><div class="pk-skel"></div><div class="pk-skel" style="margin-top:10px;width:70%"></div></div>`;
      try {
        const r = await call("GET", "/api/admin/maintenance/integrity");
        state.checks = `<div class="pk-list">
          <div class="pk-list-item"><span class="li-ico ${r.ok ? "pk-check-ok" : "pk-check-bad"}">${I(r.ok ? "circle-check" : "triangle-alert")}</span>
            <div class="li-main"><b>${r.ok ? "Gjithçka në rregull" : "U gjetën probleme"}</b>
            <small>${r.checks.length} kontrolle · migrimet: ${r.migrations.map((m) => esc(m.name.slice(0, 3))).join(", ")}</small></div></div>
          ${r.checks.map((ch) => `<div class="pk-list-item">
            <span class="${ch.ok ? "pk-check-ok" : "pk-check-bad"}">${I(ch.ok ? "circle-check" : "circle-x")}</span>
            <div class="li-main">${esc(ch.name)}${ch.ok ? "" : `<small class="mono">${esc(JSON.stringify(ch.sample))}</small>`}</div>
            ${ch.ok ? "" : `<span class="pk-tag err">${ch.count}</span>`}</div>`).join("")}</div>`;
      } catch (e) {
        state.checks = `<div class="alert error">${esc(e.message)}</div>`;
      }
      const box = UI.$("pkChecks"); // elementi i ri nëse pamja u rindërtua ndërkohë
      if (box) box.innerHTML = state.checks;
    };

    if (!admin) return;
    UI.$("pkBackup").onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { const r = await download("/api/admin/backup"); UI.toast(`Backup u shkarkua: ${r.name}`, "ok"); }
      catch (err) { UI.toast(err.message, "error"); }
      b.disabled = false;
    };

    // Pastrimi në dy hapa: "Provë" numëron, pastaj butoni bëhet "Fshi N" për konfirmim.
    const purgeBtn = () => UI.$("pkPurge");
    const paintPurge = () => {
      const b = purgeBtn();
      if (!b) return;
      b.innerHTML = state.purgeArmed ? `${I("trash-2")} Fshi ${state.purgeArmed}` : `${I("eraser")} Provë`;
      b.classList.toggle("btn-primary", !!state.purgeArmed);
    };
    paintPurge();
    purgeBtn().onclick = async () => {
      purgeBtn().disabled = true;
      try {
        const r = await call("POST", "/api/admin/maintenance/purge", state.purgeArmed ? { confirm: true } : {});
        const total = r.result.reduce((a, x) => a + x.deleted, 0);
        state.purge = r.result.map((x) => `${esc(x.name)}: <b>${x.deleted}</b>`).join(" · ");
        state.purgeArmed = r.dry_run && total > 0 ? total : 0;
        if (!state.purgeArmed) UI.toast(r.dry_run ? "S'ka asgjë për të pastruar" : `U fshinë ${total} rreshta`, "ok");
        if (!r.dry_run) state.cache.clear();
      } catch (err) { UI.toast(err.message, "error"); }
      const info = UI.$("pkPurgeInfo");
      if (info && state.purge) info.innerHTML = state.purge;
      paintPurge();
      if (purgeBtn()) purgeBtn().disabled = false;
    };
  }

  /* ---------- Regjistrimi në panel ---------- */
  Object.assign(Admin.sections, { structure, params, reports });
  const after = Admin.NAV.findIndex((n) => n.id === "gate");
  Admin.NAV.splice(after + 1, 0,
    { sep: true },
    { id: "structure", icon: I("building-2"), label: "Struktura" },
    { id: "params", icon: I("sliders-horizontal"), label: "Parametrat" },
    { id: "reports", icon: I("chart-column"), label: "Raportet & të dhënat" });
})();
