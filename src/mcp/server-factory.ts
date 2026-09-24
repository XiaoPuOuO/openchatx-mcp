import { McpServer } from "@modelcontextprotocol/server"
import type { AgentObserver } from "../agent/observer.js"
import { buildMcpInstructions, MCP_CONFIG } from "../config.js"
import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"
import { registerApplyPatchTool } from "../tools/apply-patch/apply-patch.js"
import { registerCatalogTools } from "../tools/catalog/catalog-tools.js"
import {
  registerFileEditTool,
  registerFileReadTool,
  registerFileWriteTool,
} from "../tools/file/file-tools.js"
import { registerImageTools } from "../tools/image/image-tools.js"
import { registerMcpServerManagementTools } from "../tools/mcp-server-management/mcp-server-management-tools.js"
import { registerSearchTools } from "../tools/search/search-tools.js"
import { registerBashTool } from "../tools/shell/bash-tool.js"
import {
  type InteractiveShellManager,
  registerTerminalTool,
} from "../tools/shell/interactive-shell.js"
import type { ShellSessionManager } from "../tools/shell/session-manager.js"
// import { registerIosShellTool } from "../tools/ios/ios-shell.js"
import {
  registerShellExecutionTools,
  registerShellManagementTools,
} from "../tools/shell/shell-tools.js"
import { registerSkillTools } from "../tools/skills/skill-tools.js"
import { type CapabilityCatalog, registerStartHereTool } from "../tools/start-here/start-here.js"
import { registerSubagentTools } from "../tools/subagents/subagent-tools.js"
import { registerToolboxManagementTools } from "../tools/toolbox-management/toolbox-management-tools.js"
import type { WebPageOpener } from "../tools/web/web-open.js"
import { registerWebTool } from "../tools/web/web-tool.js"
import { installToolRegistrationBoundary } from "./tool-registration-boundary.js"

export interface CreateMcpServerOptions {
  shellManager?: ShellSessionManager
  externalMcp?: ExternalMcpRegistry
  toolboxRegistry?: ToolboxRegistry
  interactiveShellManager?: InteractiveShellManager
  webPageOpener?: WebPageOpener
  subagentRuntime?: SubagentRuntime
  auditRequest?: McpAuditRequest
  agentObserver?: AgentObserver
}

export interface McpCapabilityServices {
  shellManager?: ShellSessionManager
  externalMcp?: ExternalMcpRegistry
  toolboxRegistry?: ToolboxRegistry
  interactiveShellManager?: InteractiveShellManager
  webPageOpener?: WebPageOpener
  subagentRuntime?: SubagentRuntime
}

export interface McpRuntimeProfile {
  readonly server: Readonly<typeof MCP_CONFIG.server>
  readonly tools: Readonly<typeof MCP_CONFIG.tools>
  readonly toolOutput: (typeof MCP_CONFIG.mcp)["toolOutput"]
}

export interface McpRuntimeProfileOverrides {
  server?: Partial<McpRuntimeProfile["server"]>
  tools?: Partial<McpRuntimeProfile["tools"]>
  toolOutput?: McpRuntimeProfile["toolOutput"]
}

export interface McpServerRequestContext {
  auditRequest?: McpAuditRequest
  agentObserver?: AgentObserver
}

export type McpServerFactory = (context?: McpServerRequestContext) => McpServer

/**
 * Bind process-level capability services once and create short-lived MCP servers on demand.
 * Tool-group enablement, required service checks, and capability registration stay
 * on the MCP side of the transport boundary.
 */
export function createMcpServerFactory(
  services: McpCapabilityServices,
  profileOverrides: McpRuntimeProfileOverrides = {}
): McpServerFactory {
  const profile = snapshotMcpRuntimeProfile(profileOverrides)
  return (context = {}) =>
    createMcpServer(
      {
        ...services,
        auditRequest: context.auditRequest,
        agentObserver: context.agentObserver,
      },
      profile
    )
}

function createMcpServer(options: CreateMcpServerOptions, profile: McpRuntimeProfile): McpServer {
  const server = new McpServer(profile.server, {
    instructions: buildMcpInstructions(),
  })
  installToolRegistrationBoundary(server, {
    structuredOutput: profile.toolOutput === "structured",
    agentObserver: options.agentObserver,
    auditRequest: options.auditRequest,
  })

  let shells: ShellSessionManager | undefined
  if (!options.toolboxRegistry && profile.tools.shell) {
    shells = requireCapabilityService(options.shellManager, "shell")
  }
  if (options.toolboxRegistry) {
    registerToolboxRuntime(server, options, options.toolboxRegistry)
  } else {
    registerLegacyRuntime(server, options, profile, shells)
  }
  if (options.toolboxRegistry && options.externalMcp) {
    registerCatalogTools(server, options.toolboxRegistry, options.externalMcp)
  } else {
    options.externalMcp?.registerTools(server)
  }

  return server
}

