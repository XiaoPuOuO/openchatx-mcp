import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createAgentObserver } from "./agent/observer.js"
import { OpenChatXAuthStore } from "./auth/store.js"
import { MCP_CONFIG } from "./config.js"
import { createExternalMcpRegistry } from "./external-mcp/registry.js"
import { createMcpServerFactory } from "./mcp/server-factory.js"
import { McpAuditLogger } from "./server/audit/audit-log.js"
import { startMcpHttpServer } from "./server/http-server.js"
import { loadSubagentConfig } from "./subagents/config.js"
import { SubagentRuntime } from "./subagents/runtime.js"
import { ToolboxRegistry } from "./toolbox/registry.js"
import { InteractiveShellManager } from "./tools/shell/interactive-shell.js"
import { createShellSession } from "./tools/shell/session.js"
import { createShellSessionManager } from "./tools/shell/session-manager.js"
import { WebPageOpener } from "./tools/web/web-open.js"

const auditLogPath = fileURLToPath(new URL("../agent-commands.yaml", import.meta.url))
const auditLogger = new McpAuditLogger(auditLogPath)
const agentObserver = createAgentObserver()
const authPath = join(MCP_CONFIG.stateDir, "auth.json")
const authStore = new OpenChatXAuthStore(authPath)
await authStore.ensureState()
const webPageOpener = new WebPageOpener()
const externalMcp = await createExternalMcpRegistry(MCP_CONFIG.externalMcp.configFile)
const subagentRuntime = new SubagentRuntime(loadSubagentConfig(MCP_CONFIG.subagents.configFile))
const toolboxRegistry = new ToolboxRegistry(MCP_CONFIG.toolboxes.root)
await toolboxRegistry.start()
const interactiveShellManager = new InteractiveShellManager(
  MCP_CONFIG.workspace,
  MCP_CONFIG.shell.path
)

const shells = createShellSessionManager({
  createShell: (initialState) => createShellSession({ cwd: MCP_CONFIG.workspace, initialState }),
})

let running: Awaited<ReturnType<typeof startMcpHttpServer>>
try {
  await shells?.startDefault()
  running = await startMcpHttpServer({
    createMcpServer: createMcpServerFactory({
      shellManager: shells,
      externalMcp,
      toolboxRegistry,
      interactiveShellManager,
      webPageOpener,
      subagentRuntime,
    }),
    auditLogger,
    authStore,
    agentObserver,
    toolboxRegistry,
    subagentRuntime,
  })
} catch (error) {
  await closeRuntimeServices()
  throw error
}
console.log(`Local shell MCP server: ${running.url}`)
console.log(`Agent dashboard: http://${running.host}:${running.port}/ui`)
console.log("Remote MCP authentication: trusted ChatGPT origin + bound OpenAI subject")
console.log(`Default workspace: ${MCP_CONFIG.workspace}`)
console.log(
  `Shell tools: ${shells ? `enabled (${MCP_CONFIG.shell.path}, max ${shells.maximumShells})` : "disabled"}`
)
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
    shells.close(),
    interactiveShellManager.close(),
    externalMcp.close(),
    toolboxRegistry.close(),
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
