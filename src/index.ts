import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createAgentObserver } from "./agent/observer.js"
import { OpenChatXAuthStore } from "./auth/store.js"
import { CapabilityRegistry } from "./capabilities/catalog.js"
import { CapabilityHealthService } from "./capabilities/health.js"
import { MCP_CONFIG } from "./config.js"
import { createExternalMcpRegistry } from "./external-mcp/registry.js"
import { GoalRegistry } from "./goals/goal-registry.js"
import { GoalScope } from "./goals/goal-scope.js"
import { JobManager } from "./jobs/job-manager.js"
import { createMcpServerFactory } from "./mcp/server-factory.js"
import { NodeRegistry } from "./nodes/node-registry.js"
import { PlatformOverviewService } from "./platform/overview.js"
import { ProjectRegistry } from "./projects/project-registry.js"
import { ProjectScope } from "./projects/project-scope.js"
import { ProviderHub } from "./providers/provider-hub.js"
import { McpAuditLogger } from "./server/audit/audit-log.js"
import { startMcpHttpServer } from "./server/http-server.js"
import { GithubCommunityStore } from "./store/github-community-store.js"
import { CapabilityStoreService } from "./store/store-service.js"
import { loadSubagentConfig } from "./subagents/config.js"
import { SmartModelRouter } from "./subagents/router.js"
import { SubagentRuntime } from "./subagents/runtime.js"
import { SummaryRegistry } from "./summaries/summary-registry.js"
import { AgentTeamService } from "./teams/team-service.js"
import { ToolboxRegistry } from "./toolbox/registry.js"
import { BashProcessManager } from "./tools/shell/bash-process-manager.js"
import { InteractiveShellManager } from "./tools/shell/interactive-shell.js"
import { WebPageOpener } from "./tools/web/web-open.js"
import { WorkflowService } from "./workflows/workflow-service.js"

const auditLogPath =
  process.env.OPENCHATX_AUDIT_LOG?.trim() ||
  fileURLToPath(new URL("../agent-commands.yaml", import.meta.url))
const auditLogger = new McpAuditLogger(auditLogPath)
const agentObserver = createAgentObserver()
const authPath = join(MCP_CONFIG.stateDir, "auth.json")
const authStore = new OpenChatXAuthStore(authPath)
await authStore.ensureState()
const webPageOpener = new WebPageOpener()
const externalMcp = await createExternalMcpRegistry(MCP_CONFIG.externalMcp.configFile)
const subagentRuntime = new SubagentRuntime(loadSubagentConfig(MCP_CONFIG.subagents.configFile))
subagentRuntime.startWatching(MCP_CONFIG.subagents.configFile)
const toolboxRegistry = new ToolboxRegistry(MCP_CONFIG.toolboxes.root)
await toolboxRegistry.start()
const interactiveShellManager = new InteractiveShellManager(
  MCP_CONFIG.defaultCwd,
  MCP_CONFIG.shell.path
)
const bashProcessManager = new BashProcessManager()
const jobManager = new JobManager()
const projectRegistry = new ProjectRegistry()
const projectScope = new ProjectScope(projectRegistry)
const goalRegistry = new GoalRegistry()
const goalScope = new GoalScope(goalRegistry, projectScope)
const summaryRegistry = new SummaryRegistry()
const capabilityRegistry = new CapabilityRegistry(externalMcp, toolboxRegistry, subagentRuntime)
const capabilityHealth = new CapabilityHealthService(externalMcp, toolboxRegistry, subagentRuntime)
const communityStore = new GithubCommunityStore()
const capabilityStore = new CapabilityStoreService(
  MCP_CONFIG.store.catalogFile,
  MCP_CONFIG.store.bundleRoot,
  MCP_CONFIG.toolboxes.root,
  toolboxRegistry,
  MCP_CONFIG.stateDir,
  communityStore
)
const providerHub = new ProviderHub(MCP_CONFIG.subagents.configFile, subagentRuntime)
const smartRouter = new SmartModelRouter(MCP_CONFIG.subagents.configFile, subagentRuntime)
const agentTeams = new AgentTeamService(subagentRuntime)
const workflows = new WorkflowService({
  toolboxes: toolboxRegistry,
  externalMcp,
  subagents: subagentRuntime,
  teams: agentTeams,
  jobs: jobManager,
  projectScope,
})
const nodes = new NodeRegistry()
const platformOverview = new PlatformOverviewService({
  capabilities: capabilityRegistry,
  health: capabilityHealth,
  jobs: jobManager,
  projects: projectRegistry,
  store: capabilityStore,
  subagents: subagentRuntime,
  teams: agentTeams,
  workflows,
  nodes,
  agents: agentObserver,
})

let running: Awaited<ReturnType<typeof startMcpHttpServer>>
try {
  running = await startMcpHttpServer({
    createMcpServer: createMcpServerFactory({
      externalMcp,
      toolboxRegistry,
      interactiveShellManager,
      bashProcessManager,
      webPageOpener,
      subagentRuntime,
      jobManager,
      capabilityHealth,
      capabilityRegistry,
      capabilityStore,
      providerHub,
      smartRouter,
      projectRegistry,
      projectScope,
      goalRegistry,
      goalScope,
      summaryRegistry,
      agentTeams,
      workflows,
      nodes,
    }),
    auditLogger,
    authStore,
    agentObserver,
    toolboxRegistry,
    subagentRuntime,
    externalMcp,
    capabilityHealth,
    capabilityRegistry,
    capabilityStore,
    platformOverview,
    projectRegistry,
    summaryRegistry,
  })
} catch (error) {
  await closeRuntimeServices()
  throw error
}
console.log(`Local shell MCP server: ${running.url}`)
console.log(`Agent dashboard: http://${running.host}:${running.port}/ui`)
console.log("Remote MCP authentication: trusted ChatGPT origin + bound OpenAI subject")
console.log(`Default cwd: ${MCP_CONFIG.defaultCwd}`)
console.log(`Agent instructions: ${MCP_CONFIG.agentInstructionsFile}`)
console.log(`Shell tools: bash + terminal (${MCP_CONFIG.shell.path})`)
console.log(`Agent MCP audit log: ${auditLogPath}`)
console.log(
  `External MCPs: ${externalMcp.connectedServers.length} connected, ${externalMcp.toolCount} tools`
)
console.log(`Toolboxes: ${toolboxRegistry.snapshots().length} loaded`)

let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; shutting down.`)
  try {
    await running.close()
  } finally {
    await closeRuntimeServices()
  }
}

async function closeRuntimeServices(): Promise<void> {
  await Promise.allSettled([
    interactiveShellManager.close(),
    bashProcessManager.close(),
    externalMcp.close(),
    toolboxRegistry.close(),
    subagentRuntime.close(),
    jobManager.close(),
  ])
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error) => {
        console.error("Shutdown failed:", error)
        process.exit(1)
      }
    )
  })
}
