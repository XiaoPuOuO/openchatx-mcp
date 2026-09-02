import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { ShellbyAuthStore } from "./auth/auth.js"
import { MCP_CONFIG } from "./config.js"
import { createChatGptSubagentService } from "./tools/subagent/chatgpt-subagent.js"
import { McpAuditLogger } from "./server/audit/audit-log.js"
import { createShellSession } from "./tools/shell/session.js"
import { createShellSessionManager } from "./tools/shell/session-manager.js"
import { startMcpHttpServer } from "./server/http-server.js"
import { CursorHostManager } from "./tools/computer/cursor-host.js"
import { PeekabooClient } from "./tools/computer/peekaboo.js"
import { WebPageOpener } from "./tools/web/web-open.js"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const auditLogPath = resolve(repositoryRoot, "agent-commands.yaml")
const auditLogger = new McpAuditLogger(auditLogPath)
const authStore = new ShellbyAuthStore()
await authStore.ensureState()
const cwd = MCP_CONFIG.workspace
const chatGptSubagents = MCP_CONFIG.tools.clones || MCP_CONFIG.tools.subagents ? createChatGptSubagentService() : undefined
const peekaboo = MCP_CONFIG.tools.computer ? new PeekabooClient({ localOnly: true }) : undefined
const webPageOpener = MCP_CONFIG.tools.web ? new WebPageOpener() : undefined
const cursorHost = MCP_CONFIG.tools.computer ? new CursorHostManager({ executable: MCP_CONFIG.peekaboo.cursorHostExecutable }) : undefined
const cursorHostStarted = cursorHost?.start() ?? false

const shells = MCP_CONFIG.tools.shell
  ? createShellSessionManager({
      createShell: (initialState) => createShellSession({ cwd, initialState }),
    })
  : undefined

let running: Awaited<ReturnType<typeof startMcpHttpServer>>
try {
  await shells?.startDefault()
  running = await startMcpHttpServer({
    shellManager: shells,
    peekaboo,
    chatGptSubagents,
    auditLogger,
    authStore,
    webPageOpener,
  })
} catch (error) {
  await closeRuntimeServices()
  throw error
}
console.log(`Local shell MCP server: ${running.url}`)
console.log("Remote MCP authentication: trusted ChatGPT origin + bound OpenAI subject")
console.log(`Default workspace: ${cwd}`)
console.log(`Shell tools: ${shells ? `enabled (${MCP_CONFIG.shell.path}, max ${shells.maximumShells})` : "disabled"}`)
console.log(`Agent MCP audit log: ${auditLogPath}`)
console.log(`Computer Use: ${peekaboo ? `enabled via Peekaboo CLI (${MCP_CONFIG.peekaboo.executable})` : "disabled"}`)
if (peekaboo) console.log(`Agent cursor: ${cursorHostStarted ? "enabled" : "disabled"}`)
console.log(`ChatGPT agents: ${chatGptSubagents ? `enabled via attach-only CDP ${MCP_CONFIG.chatGpt.cdpEndpoint}` : "disabled"}`)

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
    shells?.close() ?? Promise.resolve(),
    peekaboo?.close() ?? Promise.resolve(),
    chatGptSubagents?.dispose() ?? Promise.resolve(),
    cursorHost?.close() ?? Promise.resolve(),
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
