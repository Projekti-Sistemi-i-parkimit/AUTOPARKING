"use strict";

const { HttpError } = require("../middleware/errors");
const { parseRange, parseSector, toSqlTime, TIMEZONE } = require("./stats");

// Eksporti CSV (D5). UTF-8 me BOM që Excel t'i shfaqë saktë shkronjat ë/ç.
// Mbrojtje nga "CSV/formula injection": tekstet që fillojnë me = + - @ tab ose CR
// marrin një apostrof përpara, që Excel të mos i ekzekutojë si formula.

const MAX_ROWS = 100_000;
const DANGEROUS = /^[=+\-@\t\r]/;

function cell(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (DANGEROUS.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const lines = [columns.map(cell).join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

const localTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIMEZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const fmtMs = (ms) => (ms == null ? null : localTime.format(new Date(ms)));
const fmtSql = (t) => (t ? fmtMs(Date.parse(t.replace(" ", "T") + "Z")) : null);

const REPORTS = {
  sessions: {
    title: "Qëndrimet",
    columns: ["spot_key", "sector", "floor", "visitor_name", "plate", "started_at", "ended_at", "duration_min", "planned_until"],
    rows(db, { from, to, sector }) {
      return db
        .prepare(
          `SELECT s.spot_key, s.sector, f.code AS floor, p.visitor_name, p.plate, p.started_at, p.ended_at, p.planned_until
           FROM parking_sessions p JOIN spots s ON s.id = p.spot_id LEFT JOIN floors f ON f.id = s.floor_id
           WHERE p.started_at >= ? AND p.started_at < ? ${sector ? "AND s.sector = ?" : ""}
           ORDER BY p.started_at LIMIT ${MAX_ROWS}`
        )
        .all(from, to, ...(sector ? [sector] : []))
        .map((r) => ({
          ...r,
          duration_min: r.ended_at != null ? Math.round((r.ended_at - r.started_at) / 6000) / 10 : null,
          started_at: fmtMs(r.started_at),
          ended_at: fmtMs(r.ended_at),
          planned_until: fmtMs(r.planned_until),
        }));
    },
  },
  readings: {
    title: "Leximet e sensorëve",
    columns: ["created_at", "spot_key", "sensor", "distance_cm", "status", "sensor_ok", "kind"],
    rows(db, { from, to, sector }) {
      return db
        .prepare(
          `SELECT r.created_at, s.spot_key, se.code AS sensor, r.distance_cm, r.status, r.sensor_ok, r.kind
           FROM sensor_readings r JOIN spots s ON s.id = r.spot_id LEFT JOIN sensors se ON se.spot_id = s.id
           WHERE r.created_at >= ? AND r.created_at < ? ${sector ? "AND s.sector = ?" : ""}
           ORDER BY r.id LIMIT ${MAX_ROWS}`
        )
        .all(toSqlTime(from), toSqlTime(to), ...(sector ? [sector] : []))
        .map((r) => ({ ...r, created_at: fmtSql(r.created_at) }));
    },
  },
  "status-events": {
    title: "Ndryshimet e statusit",
    columns: ["created_at", "spot_key", "sector", "from_status", "to_status", "distance_cm"],
    rows(db, { from, to, sector }) {
      return db
        .prepare(
          `SELECT e.created_at, s.spot_key, s.sector, e.from_status, e.to_status, e.distance_cm
           FROM status_events e JOIN spots s ON s.id = e.spot_id
           WHERE e.created_at >= ? AND e.created_at < ? ${sector ? "AND s.sector = ?" : ""}
           ORDER BY e.created_at, e.id LIMIT ${MAX_ROWS}`
        )
        .all(from, to, ...(sector ? [sector] : []))
        .map((r) => ({ ...r, created_at: fmtMs(r.created_at) }));
    },
  },
  entrance: {
    title: "Hyrja dhe barriera",
    columns: ["created_at", "kind", "event", "plate", "reason", "source"],
    rows(db, { from, to }) {
      return db
        .prepare(
          `SELECT created_at, kind, event, plate, reason, source FROM entrance_events
           WHERE created_at >= ? AND created_at < ? ORDER BY created_at LIMIT ${MAX_ROWS}`
        )
        .all(toSqlTime(from), toSqlTime(to))
        .map((r) => ({ ...r, created_at: fmtSql(r.created_at) }));
    },
  },
  reservations: {
    title: "Historiku i rezervimeve",
    columns: ["closed_at", "spot_key", "visitor_name", "plate", "created_at", "until", "outcome"],
    rows(db, { from, to, sector }) {
      return db
        .prepare(
          `SELECT h.closed_at, s.spot_key, h.visitor_name, h.plate, h.created_at, h.until, h.outcome
           FROM reservation_history h JOIN spots s ON s.id = h.spot_id
           WHERE h.closed_at >= ? AND h.closed_at < ? ${sector ? "AND s.sector = ?" : ""}
           ORDER BY h.closed_at LIMIT ${MAX_ROWS}`
        )
        .all(from, to, ...(sector ? [sector] : []))
        .map((r) => ({ ...r, closed_at: fmtMs(r.closed_at), created_at: fmtMs(r.created_at), until: fmtMs(r.until) }));
    },
  },
};

function buildReport(db, type, query = {}, now = Date.now()) {
  const def = REPORTS[type];
  if (!def) throw new HttpError(404, `Raport i panjohur: ${type}`);
  const range = parseRange(query, now);
  const sector = parseSector(db, query.sector);
  const rows = def.rows(db, { ...range, sector });
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    filename: `parkimi-${type}-${sector || "te-gjitha"}-${day(range.from)}_${day(range.to)}.csv`,
    csv: toCsv(def.columns, rows),
    count: rows.length,
  };
}

const REPORT_TYPES = Object.entries(REPORTS).map(([type, d]) => ({ type, title: d.title, columns: d.columns }));

module.exports = { buildReport, toCsv, cell, REPORT_TYPES };
