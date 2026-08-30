import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

import { MCP_CONFIG } from "../src/config.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { countTokens, OUTPUT_TOKEN_ENCODING } from "../src/tokenizer.js"
import { createShellSession } from "../src/tools/shell/session.js"
import { createShellSessionManager } from "../src/tools/shell/session-manager.js"

const requestedNames = new Set(process.argv.slice(2))
const shells = createShellSessionManager({
  createShell: () => createShellSession({ cwd: MCP_CONFIG.workspace }),
})
const running = await startMcpHttpServer({ host: "127.0.0.1", port: 0, shellManager: shells })
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
}
