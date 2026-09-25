import { McpServer } from "@modelcontextprotocol/server"
import type { AgentObserver } from "../agent/observer.js"
import type { CapabilityRegistry } from "../capabilities/catalog.js"
import type { CapabilityHealthService } from "../capabilities/health.js"
import { buildMcpInstructions, MCP_CONFIG } from "../config.js"
import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import type { GoalRegistry } from "../goals/goal-registry.js"
import type { GoalScope } from "../goals/goal-scope.js"
import type { JobManager } from "../jobs/job-manager.js"
import type { NodeRegistry } from "../nodes/node-registry.js"
import type { ProjectRegistry } from "../projects/project-registry.js"
import type { ProjectScope } from "../projects/project-scope.js"
import type { ProviderHub } from "../providers/provider-hub.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import type { CapabilityStoreService } from "../store/store-service.js"
import type { SmartModelRouter } from "../subagents/router.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { AgentTeamService } from "../teams/team-service.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"
import { isApplyPatchSupported, registerApplyPatchTool } from "../tools/apply-patch/apply-patch.js"
import { registerCapabilityTools } from "../tools/capabilities/capability-tools.js"
import { registerCapabilityHealthTool } from "../tools/capabilities/health-tool.js"
import { registerCatalogTools } from "../tools/catalog/catalog-tools.js"
import { LazyBuiltinTools } from "../tools/catalog/lazy-builtin-tools.js"
import {
  registerFileEditTool,
  registerFileReadTool,
  registerFileWriteTool,
} from "../tools/file/file-tools.js"
import { registerGoalTools } from "../tools/goals/goal-tools.js"
import { registerImageTools } from "../tools/image/image-tools.js"
import { registerJobTools } from "../tools/jobs/job-tools.js"
import { registerMcpServerManagementTools } from "../tools/mcp-server-management/mcp-server-management-tools.js"
import { registerNodeTools } from "../tools/nodes/node-tools.js"
import { registerProjectTools } from "../tools/projects/project-tools.js"
import { registerProviderTools } from "../tools/providers/provider-tools.js"
import { RuleCatalog } from "../tools/rules/rule-catalog.js"
import { registerRuleTools } from "../tools/rules/rule-tools.js"
import { registerSearchTools } from "../tools/search/search-tools.js"
import type { BashProcessManager } from "../tools/shell/bash-process-manager.js"
import { registerBashProcessTool } from "../tools/shell/bash-process-tool.js"
import { registerBashTool } from "../tools/shell/bash-tool.js"
import {
  type InteractiveShellManager,
  registerTerminalTool,
} from "../tools/shell/interactive-shell.js"
import { registerSkillTools } from "../tools/skills/skill-tools.js"
import { registerStartHereTool } from "../tools/start-here/start-here.js"
import { registerStoreTools } from "../tools/store/store-tools.js"
import { registerSmartRoutingTools } from "../tools/subagents/router-tools.js"
import { registerSubagentTools } from "../tools/subagents/subagent-tools.js"
import { registerAgentTeamTools } from "../tools/teams/team-tools.js"
import { registerToolboxManagementTools } from "../tools/toolbox-management/toolbox-management-tools.js"
import type { WebPageOpener } from "../tools/web/web-open.js"
import { registerWebTool } from "../tools/web/web-tool.js"
import { registerWorkflowTools } from "../tools/workflows/workflow-tools.js"
import type { WorkflowService } from "../workflows/workflow-service.js"
import { installToolRegistrationBoundary } from "./tool-registration-boundary.js"

export interface CreateMcpServerOptions {
  externalMcp?: ExternalMcpRegistry
  toolboxRegistry?: ToolboxRegistry
  interactiveShellManager?: InteractiveShellManager
  bashProcessManager?: BashProcessManager
  webPageOpener?: WebPageOpener
  subagentRuntime?: SubagentRuntime
  jobManager?: JobManager
  goalRegistry?: GoalRegistry
  goalScope?: GoalScope
  capabilityHealth?: CapabilityHealthService
  capabilityRegistry?: CapabilityRegistry
  capabilityStore?: CapabilityStoreService
  providerHub?: ProviderHub
  smartRouter?: SmartModelRouter
  projectRegistry?: ProjectRegistry
  projectScope?: ProjectScope
  agentTeams?: AgentTeamService
  workflows?: WorkflowService
  nodes?: NodeRegistry
  auditRequest?: McpAuditRequest
  agentObserver?: AgentObserver
}

