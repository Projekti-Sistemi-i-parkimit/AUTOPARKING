"use strict";

const { HttpError } = require("../middleware/errors");

// Menaxhimi i strukturës (D5): sektorët → katet → vendet.
// Rregullat:
//  - spot_key = "<sektor>-<etiketë>" (formati i ekipit, i printuar në QR) dhe nuk ndryshon.
//  - Fshirja lejohet vetëm kur s'ka histori; përndryshe kthen 409 dhe sugjeron çaktivizim,
//    që statistikat dhe raportet e vjetra të mbeten të sakta.
//  - Sektori me sensorë live (is_demo = 0) nuk mund të shënohet DEMO e kundërta.

const CODE_RE = /^[A-Z]{1,4}$/;
const FLOOR_RE = /^[A-Z0-9]{1,8}$/;
const LABEL_RE = /^[A-Z0-9]{1,8}$/;

function str(v, field, { max = 60, re, upper = false, optional = false } = {}) {
  if (v == null && optional) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `Fusha "${field}" është e detyrueshme`);
  let s = v.trim();
  if (upper) s = s.toUpperCase();
  if (s.length > max) throw new HttpError(400, `Fusha "${field}" është shumë e gjatë (max ${max})`);
  if (re && !re.test(s)) throw new HttpError(400, `Fusha "${field}" ka format të pavlefshëm`);
  return s;
}

function int(v, field, { min, max, optional = false } = {}) {
  if (v == null && optional) return undefined;
  if (!Number.isInteger(v)) throw new HttpError(400, `Fusha "${field}" duhet të jetë numër i plotë`);
  if (v < min || v > max) throw new HttpError(400, `Fusha "${field}" duhet të jetë ndërmjet ${min} dhe ${max}`);
  return v;
}

function bool(v, field, { optional = true } = {}) {
  if (v == null && optional) return undefined;
  if (typeof v !== "boolean") throw new HttpError(400, `Fusha "${field}" duhet të jetë true/false`);
  return v ? 1 : 0;
}

function body(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Trupi i kërkesës duhet të jetë objekt");
  return b;
}

// Gabimet e SQLite (UNIQUE, trigger-at) kthehen në përgjigje të kuptueshme.
function sqlError(e, uniqueMsg) {
  if (e && e.code === "SQLITE_CONSTRAINT_UNIQUE") throw new HttpError(409, uniqueMsg);
  if (e && e.code === "SQLITE_CONSTRAINT_TRIGGER") throw new HttpError(409, e.message);
  if (e && e.code === "SQLITE_CONSTRAINT_CHECK") throw new HttpError(400, "Vlerë e pavlefshme");
  throw e;
}

