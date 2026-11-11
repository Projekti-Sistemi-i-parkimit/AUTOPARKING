"use strict";

const { HttpError } = require("../middleware/errors");

// Statistikat për dashboard-in (D3). Erdi jep të dhënat, Isra UI-në.
//  - zënia mesatare për orë të ditës dhe për ditë, ora e pikut
//  - kohëzgjatja mesatare/mediane e qëndrimit
//  - hyrjet/daljet (sensori S7 te hyrja)
//  - gabimet e sensorëve (matje pa echo + rëniet në "unknown") dhe gjendja online
//  - rezultati i rezervimeve (të realizuara / të skaduara / të anuluara)
// Zënia llogaritet nga parking_sessions: për çdo orë, minutat e zëna / (vende × 60).
// Grupimi bëhet sipas orës lokale të qendrës tregtare.

const TIMEZONE = "Europe/Belgrade";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MAX_RANGE_DAYS = 92;

const localFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function localParts(ms) {
  const p = Object.fromEntries(localFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// Kohët TEXT të SQLite (datetime('now')) janë UTC në formatin "YYYY-MM-DD HH:MM:SS".
function toSqlTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function parseTime(value, field) {
  if (value == null || value === "") return null;
  const ms = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new HttpError(400, `"${field}" nuk është datë e vlefshme`);
  return ms;
}

// ?from=&to= (ISO ose epoch ms). Parazgjedhje: 7 ditët e fundit. Maksimumi 92 ditë.
function parseRange(query = {}, now = Date.now()) {
  const to = Math.min(parseTime(query.to, "to") ?? now, now);
  const from = parseTime(query.from, "from") ?? to - 7 * DAY;
  if (from >= to) throw new HttpError(400, '"from" duhet të jetë para "to"');
  if (to - from > MAX_RANGE_DAYS * DAY) {
    throw new HttpError(400, `Periudha maksimale është ${MAX_RANGE_DAYS} ditë`);
  }
  return { from, to };
}

function parseSector(db, sector) {
  if (sector == null || sector === "" || sector === "all") return null;
  const row = db.prepare("SELECT code FROM sectors WHERE code = ?").get(String(sector).toUpperCase());
  if (!row) throw new HttpError(400, `Sektor i panjohur: ${sector}`);
  return row.code;
}

const round1 = (n) => Math.round(n * 10) / 10;

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function occupancy(db, { from, to, sector }, spotCount, now) {
  const sessions = db
    .prepare(
      `SELECT p.started_at, p.ended_at FROM parking_sessions p
       JOIN spots s ON s.id = p.spot_id
       WHERE s.is_active = 1 AND p.started_at < ? AND (p.ended_at IS NULL OR p.ended_at > ?)
       ${sector ? "AND s.sector = ?" : ""}`
    )
    .all(to, from, ...(sector ? [sector] : []));

  // Minutat e zëna për çdo orë (UTC e rrumbullakosur; zonat e Evropës kanë offset të plotë).
  const firstHour = Math.floor(from / HOUR) * HOUR;
  const busy = new Map();
  for (const s of sessions) {
    const start = Math.max(s.started_at, from);
    const end = Math.min(s.ended_at ?? Math.min(now, to), to);
    for (let h = Math.floor(start / HOUR) * HOUR; h < end; h += HOUR) {
      const overlap = Math.min(end, h + HOUR) - Math.max(start, h);
      if (overlap > 0) busy.set(h, (busy.get(h) || 0) + overlap);
    }
  }

  const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  const byDay = new Map();
  let total = 0;
  let hours = 0;
  for (let h = firstHour; h < to; h += HOUR) {
    const span = Math.min(to, h + HOUR) - Math.max(from, h);
    if (span <= 0) continue;
    const pct = spotCount ? ((busy.get(h) || 0) / (span * spotCount)) * 100 : 0;
    const { date, hour } = localParts(h);
    byHour[hour].sum += pct;
    byHour[hour].n += 1;
    const d = byDay.get(date) || { sum: 0, n: 0 };
    d.sum += pct;
    d.n += 1;
    byDay.set(date, d);
    total += pct;
    hours += 1;
  }

  const byHourOfDay = byHour.map((b, hour) => ({ hour, avg_pct: b.n ? round1(b.sum / b.n) : null }));
  const peak = byHourOfDay.reduce((best, b) => (b.avg_pct != null && (!best || b.avg_pct > best.avg_pct) ? b : best), null);
  return {
    avg_pct: hours ? round1(total / hours) : 0,
    peak_hour: peak && peak.avg_pct > 0 ? peak : null,
    by_hour_of_day: byHourOfDay,
    daily: [...byDay.entries()].map(([date, d]) => ({ date, avg_pct: round1(d.sum / d.n) })),
  };
}

function sessionStats(db, { from, to, sector }) {
  const rows = db
    .prepare(
      `SELECT p.started_at, p.ended_at FROM parking_sessions p JOIN spots s ON s.id = p.spot_id
       WHERE p.started_at >= ? AND p.started_at < ? ${sector ? "AND s.sector = ?" : ""}`
    )
    .all(from, to, ...(sector ? [sector] : []));
  const durations = rows
    .filter((r) => r.ended_at != null)
    .map((r) => (r.ended_at - r.started_at) / 60000)
    .sort((a, b) => a - b);
  const byDay = new Map();
  for (const r of rows) {
    const { date } = localParts(r.started_at);
    byDay.set(date, (byDay.get(date) || 0) + 1);
  }
  return {
    count: rows.length,
    closed: durations.length,
    open: rows.length - durations.length,
    avg_minutes: durations.length ? round1(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    median_minutes: durations.length ? round1(median(durations)) : null,
    max_minutes: durations.length ? round1(durations[durations.length - 1]) : null,
    by_day: Object.fromEntries(byDay),
  };
}

function entranceStats(db, { from, to }) {
  const rows = db
    .prepare("SELECT type, created_at FROM gate_events WHERE created_at >= ? AND created_at < ?")
    .all(toSqlTime(from), toSqlTime(to));
  const byDay = new Map();
  let entries = 0;
  let exits = 0;
  for (const r of rows) {
    const { date } = localParts(Date.parse(r.created_at.replace(" ", "T") + "Z"));
    const d = byDay.get(date) || { entries: 0, exits: 0 };
    if (r.type === "entry") { entries++; d.entries++; } else { exits++; d.exits++; }
    byDay.set(date, d);
  }
  const barrier = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM barrier_events WHERE created_at >= ? AND created_at < ? GROUP BY status`
    )
    .all(toSqlTime(from), toSqlTime(to));
  return {
    entries,
    exits,
    by_day: [...byDay.entries()].map(([date, d]) => ({ date, ...d })),
    barrier: Object.fromEntries(barrier.map((b) => [b.status, b.n])),
  };
}

function sensorStats(db, { from, to }, timeoutS, now) {
  const sensors = db
    .prepare(
      `SELECT se.id, se.code, se.kind, se.spot_id, se.trig_pin, se.echo_pin, se.last_seen_at, se.last_ok_at,
              s.spot_key
       FROM sensors se LEFT JOIN spots s ON s.id = se.spot_id ORDER BY se.id`
    )
    .all();
  const readErr = db.prepare(
    "SELECT COUNT(*) AS n FROM sensor_readings WHERE spot_id = ? AND sensor_ok = 0 AND created_at >= ? AND created_at < ?"
  );
  const dropouts = db.prepare(
    "SELECT COUNT(*) AS n FROM status_events WHERE spot_id = ? AND to_status = 'unknown' AND created_at >= ? AND created_at < ?"
  );
  const lastGate = db.prepare("SELECT MAX(created_at) AS t FROM gate_events").get().t;
  const list = sensors.map((s) => {
    const lastSeen = s.kind === "entrance" ? lastGate : s.last_seen_at;
    const seenMs = lastSeen ? Date.parse(lastSeen.replace(" ", "T") + "Z") : null;
    return {
      code: s.code,
      kind: s.kind,
      spot_key: s.spot_key,
      pins: { trig: s.trig_pin, echo: s.echo_pin },
      last_seen_at: lastSeen,
      online: seenMs != null && now - seenMs <= timeoutS * 1000,
      read_errors: s.spot_id ? readErr.get(s.spot_id, toSqlTime(from), toSqlTime(to)).n : 0,
      dropouts: s.spot_id ? dropouts.get(s.spot_id, from, to).n : 0,
    };
  });
  return {
    total_errors: list.reduce((a, s) => a + s.read_errors + s.dropouts, 0),
    online: list.filter((s) => s.online).length,
    sensors: list,
  };
}

function reservationStats(db, { from, to, sector }) {
  const rows = db
    .prepare(
      `SELECT h.outcome, COUNT(*) AS n FROM reservation_history h JOIN spots s ON s.id = h.spot_id
       WHERE h.closed_at >= ? AND h.closed_at < ? ${sector ? "AND s.sector = ?" : ""} GROUP BY h.outcome`
    )
    .all(from, to, ...(sector ? [sector] : []));
  const by = Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
  return { fulfilled: by.fulfilled || 0, expired: by.expired || 0, cancelled: by.cancelled || 0 };
}

function summary(db, query = {}, { now = Date.now(), sensorTimeoutS } = {}) {
  const range = parseRange(query, now);
  const sector = parseSector(db, query.sector);
  const scope = { ...range, sector };
  const spotCount = db
    .prepare(`SELECT COUNT(*) AS n FROM spots WHERE is_active = 1 ${sector ? "AND sector = ?" : ""}`)
    .get(...(sector ? [sector] : [])).n;
  const timeout =
    sensorTimeoutS ?? Number((db.prepare("SELECT value FROM settings WHERE key = 'sensor_timeout_s'").get() || {}).value || 30);
  return {
    range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), timezone: TIMEZONE },
    sector: sector || "all",
    spots: spotCount,
    occupancy: occupancy(db, scope, spotCount, now),
    sessions: sessionStats(db, scope),
    entrance: entranceStats(db, scope),
    sensors: sensorStats(db, scope, timeout, now),
    reservations: reservationStats(db, scope),
  };
}

module.exports = { summary, parseRange, parseSector, localParts, toSqlTime, TIMEZONE, MAX_RANGE_DAYS };