export interface McpCapabilityServices {
  externalMcp?: ExternalMcpRegistry
  toolboxRegistry?: ToolboxRegistry
  interactiveShellManager?: InteractiveShellManager
  bashProcessManager?: BashProcessManager
  webPageOpener?: WebPageOpener
  subagentRuntime?: SubagentRuntime
  jobManager?: JobManager
  goalRegistry?: GoalRegistry
  goalScope?: GoalScope
  capabilityHealth?: CapabilityHealthService
  capabilityRegistry?: CapabilityRegistry
  capabilityStore?: CapabilityStoreService
  providerHub?: ProviderHub
  smartRouter?: SmartModelRouter
  projectRegistry?: ProjectRegistry
  projectScope?: ProjectScope
  agentTeams?: AgentTeamService
  workflows?: WorkflowService
  nodes?: NodeRegistry
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

  let lazyBuiltins: LazyBuiltinTools | undefined
  if (options.toolboxRegistry) {
    lazyBuiltins = new LazyBuiltinTools()
    registerToolboxRuntime(server, options, options.toolboxRegistry, lazyBuiltins)
  } else {
    registerDirectRuntime(server, options, profile)
  }
  if (options.toolboxRegistry && options.externalMcp) {
    registerCatalogTools(server, options.toolboxRegistry, options.externalMcp, lazyBuiltins)
  } else {
    options.externalMcp?.registerTools(server)
  }

  return server
}

function registerToolboxRuntime(
  server: McpServer,
  options: CreateMcpServerOptions,
  registry: ToolboxRegistry,
  lazyBuiltins: LazyBuiltinTools
): void {
  const capabilityRegistry = options.capabilityRegistry
  const ruleCatalog = new RuleCatalog(MCP_CONFIG.rules.root)
  const lazyServer = lazyBuiltins.server()
  registerConfiguredBuiltin(server, lazyServer, registry, "system", (target) => {
    registerStartHereTool(
      target,
      capabilityRegistry ? () => capabilityRegistry.list() : undefined,
      options.projectScope,
      options.goalScope,
      () => ruleCatalog.alwaysApplied()
    )
    if (capabilityRegistry) registerCapabilityTools(target, capabilityRegistry)
    if (options.capabilityHealth) registerCapabilityHealthTool(target, options.capabilityHealth)
  })
  registerConfiguredBuiltin(server, lazyServer, registry, "shell", (target) => {
    registerBashTool(target, options.bashProcessManager, options.projectScope)
    if (options.bashProcessManager) registerBashProcessTool(target, options.bashProcessManager)
    if (options.interactiveShellManager)
      registerTerminalTool(target, options.interactiveShellManager, options.projectScope)
  })
  registerConfiguredBuiltin(server, lazyServer, registry, "files", (target) => {
    if (isApplyPatchSupported()) registerApplyPatchTool(target, options.projectScope)
    registerFileReadTool(target, options.projectScope)
    registerFileWriteTool(target, options.projectScope)
    registerFileEditTool(target, options.projectScope)
  })
  registerConfiguredBuiltin(server, lazyServer, registry, "web", (target) =>
    registerWebTool(target, requireCapabilityService(options.webPageOpener, "web"))
  )
  registerConfiguredBuiltin(server, lazyServer, registry, "skills", (target) =>
    registerSkillTools(target, registry)
  )
  registerConfiguredBuiltin(server, lazyServer, registry, "rules", (target) =>
    registerRuleTools(target)
  )
  registerConfiguredBuiltin(server, lazyServer, registry, "media", (target) =>
    registerImageTools(target, options.projectScope)
  )
  registerConfiguredBuiltin(server, lazyServer, registry, "search", (target) =>
    registerSearchTools(target, options.projectScope)
  )
  registerPlatformTools(server, lazyServer, options, registry)

  const subagentRuntime = options.subagentRuntime
  if (subagentRuntime)
    registerConfiguredBuiltin(server, lazyServer, registry, "subagents", (target) => {
      registerSubagentTools(target, subagentRuntime)
      if (options.smartRouter) registerSmartRoutingTools(target, options.smartRouter)
    })
  registry.registerCustomTools(server)
}

