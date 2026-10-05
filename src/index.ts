import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createAgentObserver } from "./agent/observer.js"
import { CapabilityRegistry } from "./capabilities/catalog.js"
import { CapabilityHealthService } from "./capabilities/health.js"
import { MCP_CONFIG } from "./config.js"
import { createExternalMcpRegistry } from "./external-mcp/registry.js"
import { GoalRegistry } from "./goals/goal-registry.js"
import { GoalScope } from "./goals/goal-scope.js"
import { JobManager } from "./jobs/job-manager.js"
import { ContextBudgetGuard } from "./mcp/context-budget.js"
import { createMcpServerFactory } from "./mcp/server-factory.js"
import { NodeRegistry } from "./nodes/node-registry.js"
import { PlatformOverviewService } from "./platform/overview.js"
import { ProjectRegistry } from "./projects/project-registry.js"
import { ProjectScope } from "./projects/project-scope.js"
import { ProjectWorkspaceService } from "./projects/workspace-snapshot.js"
import { ProviderHub } from "./providers/provider-hub.js"
import { loadOperationalState } from "./recovery/operational-state.js"
import { SystemRecoveryService } from "./recovery/system-recovery.js"
import { runtimeProcessRegistry } from "./runtime/process-registry.js"
import { RuntimeProcessService } from "./runtime/process-service.js"
import { RuntimeControlService } from "./runtime/runtime-control.js"
import { McpAuditLogger } from "./server/audit/audit-log.js"
import { startMcpHttpServer } from "./server/http-server.js"
import { RecentWorkService } from "./sessions/recent-work.js"
import { synchronizeAgentInstructions } from "./state/agent-instructions.js"
import { GithubCommunityStore } from "./store/github-community-store.js"
import { CapabilityStoreService } from "./store/store-service.js"
import { loadSubagentConfig } from "./subagents/config.js"
import { SmartModelRouter } from "./subagents/router.js"
import { SubagentRuntime } from "./subagents/runtime.js"
import { SummaryRegistry } from "./summaries/summary-registry.js"
import { AgentTeamService } from "./teams/team-service.js"
import { timelineRegistry } from "./timeline/timeline-registry.js"
import { ToolboxRegistry } from "./toolbox/registry.js"
import { BashProcessManager } from "./tools/shell/bash-process-manager.js"
import { InteractiveShellManager } from "./tools/shell/interactive-shell.js"
import {
  readBundledAgentTemplate,
  readMigrationBundledAgentTemplate,
} from "./tools/start-here/start-here.js"
import { WebPageOpener } from "./tools/web/web-open.js"
import { WorkflowService } from "./workflows/workflow-service.js"

const auditLogPath =
  process.env.OPENCHATX_AUDIT_LOG?.trim() ||
  fileURLToPath(new URL("../agent-commands.yaml", import.meta.url))
