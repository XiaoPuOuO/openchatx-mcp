import process from "node:process"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { MCP_CONFIG } from "../src/config.js"
import { createExternalMcpRegistry } from "../src/external-mcp/registry.js"
import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { loadSubagentConfig } from "../src/subagents/config.js"
import { SubagentRuntime } from "../src/subagents/runtime.js"
import { countTokens, OUTPUT_TOKEN_ENCODING } from "../src/tokenizer.js"
import { ToolboxRegistry } from "../src/toolbox/registry.js"
import { BashProcessManager } from "../src/tools/shell/bash-process-manager.js"
import { InteractiveShellManager } from "../src/tools/shell/interactive-shell.js"
import { WebPageOpener } from "../src/tools/web/web-open.js"

const requestedNames = new Set(process.argv.slice(2))
const externalMcp = await createExternalMcpRegistry(MCP_CONFIG.externalMcp.configFile)
const toolboxRegistry = new ToolboxRegistry(MCP_CONFIG.toolboxes.root)
await toolboxRegistry.start()
const interactiveShellManager = new InteractiveShellManager(
  MCP_CONFIG.workspace,
  MCP_CONFIG.shell.path
)
const bashProcessManager = new BashProcessManager()
const subagentRuntime = new SubagentRuntime(loadSubagentConfig(MCP_CONFIG.subagents.configFile))
const webPageOpener = new WebPageOpener()
const running = await startMcpHttpServer(
  {
    createMcpServer: createMcpServerFactory({
      externalMcp,
      toolboxRegistry,
      interactiveShellManager,
      bashProcessManager,
      webPageOpener,
      subagentRuntime,
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
    `Token count (${OUTPUT_TOKEN_ENCODING}): ${countTokens(compactSchema)}\n\n${JSON.stringify(selected, null, 2)}\n`
  )
} finally {
  await client.close().catch(() => undefined)
  await running.close()
  await Promise.allSettled([
    interactiveShellManager.close(),
    bashProcessManager.close(),
    toolboxRegistry.close(),
    externalMcp.close(),
  ])
}
