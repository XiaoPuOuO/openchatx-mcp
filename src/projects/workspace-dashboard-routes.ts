import type { Router } from "express"

import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import { timelineRegistry } from "../timeline/timeline-registry.js"
import type { ProjectWorkspaceService } from "./workspace-snapshot.js"

export function registerProjectWorkspaceRoutes(
  router: ReturnType<typeof Router>,
  workspaces: ProjectWorkspaceService | undefined,
  externalMcp: ExternalMcpRegistry | undefined
): void {
  router.post("/api/project-workspaces/:id/snapshot", async (req, res) => {
    if (!workspaces)
      return res.status(503).json({ error: "Project workspace snapshots are unavailable." })
    try {
      const projectId = String(req.params.id ?? "")
      const snapshot = await workspaces.snapshot(projectId)
      await timelineRegistry.append({
        type: "project",
        label: "Created project workspace snapshot",
        detail: projectId,
        projectId,
      })
      res.status(201).json({ snapshot })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get("/api/project-workspaces/:id/latest", async (req, res) => {
    if (!workspaces)
      return res.status(503).json({ error: "Project workspace snapshots are unavailable." })
    try {
      res.json({ snapshot: await workspaces.latest(String(req.params.id ?? "")) })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post("/api/project-workspaces/:id/export", async (req, res) => {
    if (!workspaces)
      return res.status(503).json({ error: "Project workspace export is unavailable." })
    try {
      const projectId = String(req.params.id ?? "")
      const destination =
        typeof req.body?.destination === "string" && req.body.destination.trim()
          ? req.body.destination.trim()
          : undefined
      const result = await workspaces.export(projectId, destination)
      await timelineRegistry.append({
        type: "project",
        label: "Exported project workspace",
        detail: result.path,
        projectId,
      })
      res.status(201).json(result)
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post("/api/project-workspaces/import", async (req, res) => {
    if (!workspaces)
      return res.status(503).json({ error: "Project workspace import is unavailable." })
    try {
      const path = typeof req.body?.path === "string" ? req.body.path.trim() : ""
      if (!path) return res.status(400).json({ error: "Import path is required." })
      const result = await workspaces.import(path)
      await externalMcp?.reload(true)
      await timelineRegistry.append({
        type: "project",
        label: "Imported project workspace",
        detail: path,
        projectId: result.project.id,
      })
      res.status(201).json(result)
    } catch (error) {
      sendError(res, error)
    }
  })
}

function sendError(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  error: unknown
): void {
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
}
