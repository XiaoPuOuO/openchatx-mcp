import type { Router } from "express"
import type { JobManager } from "./job-manager.js"

export function registerJobRoutes(
  router: ReturnType<typeof Router>,
  jobs: JobManager | undefined
): void {
  router.get("/api/jobs/:jobId", async (req, res) => {
    if (!jobs) return res.status(503).json({ error: "Durable jobs are unavailable." })
    try {
      res.json(await jobs.readLog(req.params.jobId, 128 * 1024))
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