function registerPlatformTools(
  server: McpServer,
  lazyServer: McpServer,
  options: CreateMcpServerOptions,
  registry: ToolboxRegistry
): void {
  const jobManager = options.jobManager
  if (jobManager)
    registerConfiguredBuiltin(server, lazyServer, registry, "jobs", (target) =>
      registerJobTools(target, jobManager, options.projectScope)
    )
  const projectRegistry = options.projectRegistry
  if (projectRegistry)
    registerConfiguredBuiltin(server, lazyServer, registry, "projects", (target) =>
      registerProjectTools(target, projectRegistry, options.projectScope)
    )
  const goalRegistry = options.goalRegistry
  if (goalRegistry)
    registerConfiguredBuiltin(server, lazyServer, registry, "goals", (target) =>
      registerGoalTools(target, goalRegistry, options.goalScope)
    )
  registerConfiguredBuiltin(server, lazyServer, registry, "toolbox-manager", (target) =>
    registerToolboxManagementTools(target, registry)
  )
  registerConfiguredBuiltin(server, lazyServer, registry, "mcp-manager", (target) =>
    registerMcpServerManagementTools(target, MCP_CONFIG.externalMcp.configFile, options.externalMcp)
  )
  const capabilityStore = options.capabilityStore
  if (capabilityStore)
    registerConfiguredBuiltin(server, lazyServer, registry, "store", (target) =>
      registerStoreTools(target, capabilityStore, registry)
    )
  const providerHub = options.providerHub
  if (providerHub)
    registerConfiguredBuiltin(server, lazyServer, registry, "providers", (target) =>
      registerProviderTools(target, providerHub)
    )
  const agentTeams = options.agentTeams
  if (agentTeams)
    registerConfiguredBuiltin(server, lazyServer, registry, "teams", (target) =>
      registerAgentTeamTools(target, agentTeams)
    )
  const workflows = options.workflows
  if (workflows)
    registerConfiguredBuiltin(server, lazyServer, registry, "workflows", (target) =>
      registerWorkflowTools(target, workflows)
    )
  const nodes = options.nodes
  if (nodes)
    registerConfiguredBuiltin(server, lazyServer, registry, "nodes", (target) =>
      registerNodeTools(target, nodes)
    )
}

function registerDirectRuntime(
  server: McpServer,
  options: CreateMcpServerOptions,
  profile: McpRuntimeProfile
): void {
  const capabilityRegistry = options.capabilityRegistry
  const ruleCatalog = new RuleCatalog(MCP_CONFIG.rules.root)
  registerStartHereTool(
    server,
    capabilityRegistry ? () => capabilityRegistry.list() : undefined,
    options.projectScope,
    options.goalScope,
    () => ruleCatalog.alwaysApplied()
  )
  if (capabilityRegistry) registerCapabilityTools(server, capabilityRegistry)
  if (options.capabilityHealth) registerCapabilityHealthTool(server, options.capabilityHealth)
  if (profile.tools.shell) {
    registerBashTool(server, options.bashProcessManager, options.projectScope)
    if (options.bashProcessManager) registerBashProcessTool(server, options.bashProcessManager)
    if (options.interactiveShellManager)
      registerTerminalTool(server, options.interactiveShellManager, options.projectScope)
  }
  if (profile.tools.applyPatch && isApplyPatchSupported())
    registerApplyPatchTool(server, options.projectScope)
  if (profile.tools.fileRead) registerFileReadTool(server, options.projectScope)
  if (profile.tools.fileWrite) registerFileWriteTool(server, options.projectScope)
  if (profile.tools.fileWrite) registerFileEditTool(server, options.projectScope)
  if (profile.tools.web)
    registerWebTool(server, requireCapabilityService(options.webPageOpener, "web"))
  if (profile.tools.skills) registerSkillTools(server, options.toolboxRegistry)
  registerRuleTools(server)
  if (profile.tools.image) registerImageTools(server, options.projectScope)
  registerDirectPlatformTools(server, options)
}

function registerDirectPlatformTools(server: McpServer, options: CreateMcpServerOptions): void {
  if (options.jobManager) registerJobTools(server, options.jobManager, options.projectScope)
  if (options.projectRegistry)
    registerProjectTools(server, options.projectRegistry, options.projectScope)
  if (options.goalRegistry) registerGoalTools(server, options.goalRegistry, options.goalScope)
  if (options.capabilityStore)
    registerStoreTools(server, options.capabilityStore, options.toolboxRegistry)
  if (options.providerHub) registerProviderTools(server, options.providerHub)
  if (options.smartRouter) registerSmartRoutingTools(server, options.smartRouter)
  if (options.agentTeams) registerAgentTeamTools(server, options.agentTeams)
  if (options.workflows) registerWorkflowTools(server, options.workflows)
  if (options.nodes) registerNodeTools(server, options.nodes)
}

function registerConfiguredBuiltin(
  server: McpServer,
  lazyServer: McpServer,
  registry: ToolboxRegistry,
  toolboxId: string,
  register: (target: McpServer) => void
): void {
  const target = registry.isToolboxDynamic(toolboxId) ? lazyServer : server
  registerBuiltinToolbox(target, registry, toolboxId, () => register(target))
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