const auditLogger = new McpAuditLogger(auditLogPath)
const contextBudget = new ContextBudgetGuard(
  MCP_CONFIG.context.warningThreshold,
  undefined,
  join(MCP_CONFIG.stateDir, "context-budget.json")
)
await contextBudget.initialize()
const agentObserver = createAgentObserver()
await synchronizeAgentInstructions(
  MCP_CONFIG.stateDir,
  await readBundledAgentTemplate(),
  await readMigrationBundledAgentTemplate()
)
const webPageOpener = new WebPageOpener()
const operationalState = await loadOperationalState()
const safeModeMcpConfig = join(MCP_CONFIG.stateDir, "safe-mode", "mcp-servers.json")
const safeModeToolboxRoot = join(MCP_CONFIG.stateDir, "safe-mode", "toolboxes")
const externalMcp = await createExternalMcpRegistry(
  operationalState.safeMode.enabled ? safeModeMcpConfig : MCP_CONFIG.externalMcp.configFile
)
const subagentRuntime = new SubagentRuntime(loadSubagentConfig(MCP_CONFIG.subagents.configFile))
subagentRuntime.startWatching(MCP_CONFIG.subagents.configFile)
const toolboxRegistry = new ToolboxRegistry(
  operationalState.safeMode.enabled ? safeModeToolboxRoot : MCP_CONFIG.toolboxes.root
)
await toolboxRegistry.start()
const interactiveShellManager = new InteractiveShellManager(
  MCP_CONFIG.defaultCwd,
  MCP_CONFIG.shell.path
)
const bashProcessManager = new BashProcessManager()
const jobManager = new JobManager()
await jobManager.initialize()
const runtimeControl = new RuntimeControlService()
const runtimeProcessId = runtimeProcessRegistry.register({
  kind: "runtime",
  label: "OpenChatX Runtime",
  pid: process.pid,
  detail: `OpenChatX ${MCP_CONFIG.server.version}`,
})
const projectRegistry = new ProjectRegistry()
const projectScope = new ProjectScope(projectRegistry, runtimeControl)
const goalRegistry = new GoalRegistry()
const goalScope = new GoalScope(goalRegistry, projectScope)
const summaryRegistry = new SummaryRegistry()
const projectWorkspaces = new ProjectWorkspaceService(
  projectRegistry,
  goalRegistry,
  toolboxRegistry,
  MCP_CONFIG.externalMcp.configFile,
  () => externalMcp.reload(true)
)
projectScope.setWorkspaceActivator(async (projectId) => {
  await projectWorkspaces.activate(projectId)
})
const recentWork = new RecentWorkService(
  timelineRegistry,
  goalRegistry,
  projectRegistry,
  summaryRegistry
)
const runtimeProcesses = new RuntimeProcessService(
  jobManager,
  bashProcessManager,
  interactiveShellManager
)
const capabilityRegistry = new CapabilityRegistry(externalMcp, toolboxRegistry, subagentRuntime)
const capabilityHealth = new CapabilityHealthService(externalMcp, toolboxRegistry, subagentRuntime)
const systemRecovery = new SystemRecoveryService(capabilityHealth)
process.on("uncaughtExceptionMonitor", (error) => {
  void systemRecovery.recordCrash(error).catch(() => undefined)
})
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
      contextBudget,
      runtimeControl,
    }),
    auditLogger,
    // No authStore: the private Secure MCP Tunnel is the credential on every
    // surface. OpenAI issues different subjects per client app, so subject
    // binding was fragile; tunnel topology replaced it.
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
    contextBudget,
    systemRecovery,
    runtimeControl,
    runtimeProcesses,
    projectWorkspaces,
    recentWork,
    jobManager,
  })
} catch (error) {
  await systemRecovery.recordCrash(error).catch(() => undefined)
  await closeRuntimeServices()
  throw error
}
await systemRecovery.recordHealthyStartup().catch(() => undefined)
console.log(`Local shell MCP server: ${running.url}`)
console.log(`Agent dashboard: http://${running.host}:${running.port}/ui`)
console.log("Remote MCP authentication: private Secure MCP Tunnel topology (per-surface)")
console.log(`Default cwd: ${MCP_CONFIG.defaultCwd}`)
console.log(`Agent instructions: ${MCP_CONFIG.agentInstructionsFile}`)
console.log(`Shell tools: bash + terminal (${MCP_CONFIG.shell.path})`)
console.log(`Agent MCP audit log: ${auditLogPath}`)
console.log(
  `External MCPs: ${externalMcp.connectedServers.length} connected, ${externalMcp.toolCount} tools`
)
console.log(`Toolboxes: ${toolboxRegistry.snapshots().length} loaded`)

let dotRunning: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined
if (MCP_CONFIG.dot.enabled) {
  try {
    dotRunning = await startMcpHttpServer(
      {
        persona: "dot",
        createMcpServer: createMcpServerFactory({
          externalMcp,
          jobManager,
          contextBudget,
          runtimeControl,
          projectRegistry,
          summaryRegistry,
          persona: "dot",
        }),
        auditLogger,
        // No authStore: same tunnel-topology credential as the Chat surface.
        externalMcp,
        contextBudget,
        jobManager,
        agentObserver,
      },
      { port: MCP_CONFIG.dot.port, instanceId: `${MCP_CONFIG.instanceId}-dot` }
    )
    console.log(`Dot persona MCP server: ${dotRunning.url}`)
  } catch (error) {
    console.warn(
      `Dot persona listener failed to start: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; shutting down.`)
  try {
    await running.close()
    if (dotRunning) await dotRunning.close()
  } finally {
    await closeRuntimeServices()
  }
}

async function closeRuntimeServices(): Promise<void> {
  runtimeProcessRegistry.remove(runtimeProcessId)
  await Promise.allSettled([
    interactiveShellManager.close(),
    bashProcessManager.close(),
    externalMcp.close(),
    toolboxRegistry.close(),
    subagentRuntime.close(),
    jobManager.close(),
    contextBudget.close(),
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
