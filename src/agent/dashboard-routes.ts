import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { static as expressStatic, Router } from "express"

import type { CapabilityRegistry } from "../capabilities/catalog.js"
import type { CapabilityHealthService } from "../capabilities/health.js"
import { MCP_CONFIG } from "../config.js"
import { loadExternalMcpConfig, saveExternalMcpConfig } from "../external-mcp/config.js"
import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import type { PlatformOverviewService } from "../platform/overview.js"
import type { ProjectRegistry } from "../projects/project-registry.js"
import type { CapabilityStoreService } from "../store/store-service.js"
import {
  loadSubagentConfig,
  redactSubagentConfig,
  type SubagentConfig,
  saveSubagentConfig,
} from "../subagents/config.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"
import type { AgentObserver } from "./observer.js"

export interface DashboardServices {
  toolboxRegistry?: ToolboxRegistry
  subagentRuntime?: SubagentRuntime
  externalMcp?: ExternalMcpRegistry
  capabilityHealth?: CapabilityHealthService
  capabilityRegistry?: CapabilityRegistry
  capabilityStore?: CapabilityStoreService
  platformOverview?: PlatformOverviewService
  projectRegistry?: ProjectRegistry
}

/** Build the localhost-only observer dashboard and steering API mounted under `/ui`. */
export function createDashboardRouter(
  agentObserver: AgentObserver,
  services: DashboardServices = {}
): Router {
  const {
    toolboxRegistry,
    subagentRuntime,
    externalMcp,
    capabilityHealth,
    capabilityRegistry,
    capabilityStore,
    platformOverview,
    projectRegistry,
  } = services
  const router = Router()

  router.get("/api/agents", (_req, res) => {
    res.json({ agents: agentObserver.listAgents() })
  })

  registerCapabilityRoutes(router, capabilityHealth, capabilityRegistry)
  registerStoreRoutes(router, capabilityStore)
  registerProjectRoutes(router, projectRegistry)

  router.get("/api/platform", async (_req, res) => {
    if (!platformOverview) {
      res.status(503).json({ error: "Platform overview is unavailable." })
      return
    }
    res.json(await platformOverview.snapshot())
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

function registerCapabilityRoutes(
  router: ReturnType<typeof Router>,
  capabilityHealth?: CapabilityHealthService,
  capabilityRegistry?: CapabilityRegistry
): void {
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
}

function registerStoreRoutes(
  router: ReturnType<typeof Router>,
  capabilityStore?: CapabilityStoreService
): void {
  router.get("/api/store/recommended-mcps", async (_req, res) => {
    if (!capabilityStore) {
      res.status(503).json({ error: "Capability Store is unavailable." })
      return
    }
    res.json({ mcps: await capabilityStore.recommendedMcps() })
  })

  router.get("/api/store", async (req, res) => {
    if (!capabilityStore) {
      res.status(503).json({ error: "Capability Store is unavailable." })
      return
    }
    const query = typeof req.query.q === "string" ? req.query.q.trim() : ""
    const source =
      req.query.source === "builtin" || req.query.source === "community" ? req.query.source : "all"
    res.json(await capabilityStore.browse(query, source))
  })

  router.get("/api/store/:id/source-tree", async (req, res) => {
    if (!capabilityStore) {
      res.status(503).json({ error: "Capability Store is unavailable." })
      return
    }
    try {
      const revision = typeof req.query.revision === "string" ? req.query.revision : undefined
      res.json(await capabilityStore.sourceTree(req.params.id, revision))
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.get("/api/store/:id/source", async (req, res) => {
    if (!capabilityStore) {
      res.status(503).json({ error: "Capability Store is unavailable." })
      return
    }
    try {
      const path = typeof req.query.path === "string" ? req.query.path : ""
      const revision = typeof req.query.revision === "string" ? req.query.revision : undefined
      res.json(await capabilityStore.sourceRead(req.params.id, path, revision))
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.get("/api/store/:id/review", async (req, res) => {
    if (!capabilityStore) {
      res.status(503).json({ error: "Capability Store is unavailable." })
      return
    }
    try {
      const revision = typeof req.query.revision === "string" ? req.query.revision : undefined
      res.json(await capabilityStore.review(req.params.id, revision))
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.post("/api/store/:id/install", async (req, res) => {
    if (!capabilityStore) {
      res.status(503).json({ error: "Capability Store is unavailable." })
      return
    }
    try {
      const revision = typeof req.body?.revision === "string" ? req.body.revision : undefined
      res.status(201).json({ entry: await capabilityStore.install(req.params.id, revision) })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.delete("/api/store/:id", async (req, res) => {
    if (!capabilityStore) {
      res.status(503).json({ error: "Capability Store is unavailable." })
      return
    }
    try {
      await capabilityStore.uninstall(req.params.id)
      res.status(204).end()
    } catch (error) {
      toolboxError(res, error)
    }
  })
}

function registerProjectRoutes(
  router: ReturnType<typeof Router>,
  projects?: ProjectRegistry
): void {
  router.get("/api/projects", async (_req, res) => {
    if (!projects) {
      res.status(503).json({ error: "Project registry is unavailable." })
      return
    }
    res.json({ projects: await projects.list() })
  })

  router.post("/api/projects", async (req, res) => {
    if (!projects) {
      res.status(503).json({ error: "Project registry is unavailable." })
      return
    }
    try {
      const project = await projects.upsert({
        id: String(req.body?.id ?? "").trim(),
        name: String(req.body?.name ?? "").trim(),
        path: String(req.body?.path ?? "").trim(),
        description:
          typeof req.body?.description === "string" && req.body.description.trim()
            ? req.body.description.trim()
            : undefined,
        permissions: {
          read: req.body?.permissions?.read !== false,
          write: req.body?.permissions?.write !== false,
          shell: req.body?.permissions?.shell !== false,
        },
      })
      res.status(201).json({ project })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.patch("/api/projects/:id", async (req, res) => {
    if (!projects) {
      res.status(503).json({ error: "Project registry is unavailable." })
      return
    }
    try {
      const current = await projects.get(req.params.id)
      let description = current.description
      if (req.body?.description === null) description = undefined
      else if (typeof req.body?.description === "string")
        description = req.body.description.trim() || undefined
      const project = await projects.upsert({
        id: current.id,
        name:
          typeof req.body?.name === "string" && req.body.name.trim()
            ? req.body.name.trim()
            : current.name,
        path:
          typeof req.body?.path === "string" && req.body.path.trim()
            ? req.body.path.trim()
            : current.path,
        description,
        permissions: {
          read: req.body?.permissions?.read ?? current.permissions.read,
          write: req.body?.permissions?.write ?? current.permissions.write,
          shell: req.body?.permissions?.shell ?? current.permissions.shell,
        },
      })
      res.json({ project })
    } catch (error) {
      toolboxError(res, error)
    }
  })

  router.delete("/api/projects/:id", async (req, res) => {
    if (!projects) {
      res.status(503).json({ error: "Project registry is unavailable." })
      return
    }
    try {
      await projects.remove(req.params.id)
      res.status(204).end()
    } catch (error) {
      toolboxError(res, error)
    }
  })
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
