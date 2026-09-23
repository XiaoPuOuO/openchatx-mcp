import { fileURLToPath } from "node:url"
import { static as expressStatic, Router } from "express"

import type { AgentObserver } from "./observer.js"

/** Build the localhost-only observer dashboard and steering API mounted under `/ui`. */
export function createDashboardRouter(agentObserver: AgentObserver): Router {
  const router = Router()

  router.get("/api/agents", (_req, res) => {
    res.json({ agents: agentObserver.listAgents() })
  })

  router.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders()

    const unsubscribe = agentObserver.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000)
    heartbeat.unref()

    req.once("close", () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  router.post("/api/agents/:agentId/steer", (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : ""
    if (!message) {
      res.status(400).json({ error: "message is required" })
      return
    }
    const instruction = agentObserver.queueInstruction(req.params.agentId, message)
    if (!instruction) {
      res.status(404).json({ error: "agent not found" })
      return
    }
    res.status(202).json({ instruction })
  })

  router.delete("/api/agents/:agentId/instructions/:instructionId", (req, res) => {
    const cancelled = agentObserver.cancelInstruction(req.params.agentId, req.params.instructionId)
    if (!cancelled) {
      res.status(404).json({ error: "queued instruction not found" })
      return
    }
    res.status(204).end()
  })

  const dashboardDir = fileURLToPath(new URL("../../ui/dist/", import.meta.url))
  router.get("/editor", (_req, res) => {
    res.sendFile(fileURLToPath(new URL("../../ui/dist/index.html", import.meta.url)))
  })
  router.use(expressStatic(dashboardDir, { index: "index.html" }))
  return router
}