function registerToolboxRuntime(
  server: McpServer,
  options: CreateMcpServerOptions,
  registry: ToolboxRegistry
): void {
  registerBuiltinToolbox(server, registry, "system", () =>
    registerStartHereTool(server, () => buildCapabilityCatalog(options, registry))
  )
  registerBuiltinToolbox(server, registry, "shell", () => {
    registerBashTool(server)
    if (options.interactiveShellManager)
      registerTerminalTool(server, options.interactiveShellManager)
  })
  registerBuiltinToolbox(server, registry, "files", () => {
    registerApplyPatchTool(server)
    registerFileReadTool(server)
    registerFileWriteTool(server)
    registerFileEditTool(server)
  })
  registerBuiltinToolbox(server, registry, "web", () =>
    registerWebTool(server, requireCapabilityService(options.webPageOpener, "web"))
  )
  registerBuiltinToolbox(server, registry, "skills", () => registerSkillTools(server, registry))
  registerBuiltinToolbox(server, registry, "media", () => registerImageTools(server))
  registerBuiltinToolbox(server, registry, "search", () => registerSearchTools(server))
  registerBuiltinToolbox(server, registry, "toolbox-manager", () =>
    registerToolboxManagementTools(server, registry)
  )
  registerBuiltinToolbox(server, registry, "mcp-manager", () =>
    registerMcpServerManagementTools(server)
  )
  const subagentRuntime = options.subagentRuntime
  if (subagentRuntime)
    registerBuiltinToolbox(server, registry, "subagents", () =>
      registerSubagentTools(server, subagentRuntime)
    )
}

function buildCapabilityCatalog(
  options: CreateMcpServerOptions,
  registry: ToolboxRegistry
): CapabilityCatalog {
  return {
    mcpServers: options.externalMcp?.capabilities() ?? [],
    subagents:
      options.subagentRuntime?.profiles().map((profile) => ({
        id: profile.id,
        name: profile.name,
        description: profile.description,
      })) ?? [],
    toolboxes: registry
      .snapshots()
      .filter((toolbox) => toolbox.enabled && !toolbox.builtin)
      .map((toolbox) => ({
        id: toolbox.id,
        name: toolbox.name,
        ...(toolbox.description ? { description: toolbox.description } : {}),
        toolCount: toolbox.tools.filter((tool) => tool.enabled).length,
        skillCount: toolbox.skills.filter((skill) => skill.enabled).length,
      })),
  }
}

function registerLegacyRuntime(
  server: McpServer,
  options: CreateMcpServerOptions,
  profile: McpRuntimeProfile,
  shells: ShellSessionManager | undefined
): void {
  registerStartHereTool(server)
  if (shells) registerShellExecutionTools(server, shells)
  if (profile.tools.applyPatch) registerApplyPatchTool(server)
  if (profile.tools.fileRead) registerFileReadTool(server)
  if (profile.tools.fileWrite) registerFileWriteTool(server)
  if (profile.tools.fileWrite) registerFileEditTool(server)
  if (shells) registerShellManagementTools(server, shells)
  if (profile.tools.web)
    registerWebTool(server, requireCapabilityService(options.webPageOpener, "web"))
  if (profile.tools.skills) registerSkillTools(server)
  if (profile.tools.image) registerImageTools(server)
}

function registerBuiltinToolbox(
  server: McpServer,
  registry: ToolboxRegistry,
  toolboxId: string,
  register: () => void
): void {
  if (!registry.isToolboxEnabled(toolboxId)) return
  const original = server.registerTool
  const filtered = (name: string, config: Record<string, unknown>, callback: unknown) => {
    if (!registry.isToolEnabled(toolboxId, name)) return
    const meta = isRecord(config._meta) ? config._meta : {}
    return Reflect.apply(original, server, [
      name,
      { ...config, _meta: { ...meta, "openchatx/toolbox": toolboxId } },
      callback,
    ])
  }
  Reflect.set(server, "registerTool", filtered)
  try {
    register()
  } finally {
    Reflect.set(server, "registerTool", original)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function snapshotMcpRuntimeProfile(overrides: McpRuntimeProfileOverrides): McpRuntimeProfile {
  return Object.freeze({
    server: Object.freeze({ ...MCP_CONFIG.server, ...overrides.server }),
    tools: Object.freeze({ ...MCP_CONFIG.tools, ...overrides.tools }),
    toolOutput: overrides.toolOutput ?? MCP_CONFIG.mcp.toolOutput,
  })
}

function requireCapabilityService<T>(service: T | undefined, capability: string): T {
  if (service === undefined)
    throw new Error(`${capability} tools are enabled but their runtime service was not created.`)
  return service
}
