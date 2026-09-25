import process from "node:process"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { CapabilityRegistry } from "../src/capabilities/catalog.js"
import { CapabilityHealthService } from "../src/capabilities/health.js"
import { MCP_CONFIG } from "../src/config.js"
import { createExternalMcpRegistry } from "../src/external-mcp/registry.js"
import { GoalRegistry } from "../src/goals/goal-registry.js"
import { GoalScope } from "../src/goals/goal-scope.js"
import { JobManager } from "../src/jobs/job-manager.js"
import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { NodeRegistry } from "../src/nodes/node-registry.js"
import { ProjectRegistry } from "../src/projects/project-registry.js"
import { ProjectScope } from "../src/projects/project-scope.js"
import { ProviderHub } from "../src/providers/provider-hub.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { GithubCommunityStore } from "../src/store/github-community-store.js"
import { CapabilityStoreService } from "../src/store/store-service.js"
import { loadSubagentConfig } from "../src/subagents/config.js"
import { SmartModelRouter } from "../src/subagents/router.js"
import { SubagentRuntime } from "../src/subagents/runtime.js"
import { AgentTeamService } from "../src/teams/team-service.js"
import { countTokens, OUTPUT_TOKEN_ENCODING } from "../src/tokenizer.js"
import { ToolboxRegistry } from "../src/toolbox/registry.js"
import { BashProcessManager } from "../src/tools/shell/bash-process-manager.js"
import { InteractiveShellManager } from "../src/tools/shell/interactive-shell.js"
import { WebPageOpener } from "../src/tools/web/web-open.js"
import { WorkflowService } from "../src/workflows/workflow-service.js"

const requestedNames = new Set(process.argv.slice(2))
const externalMcp = await createExternalMcpRegistry(MCP_CONFIG.externalMcp.configFile)
const toolboxRegistry = new ToolboxRegistry(MCP_CONFIG.toolboxes.root)
await toolboxRegistry.start()
const interactiveShellManager = new InteractiveShellManager(
  MCP_CONFIG.defaultCwd,
  MCP_CONFIG.shell.path
)
const bashProcessManager = new BashProcessManager()
const subagentRuntime = new SubagentRuntime(loadSubagentConfig(MCP_CONFIG.subagents.configFile))
const webPageOpener = new WebPageOpener()
const jobManager = new JobManager()
const projectRegistry = new ProjectRegistry()
const projectScope = new ProjectScope(projectRegistry)
const goalRegistry = new GoalRegistry()
const goalScope = new GoalScope(goalRegistry, projectScope)
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
const running = await startMcpHttpServer(
  {
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
      agentTeams,
      workflows,
      nodes,
    }),
  },
  { port: 0 }
)
const client = new Client(
  { name: "openchatx-mcp-schema-viewer", version: MCP_CONFIG.server.version },
  { versionNegotiation: { mode: "auto" } }
)
const transport = new StreamableHTTPClientTransport(new URL(running.url))

try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  const selected =
    requestedNames.size === 0 ? tools : tools.filter((tool) => requestedNames.has(tool.name))

  if (requestedNames.size > 0) {
    const foundNames = new Set(selected.map((tool) => tool.name))
    const missing = [...requestedNames].filter((name) => !foundNames.has(name))
    if (missing.length > 0) {
      throw new Error(`Unknown tool${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`)
    }
  }

  const compactSchema = JSON.stringify(selected)
  process.stdout.write(
    `Tool count: ${selected.length}\nToken count (${OUTPUT_TOKEN_ENCODING}): ${countTokens(compactSchema)}\n\n${JSON.stringify(selected, null, 2)}\n`
  )
} finally {
  await client.close().catch(() => undefined)
  await running.close()
  await Promise.allSettled([
    interactiveShellManager.close(),
    bashProcessManager.close(),
    toolboxRegistry.close(),
    externalMcp.close(),
    subagentRuntime.close(),
    jobManager.close(),
  ])
}
