"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Router } = require("express");
const { HttpError } = require("../middleware/errors");
const { requireAdmin, requireRole } = require("../middleware/auth");
const { logAction } = require("../services/audit");
const { createStructureService } = require("../services/structure");
const { getSettings, updateSettings } = require("../services/settings");
const { summary } = require("../services/stats");
const { buildReport, REPORT_TYPES } = require("../services/reports");
const { integrityReport, purge, backup, backupFileName } = require("../services/maintenance");

// Rrugët e grupit "parking" (Erdi — D3, D5, D6).
//  Publike:  GET /api/sectors, GET /api/stats/summary
//  Admin:    struktura (sektorë/kate/vende), parametrat, raportet CSV, integriteti, pastrimi, backup.
// Leximet lejohen për çdo rol; ndryshimet vetëm për rolin "admin" dhe shkruhen në audit log.
module.exports = function parkingAdminRoutes(db, config, hub) {
  const router = Router();
  const structure = createStructureService(db);
  const auth = requireAdmin(db);
  const adminOnly = [auth, requireRole("admin")];

  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "ID e pavlefshme");
    return n;
  };
  const changed = (what, data) => hub.broadcast("structure", { what, ...data });

  // ---------- Publike ----------
  router.get("/sectors", (req, res) => {
    res.json({
      data: structure.tree().filter((s) => s.is_active).map((s) => ({
        code: s.code, name: s.name, is_demo: s.is_demo, spot_count: s.spot_count,
        floors: s.floors.filter((f) => f.is_active).map((f) => ({ id: f.id, code: f.code, name: f.name, level: f.level })),
      })),
    });
  });

  // GET /api/stats/summary?from=&to=&sector=  — të dhënat për dashboard-in
  router.get("/stats/summary", (req, res) => {
    res.json(summary(db, req.query));
  });

  // ---------- Struktura ----------
  router.get("/admin/structure", auth, (req, res) => {
    res.json({ data: structure.tree() });
  });

  router.post("/admin/sectors", ...adminOnly, (req, res) => {
    const s = structure.createSector(req.body);
    logAction(db, req.admin.id, "sector_create", { code: s.code });
    changed("sector", { code: s.code });
    res.status(201).json(s);
  });

  router.patch("/admin/sectors/:id", ...adminOnly, (req, res) => {
    const { before, after } = structure.updateSector(id(req.params.id), req.body);
    logAction(db, req.admin.id, "sector_update", { code: after.code, before, after });
    changed("sector", { code: after.code });
    res.json(after);
  });

  router.delete("/admin/sectors/:id", ...adminOnly, (req, res) => {
    const s = structure.deleteSector(id(req.params.id));
    logAction(db, req.admin.id, "sector_delete", { code: s.code });
    changed("sector", { code: s.code });
    res.json({ ok: true });
  });

  router.post("/admin/floors", ...adminOnly, (req, res) => {
    const f = structure.createFloor(req.body);
    logAction(db, req.admin.id, "floor_create", { sector: f.sector_code, code: f.code });
    changed("floor", { id: f.id });
    res.status(201).json(f);
  });

  router.patch("/admin/floors/:id", ...adminOnly, (req, res) => {
    const { before, after } = structure.updateFloor(id(req.params.id), req.body);
    logAction(db, req.admin.id, "floor_update", { id: after.id, before, after });
    changed("floor", { id: after.id });
    res.json(after);
  });

  router.delete("/admin/floors/:id", ...adminOnly, (req, res) => {
    const f = structure.deleteFloor(id(req.params.id));
    logAction(db, req.admin.id, "floor_delete", { sector: f.sector_code, code: f.code });
    changed("floor", { id: f.id });
    res.json({ ok: true });
  });

  router.get("/admin/spots", auth, (req, res) => {
    res.json({ data: structure.listSpots(req.query) });
  });

  router.post("/admin/spots", ...adminOnly, (req, res) => {
    const s = structure.createSpot(req.body);
    logAction(db, req.admin.id, "spot_create", { key: s.spot_key });
    changed("spot", { key: s.spot_key });
    hub.broadcast("spot_update", { key: s.spot_key, status: s.status, cm: null });
    res.status(201).json(s);
  });

  router.patch("/admin/spots/:key", ...adminOnly, (req, res) => {
    const { before, after } = structure.updateSpot(req.params.key, req.body);
    logAction(db, req.admin.id, "spot_update", { key: after.spot_key, before, after });
    changed("spot", { key: after.spot_key });
    res.json(after);
  });

  router.delete("/admin/spots/:key", ...adminOnly, (req, res) => {
    const s = structure.deleteSpot(req.params.key);
    logAction(db, req.admin.id, "spot_delete", { key: s.spot_key });
    changed("spot", { key: s.spot_key, deleted: true });
    res.json({ ok: true });
  });

  // ---------- Parametrat ----------
  router.get("/admin/settings", auth, (req, res) => {
    res.json(getSettings(db, config));
  });

  router.put("/admin/settings", ...adminOnly, (req, res) => {
    const { settings, changed: diff } = updateSettings(db, config, req.body, req.admin.username);
    logAction(db, req.admin.id, "settings_update", diff);
    hub.broadcast("settings", settings.values);
    res.json(settings);
  });

  // ---------- Raportet ----------
  router.get("/admin/reports", auth, (req, res) => {
    res.json({ data: REPORT_TYPES });
  });

  router.get("/admin/reports/:type.csv", auth, (req, res) => {
    const report = buildReport(db, req.params.type, req.query);
    logAction(db, req.admin.id, "report_export", { type: req.params.type, rows: report.count, query: req.query });
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${report.filename}"`);
    res.set("X-Row-Count", String(report.count));
    res.send(report.csv);
  });

  // ---------- Mirëmbajtja ----------
  router.get("/admin/maintenance/integrity", auth, (req, res) => {
    res.json(integrityReport(db));
  });

  router.post("/admin/maintenance/purge", ...adminOnly, (req, res) => {
    const dryRun = !(req.body && req.body.confirm === true);
    const result = purge(db, { dryRun });
    if (!dryRun) logAction(db, req.admin.id, "data_purge", result.result);
    res.json(result);
  });

  // Shkarkon një kopje të plotë të databazës (vetëm admin). Rikthimi bëhet me CLI
  // (npm run db:restore) me serverin të ndalur — kurrë nga shfletuesi.
  router.get("/admin/backup", ...adminOnly, async (req, res, next) => {
    const name = backupFileName();
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "parkimi-")), name);
    try {
      const info = await backup(db, tmp);
      logAction(db, req.admin.id, "backup_download", { file: name, bytes: info.bytes });
      res.download(tmp, name, () => fs.rm(path.dirname(tmp), { recursive: true, force: true }, () => {}));
    } catch (e) {
      fs.rm(path.dirname(tmp), { recursive: true, force: true }, () => {});
      next(e);
    }
  });

  return router;
};
