import type { Router } from "express"

import { redactSecrets } from "../security/redact.js"
import { BackupService } from "./backup-service.js"
import { loadOperationalState, updateOperationalState } from "./operational-state.js"
import type { SystemRecoveryService } from "./system-recovery.js"

export function registerRecoveryRoutes(
  router: ReturnType<typeof Router>,
  systemRecovery?: SystemRecoveryService
): void {
  const backups = new BackupService()

  router.get("/api/recovery/state", async (_req, res) => {
    res.json(await loadOperationalState())
  })
  router.patch("/api/recovery/state", async (req, res) => {
    const next = await updateOperationalState((state) => {
      if (typeof req.body?.onboardingCompleted === "boolean")
        state.onboardingCompleted = req.body.onboardingCompleted
      if (req.body?.update?.channel === "stable" || req.body?.update?.channel === "beta")
        state.update.channel = req.body.update.channel
      if (typeof req.body?.update?.autoCheck === "boolean")
        state.update.autoCheck = req.body.update.autoCheck
    })
    res.json(next)
  })
  router.get("/api/diagnostics", async (_req, res) => {
    if (!systemRecovery) return res.status(503).json({ error: "Diagnostics unavailable." })
    res.json(await systemRecovery.diagnostics())
  })
  router.get("/api/diagnostics/export", async (_req, res) => {
    if (!systemRecovery) return res.status(503).json({ error: "Diagnostics unavailable." })
    const bundle = redactSecrets({
      exportedAt: new Date().toISOString(),
      diagnostics: await systemRecovery.diagnostics(),
      operationalState: await loadOperationalState(),
    })
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="openchatx-diagnostics-${Date.now()}.json"`
    )
    res.type("application/json").send(`${JSON.stringify(bundle, null, 2)}\n`)
  })
  router.post("/api/doctor/repair", async (req, res) => {
    if (!systemRecovery) return res.status(503).json({ error: "Doctor unavailable." })
    try {
      res.json(await systemRecovery.repair(String(req.body?.id ?? "")))
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  router.post("/api/safe-mode", async (req, res) => {
    if (!systemRecovery) return res.status(503).json({ error: "Safe mode unavailable." })
    res.json(await systemRecovery.setSafeMode(Boolean(req.body?.enabled), req.body?.reason))
  })
  router.post("/api/backups", async (_req, res) => {
    try {
      const created = await backups.create()
      res.status(201).json({ path: created.path, createdAt: created.backup.createdAt })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  router.post("/api/backups/restore", async (req, res) => {
    try {
      const path = String(req.body?.path ?? "").trim()
      if (!path) return res.status(400).json({ error: "Backup path is required." })
      res.json(await backups.restore(path))
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
