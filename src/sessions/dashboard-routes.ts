import type { Router } from "express"
import { type TimelineEvent, timelineRegistry } from "../timeline/timeline-registry.js"
import type { RecentWorkService } from "./recent-work.js"

const TIMELINE_TYPES: readonly TimelineEvent["type"][] = [
  "tool-started",
  "tool-completed",
  "tool-failed",
  "tool-interrupted",
  "approval",
  "system",
  "project",
]

export function registerSessionHistoryRoutes(
  router: ReturnType<typeof Router>,
  recentWork: RecentWorkService | undefined
): void {
  router.get("/api/recent-work", async (req, res) => {
    if (!recentWork) return res.status(503).json({ error: "Recent work is unavailable." })
    try {
      const limit = Number(req.query.limit ?? 20)
      res.json({ items: await recentWork.list(Number.isFinite(limit) ? limit : 20) })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post("/api/recent-work/resume", async (req, res) => {
    if (!recentWork) return res.status(503).json({ error: "Session resume is unavailable." })
    try {
      const projectId =
        typeof req.body?.projectId === "string" && req.body.projectId
          ? req.body.projectId
          : undefined
      const agentId =
        typeof req.body?.agentId === "string" && req.body.agentId ? req.body.agentId : undefined
      res.status(201).json(await recentWork.resume({ projectId, agentId }))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get("/api/timeline", async (req, res) => {
    try {
      const rawType = typeof req.query.type === "string" ? req.query.type : undefined
      const type = rawType && isTimelineType(rawType) ? rawType : undefined
      const rawLimit = Number(req.query.limit ?? 200)
      const limit = Number.isFinite(rawLimit) ? rawLimit : 200
      res.json({
        events: await timelineRegistry.list({
          ...(typeof req.query.projectId === "string" && req.query.projectId
            ? { projectId: req.query.projectId }
            : {}),
          ...(typeof req.query.agentId === "string" && req.query.agentId
            ? { agentId: req.query.agentId }
            : {}),
          ...(type ? { type } : {}),
          limit,
        }),
      })
    } catch (error) {
      sendError(res, error)
    }
  })
}

function isTimelineType(value: string): value is TimelineEvent["type"] {
  return TIMELINE_TYPES.some((type) => type === value)
}

function sendError(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  error: unknown
): void {
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
}
