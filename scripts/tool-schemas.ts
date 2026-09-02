import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

import { MCP_CONFIG } from "../src/config.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { countTokens, OUTPUT_TOKEN_ENCODING } from "../src/tokenizer.js"
import { PeekabooClient } from "../src/tools/computer/peekaboo.js"
import { createShellSession } from "../src/tools/shell/session.js"
import { createShellSessionManager } from "../src/tools/shell/session-manager.js"
import { createChatGptSubagentService } from "../src/tools/subagent/chatgpt-subagent.js"
import { WebPageOpener } from "../src/tools/web/web-open.js"

const requestedNames = new Set(process.argv.slice(2))
MCP_CONFIG.port = 0
const shells = MCP_CONFIG.tools.shell
  ? createShellSessionManager({
      createShell: () => createShellSession({ cwd: MCP_CONFIG.workspace }),
    })
  : undefined
const peekaboo = MCP_CONFIG.tools.computer ? new PeekabooClient({ localOnly: true }) : undefined
const chatGptSubagents = MCP_CONFIG.tools.clones || MCP_CONFIG.tools.subagents ? createChatGptSubagentService() : undefined
const webPageOpener = MCP_CONFIG.tools.web ? new WebPageOpener() : undefined
const running = await startMcpHttpServer({
  shellManager: shells,
  peekaboo,
  chatGptSubagents,
  webPageOpener,
})
const client = new Client({ name: "shellby-mcp-schema-viewer", version: MCP_CONFIG.server.version }, { versionNegotiation: { mode: "auto" } })
const transport = new StreamableHTTPClientTransport(new URL(running.url))

try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  const selected = requestedNames.size === 0 ? tools : tools.filter((tool) => requestedNames.has(tool.name))

  if (requestedNames.size > 0) {
    const foundNames = new Set(selected.map((tool) => tool.name))
    const missing = [...requestedNames].filter((name) => !foundNames.has(name))
    if (missing.length > 0) {
      throw new Error(`Unknown tool${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`)
    }
  }

  const compactSchema = JSON.stringify(selected)
  process.stdout.write(`Token count (${OUTPUT_TOKEN_ENCODING}): ${countTokens(compactSchema)}\n\n${JSON.stringify(selected, null, 2)}\n`)
} finally {
  await client.close().catch(() => undefined)
  await running.close()
  await Promise.allSettled([shells?.close() ?? Promise.resolve(), peekaboo?.close() ?? Promise.resolve(), chatGptSubagents?.dispose() ?? Promise.resolve()])
}
