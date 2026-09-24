import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { static as expressStatic, Router } from "express"

import type { CapabilityRegistry } from "../capabilities/catalog.js"
import type { CapabilityHealthService } from "../capabilities/health.js"
import { MCP_CONFIG } from "../config.js"
import { loadExternalMcpConfig, saveExternalMcpConfig } from "../external-mcp/config.js"
import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import {
  loadSubagentConfig,
  redactSubagentConfig,
  type SubagentConfig,
  saveSubagentConfig,
} from "../subagents/config.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"
import type { AgentObserver } from "./observer.js"

/** Build the localhost-only observer dashboard and steering API mounted under `/ui`. */
export function createDashboardRouter(
  agentObserver: AgentObserver,
  toolboxRegistry?: ToolboxRegistry,
  subagentRuntime?: SubagentRuntime,
  externalMcp?: ExternalMcpRegistry,
  capabilityHealth?: CapabilityHealthService,
  capabilityRegistry?: CapabilityRegistry
): Router {
  const router = Router()

  router.get("/api/agents", (_req, res) => {
    res.json({ agents: agentObserver.listAgents() })
  })

  router.get("/api/health", async (_req, res) => {
    if (!capabilityHealth) {
      res.status(503).json({ error: "Capability health service is unavailable." })
      return
    }
    res.json(await capabilityHealth.snapshot())
  })

  router.get("/api/capabilities", (req, res) => {
    if (!capabilityRegistry) {
      res.status(503).json({ error: "Capability registry is unavailable." })
      return
    }
    const query = typeof req.query.q === "string" ? req.query.q.trim() : ""
    res.json({
      capabilities: query ? capabilityRegistry.search(query) : capabilityRegistry.list(),
    })
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

  router.get("/api/mcp-servers", (_req, res) => {
    res.json({ servers: loadExternalMcpConfig(MCP_CONFIG.externalMcp.configFile) })
  })

  router.put("/api/mcp-servers", async (req, res) => {
    try {
      const servers = saveExternalMcpConfig(MCP_CONFIG.externalMcp.configFile, req.body?.servers)
      await externalMcp?.reload()
      res.json({ servers, restartRequired: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(400).json({ error: message })
    }
  })

  router.post("/api/mcp-servers/open-in-finder", (_req, res) => {
    execFile("/usr/bin/open", ["-R", MCP_CONFIG.externalMcp.configFile], (error) => {
      if (error) {
        res.status(500).json({ error: `Failed to open Finder: ${error.message}` })
        return
      }
      res.status(204).end()
    })
  })

  router.get("/api/subagents", (_req, res) => {
    try {
      res.json({
        config: redactSubagentConfig(loadSubagentConfig(MCP_CONFIG.subagents.configFile)),
      })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.put("/api/subagents", (req, res) => {
    try {
      const existing = loadSubagentConfig(MCP_CONFIG.subagents.configFile)
      const incoming = req.body?.config
      const merged = preserveRedactedSecrets(existing, incoming)
      const saved = saveSubagentConfig(MCP_CONFIG.subagents.configFile, merged)
      subagentRuntime?.updateConfig(saved)
      res.json({ config: redactSubagentConfig(saved), restartRequired: false })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.post("/api/subagents/open-in-finder", (_req, res) => {
    execFile("/usr/bin/open", ["-R", MCP_CONFIG.subagents.configFile], (error) => {
      if (error) {
        res.status(500).json({ error: `Failed to open Finder: ${error.message}` })
        return
      }
      res.status(204).end()
    })
  })

  router.get("/api/toolboxes", (_req, res) => {
    res.json({ toolboxes: toolboxRegistry?.snapshots() ?? [] })
  })

  router.post("/api/toolboxes/reload", async (_req, res) => {
    if (!toolboxRegistry) {
      res.status(503).json({ error: "Toolbox runtime is unavailable." })
      return
    }
    await toolboxRegistry.reload()
    res.json({ toolboxes: toolboxRegistry.snapshots() })
  })

  router.post("/api/toolboxes", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      await toolboxRegistry.createToolbox(String(req.body?.id ?? "").trim(), req.body?.name)
      res.status(201).json({ toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.patch("/api/toolboxes/:toolboxId", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      await toolboxRegistry.setToolboxEnabled(req.params.toolboxId, Boolean(req.body?.enabled))
      res.json({ toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.delete("/api/toolboxes/:toolboxId", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      await toolboxRegistry.deleteToolbox(req.params.toolboxId)
      res.json({ toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.post("/api/toolboxes/:toolboxId/tools", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      const path = await toolboxRegistry.createTool(
        req.params.toolboxId,
        String(req.body?.name ?? "").trim()
      )
      res.status(201).json({ path, toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.patch("/api/toolboxes/:toolboxId/tools/:toolName", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      await toolboxRegistry.setToolEnabled(
        req.params.toolboxId,
        req.params.toolName,
        Boolean(req.body?.enabled)
      )
      res.json({ toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.delete("/api/toolboxes/:toolboxId/tools/:toolName", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      await toolboxRegistry.deleteTool(req.params.toolboxId, req.params.toolName)
      res.json({ toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.post("/api/toolboxes/:toolboxId/skills", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      const path = await toolboxRegistry.createSkill(
        req.params.toolboxId,
        String(req.body?.name ?? "").trim()
      )
      res.status(201).json({ path, toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.patch("/api/toolboxes/:toolboxId/skills/:skillName", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      await toolboxRegistry.setSkillEnabled(
        req.params.toolboxId,
        req.params.skillName,
        Boolean(req.body?.enabled)
      )
      res.json({ toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.delete("/api/toolboxes/:toolboxId/skills/:skillName", async (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      await toolboxRegistry.deleteSkill(req.params.toolboxId, req.params.skillName)
      res.json({ toolboxes: toolboxRegistry.snapshots() })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.post("/api/toolboxes/:toolboxId/open-in-finder", (req, res) => {
    if (!toolboxRegistry) return unavailableToolboxes(res)
    try {
      const path = toolboxRegistry.itemPath(req.params.toolboxId, req.body?.kind, req.body?.name)
      execFile("/usr/bin/open", ["-R", path], (error) => {
        if (error) {
          res.status(500).json({ error: `Failed to open Finder: ${error.message}` })
          return
        }
        res.status(204).end()
      })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  const dashboardDir = fileURLToPath(new URL("../../ui/dist/", import.meta.url))
  router.use(expressStatic(dashboardDir, { index: "index.html" }))
  return router
}

function preserveRedactedSecrets(existing: SubagentConfig, incoming: unknown): unknown {
  if (!isRecord(incoming)) return incoming
  const providers = isRecord(incoming.providers) ? { ...incoming.providers } : incoming.providers
  if (!isRecord(providers)) return incoming

  for (const [id, rawProvider] of Object.entries(providers)) {
    if (!isRecord(rawProvider)) continue
    const previous = existing.providers[id]
    if (!previous) continue
    const provider = { ...rawProvider }
    if (provider.api_key === "<redacted>") provider.api_key = previous.api_key
    if (isRecord(provider.headers) && previous.headers) {
      provider.headers = Object.fromEntries(
        Object.entries(provider.headers).map(([key, value]) => [
          key,
          value === "<redacted>" ? (previous.headers?.[key] ?? value) : value,
        ])
      )
    }
    providers[id] = provider
  }
  return { ...incoming, providers }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unavailableToolboxes(res: Parameters<typeof toolboxError>[0]) {
  res.status(503).json({ error: "Toolbox runtime is unavailable." })
}

function toolboxError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  error: unknown
) {
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
}