function createStructureService(db) {
  const q = {
    sector: db.prepare("SELECT * FROM sectors WHERE id = ?"),
    floor: db.prepare(
      "SELECT f.*, s.code AS sector_code, s.is_demo FROM floors f JOIN sectors s ON s.id = f.sector_id WHERE f.id = ?"
    ),
    spot: db.prepare("SELECT * FROM spots WHERE spot_key = ?"),
  };

  function tree() {
    const sectors = db
      .prepare(
        `SELECT sec.*,
                (SELECT COUNT(*) FROM spots s WHERE s.sector = sec.code) AS spot_count,
                (SELECT COUNT(*) FROM spots s WHERE s.sector = sec.code AND s.has_sensor = 1) AS sensor_count
         FROM sectors sec ORDER BY sec.sort_order, sec.code`
      )
      .all();
    const floors = db
      .prepare(
        `SELECT f.*,
                (SELECT COUNT(*) FROM spots s WHERE s.floor_id = f.id) AS spot_count,
                (SELECT COUNT(*) FROM spots s JOIN spot_status st ON st.spot_id = s.id
                 WHERE s.floor_id = f.id AND st.status = 'occupied') AS occupied
         FROM floors f ORDER BY f.sort_order, f.level, f.code`
      )
      .all();
    return sectors.map((s) => ({
      ...s,
      is_demo: !!s.is_demo,
      is_active: !!s.is_active,
      floors: floors.filter((f) => f.sector_id === s.id).map((f) => ({ ...f, is_active: !!f.is_active })),
    }));
  }

  // ---------- Sektorët ----------
  function createSector(input) {
    const b = body(input);
    const code = str(b.code, "code", { max: 4, re: CODE_RE, upper: true });
    const name = str(b.name, "name");
    const isDemo = bool(b.is_demo, "is_demo") ?? 1;
    const sort = int(b.sort_order, "sort_order", { min: 0, max: 999, optional: true });
    return db.transaction(() => {
      let id;
      try {
        id = db
          .prepare("INSERT INTO sectors (code, name, is_demo, sort_order) VALUES (?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sectors)))")
          .run(code, name, isDemo, sort ?? null).lastInsertRowid;
      } catch (e) {
        sqlError(e, `Sektori ${code} ekziston`);
      }
      // Çdo sektor ka të paktën një kat, që vendet të kenë ku të shtohen.
      db.prepare("INSERT INTO floors (sector_id, code, name, level) VALUES (?, 'F0', 'Përdhesa', 0)").run(id);
      return q.sector.get(id);
    })();
  }

  function updateSector(id, input) {
    const b = body(input);
    const cur = q.sector.get(id);
    if (!cur) throw new HttpError(404, "Sektori nuk u gjet");
    if (b.code !== undefined) throw new HttpError(400, "Kodi i sektorit nuk ndryshohet (është pjesë e çelësave të vendeve)");
    const name = str(b.name, "name", { optional: true });
    const isDemo = bool(b.is_demo, "is_demo");
    const isActive = bool(b.is_active, "is_active");
    const sort = int(b.sort_order, "sort_order", { min: 0, max: 999, optional: true });
    if (isDemo === 1 && cur.is_demo === 0) {
      const live = db.prepare("SELECT COUNT(*) AS n FROM spots WHERE sector = ? AND has_sensor = 1").get(cur.code).n;
      if (live) throw new HttpError(409, "Sektori ka sensorë live dhe nuk mund të shënohet DEMO");
    }
    db.prepare(
      `UPDATE sectors SET name = COALESCE(?, name), is_demo = COALESCE(?, is_demo),
              is_active = COALESCE(?, is_active), sort_order = COALESCE(?, sort_order) WHERE id = ?`
    ).run(name ?? null, isDemo ?? null, isActive ?? null, sort ?? null, id);
    return { before: cur, after: q.sector.get(id) };
  }

  function deleteSector(id) {
    const cur = q.sector.get(id);
    if (!cur) throw new HttpError(404, "Sektori nuk u gjet");
    const n = db.prepare("SELECT COUNT(*) AS n FROM spots WHERE sector = ?").get(cur.code).n;
    if (n) throw new HttpError(409, `Sektori ka ${n} vende — fshiji ato ose çaktivizo sektorin`);
    db.transaction(() => {
      db.prepare("DELETE FROM floors WHERE sector_id = ?").run(id);
      db.prepare("DELETE FROM sectors WHERE id = ?").run(id);
    })();
    return cur;
  }

  // ---------- Katet ----------
  function createFloor(input) {
    const b = body(input);
    const sectorId = int(b.sector_id, "sector_id", { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (!q.sector.get(sectorId)) throw new HttpError(404, "Sektori nuk u gjet");
    const code = str(b.code, "code", { max: 8, re: FLOOR_RE, upper: true });
    const name = str(b.name, "name");
    const level = int(b.level, "level", { min: -10, max: 50, optional: true }) ?? 0;
    const sort = int(b.sort_order, "sort_order", { min: 0, max: 999, optional: true }) ?? 0;
    try {
      const id = db
        .prepare("INSERT INTO floors (sector_id, code, name, level, sort_order) VALUES (?, ?, ?, ?, ?)")
        .run(sectorId, code, name, level, sort).lastInsertRowid;
      return q.floor.get(id);
    } catch (e) {
      return sqlError(e, `Kati ${code} ekziston në këtë sektor`);
    }
  }

  function updateFloor(id, input) {
    const b = body(input);
    const cur = q.floor.get(id);
    if (!cur) throw new HttpError(404, "Kati nuk u gjet");
    if (b.sector_id !== undefined) throw new HttpError(400, "Kati nuk zhvendoset në sektor tjetër");
    const code = str(b.code, "code", { max: 8, re: FLOOR_RE, upper: true, optional: true });
    const name = str(b.name, "name", { optional: true });
    const level = int(b.level, "level", { min: -10, max: 50, optional: true });
    const sort = int(b.sort_order, "sort_order", { min: 0, max: 999, optional: true });
    const isActive = bool(b.is_active, "is_active");
    try {
      db.prepare(
        `UPDATE floors SET code = COALESCE(?, code), name = COALESCE(?, name), level = COALESCE(?, level),
                sort_order = COALESCE(?, sort_order), is_active = COALESCE(?, is_active) WHERE id = ?`
      ).run(code ?? null, name ?? null, level ?? null, sort ?? null, isActive ?? null, id);
    } catch (e) {
      sqlError(e, `Kati ${code} ekziston në këtë sektor`);
    }
    return { before: cur, after: q.floor.get(id) };
  }

  function deleteFloor(id) {
    const cur = q.floor.get(id);
    if (!cur) throw new HttpError(404, "Kati nuk u gjet");
    const n = db.prepare("SELECT COUNT(*) AS n FROM spots WHERE floor_id = ?").get(id).n;
    if (n) throw new HttpError(409, `Kati ka ${n} vende — fshiji ose zhvendosi ato më parë`);
    const left = db.prepare("SELECT COUNT(*) AS n FROM floors WHERE sector_id = ?").get(cur.sector_id).n;
    if (left <= 1) throw new HttpError(409, "Sektori duhet të ketë të paktën një kat");
    db.prepare("DELETE FROM floors WHERE id = ?").run(id);
    return cur;
  }

  // ---------- Vendet ----------
  function listSpots({ sector, floor_id } = {}) {
    const where = [];
    const params = [];
    if (sector) { where.push("s.sector = ?"); params.push(String(sector).toUpperCase()); }
    if (floor_id) { where.push("s.floor_id = ?"); params.push(Number(floor_id)); }
    return db
      .prepare(
        `SELECT s.id, s.spot_key, s.sector, s.label, s.floor_id, f.code AS floor_code, s.row_label, s.number,
                s.has_sensor, s.source, s.is_active, st.status, se.code AS sensor_code
         FROM spots s
         LEFT JOIN floors f ON f.id = s.floor_id
         LEFT JOIN spot_status st ON st.spot_id = s.id
         LEFT JOIN sensors se ON se.spot_id = s.id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY s.sector, f.sort_order, f.level, s.number, s.label`
      )
      .all(...params)
      .map((r) => ({ ...r, has_sensor: !!r.has_sensor, is_active: !!r.is_active }));
  }

  function createSpot(input) {
    const b = body(input);
    const floorId = int(b.floor_id, "floor_id", { min: 1, max: Number.MAX_SAFE_INTEGER });
    const floor = q.floor.get(floorId);
    if (!floor) throw new HttpError(404, "Kati nuk u gjet");
    const label = str(b.label, "label", { max: 8, re: LABEL_RE, upper: true });
    const rowLabel = str(b.row_label, "row_label", { max: 8, re: LABEL_RE, upper: true, optional: true });
    const number =
      int(b.number, "number", { min: 1, max: 9999, optional: true }) ??
      (/^P\d+$/.test(label) ? Number(label.slice(1)) : null);
    const key = `${floor.sector_code}-${label}`;
    const source = floor.is_demo ? "demo" : "manual";
    return db.transaction(() => {
      let id;
      try {
        id = db
          .prepare(
            `INSERT INTO spots (spot_key, sector, label, has_sensor, floor_id, row_label, number, source)
             VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
          )
          .run(key, floor.sector_code, label, floorId, rowLabel ?? null, number, source).lastInsertRowid;
      } catch (e) {
        sqlError(e, `Vendi ${key} ekziston`);
      }
      // Kodi QR i vendit (tabela e Isras) — vlera = spot_key, si në seed-in e ekipit.
      db.prepare("INSERT OR IGNORE INTO qr_codes (spot_id, code) VALUES (?, ?)").run(id, key);
      return listSpots({}).find((s) => s.id === id);
    })();
  }

  function updateSpot(key, input) {
    const b = body(input);
    const cur = q.spot.get(key);
    if (!cur) throw new HttpError(404, "Vendi nuk u gjet");
    if (b.label !== undefined || b.spot_key !== undefined || b.sector !== undefined) {
      throw new HttpError(400, "Çelësi i vendit është në QR dhe nuk ndryshohet — krijo vend të ri");
    }
    const floorId = int(b.floor_id, "floor_id", { min: 1, max: Number.MAX_SAFE_INTEGER, optional: true });
    if (floorId !== undefined) {
      const floor = q.floor.get(floorId);
      if (!floor) throw new HttpError(404, "Kati nuk u gjet");
      if (floor.sector_code !== cur.sector) throw new HttpError(400, "Kati duhet të jetë në të njëjtin sektor");
    }
    const rowLabel = b.row_label === null ? null : str(b.row_label, "row_label", { max: 8, re: LABEL_RE, upper: true, optional: true });
    const number = int(b.number, "number", { min: 1, max: 9999, optional: true });
    const isActive = bool(b.is_active, "is_active");
    db.prepare(
      `UPDATE spots SET floor_id = COALESCE(?, floor_id),
              row_label = CASE WHEN ? THEN ? ELSE row_label END,
              number = COALESCE(?, number), is_active = COALESCE(?, is_active) WHERE id = ?`
    ).run(floorId ?? null, b.row_label !== undefined ? 1 : 0, rowLabel ?? null, number ?? null, isActive ?? null, cur.id);
    return { before: cur, after: q.spot.get(key) };
  }

  function deleteSpot(key) {
    const cur = q.spot.get(key);
    if (!cur) throw new HttpError(404, "Vendi nuk u gjet");
    if (cur.has_sensor) throw new HttpError(409, "Vendi ka sensor live — nuk fshihet");
    const history = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM parking_sessions WHERE spot_id = ?) +
                (SELECT COUNT(*) FROM sensor_readings  WHERE spot_id = ?) +
                (SELECT COUNT(*) FROM status_events    WHERE spot_id = ?) +
                (SELECT COUNT(*) FROM reservations     WHERE spot_id = ?) +
                (SELECT COUNT(*) FROM reservation_history WHERE spot_id = ?) +
                (SELECT COUNT(*) FROM qr_scans         WHERE spot_id = ?) AS n`
      )
      .get(cur.id, cur.id, cur.id, cur.id, cur.id, cur.id).n;
    if (history) throw new HttpError(409, "Vendi ka histori — çaktivizoje në vend që ta fshish");
    db.prepare("DELETE FROM spots WHERE id = ?").run(cur.id); // spot_status dhe qr_codes fshihen me CASCADE
    return cur;
  }

  return {
    tree, createSector, updateSector, deleteSector,
    createFloor, updateFloor, deleteFloor,
    listSpots, createSpot, updateSpot, deleteSpot,
  };
}

module.exports = { createStructureService };
