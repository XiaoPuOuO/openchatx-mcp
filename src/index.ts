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

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const auditLogPath = resolve(repositoryRoot, "agent-commands.yaml")
const auditLogger = new McpAuditLogger(auditLogPath)
const authStore = new ShellbyAuthStore()
await authStore.ensureState()
const cwd = MCP_CONFIG.workspace
const chatGptSubagents = createChatGptSubagentService()
const cursorHost = new CursorHostManager({ executable: MCP_CONFIG.peekaboo.cursorHostExecutable })
const cursorHostStarted = cursorHost.start()

const shells = createShellSessionManager({
  createShell: (initialState) => createShellSession({ cwd, initialState }),
})

let running: Awaited<ReturnType<typeof startMcpHttpServer>>
try {
  running = await startMcpHttpServer({
    shellManager: shells,
    chatGptSubagents,
    auditLogger,
    authStore,
  })
} catch (error) {
  await cursorHost.close()
  throw error
}
console.log(`Local shell MCP server: ${running.url}`)
console.log("Remote MCP authentication: trusted ChatGPT origin + bound OpenAI subject")
console.log(`Shell: ${MCP_CONFIG.shell.path}`)
console.log(`Default workspace: ${cwd}`)
console.log(`Maximum live shells: ${shells.maximumShells}`)
console.log(`Agent MCP audit log: ${auditLogPath}`)
console.log(`Computer Use: Peekaboo CLI (${MCP_CONFIG.peekaboo.executable})`)
console.log(`Agent cursor: ${cursorHostStarted ? "enabled" : "disabled"}`)
console.log(`ChatGPT Subagents: attach-only CDP ${MCP_CONFIG.chatGpt.cdpEndpoint}`)

let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; shutting down.`)
  await Promise.all([running.close(), cursorHost.close()])
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
