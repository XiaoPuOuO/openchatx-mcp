import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import {
  renderInputSchema,
  renderOutputSchema,
  validateToolsList,
} from "json-schema-to-openai-typescript"

import { MCP_CONFIG } from "../src/config.js"
import type { ExternalMcpRegistry } from "../src/external-mcp/registry.js"
import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { SubagentRuntime } from "../src/subagents/runtime.js"
import { ToolboxRegistry } from "../src/toolbox/registry.js"
import { BashProcessManager } from "../src/tools/shell/bash-process-manager.js"
import { InteractiveShellManager } from "../src/tools/shell/interactive-shell.js"
import { WebPageOpener } from "../src/tools/web/web-open.js"

const DEGRADED_OPENAI_TYPE = /(?<!["'])\b(?:any|unknown)\b(?!["'])/u
const REPOSITORY_ROOT = join(import.meta.dirname, "..")

test("published OpenChatX schemas stay OpenAI-compatible", { timeout: 20_000 }, async () => {
  for (const toolOutput of ["compact", "structured"] as const) {
    const toolboxes = new ToolboxRegistry(join(REPOSITORY_ROOT, "toolboxes"))
    await toolboxes.reload()
    const terminal = new InteractiveShellManager(MCP_CONFIG.workspace, MCP_CONFIG.shell.path)
    const bashProcesses = new BashProcessManager(
      join(REPOSITORY_ROOT, ".tmp-schema-bash-processes")
    )
    const externalMcp = emptyExternalMcpRegistry()
    const running = await startMcpHttpServer(
      {
        createMcpServer: createMcpServerFactory(
          {
            toolboxRegistry: toolboxes,
            interactiveShellManager: terminal,
            bashProcessManager: bashProcesses,
            externalMcp,
            webPageOpener: new WebPageOpener(),
            subagentRuntime: new SubagentRuntime({ providers: {}, models: {} }),
          },
          { toolOutput }
        ),
      },
      { port: 0 }
    )
    const client = new Client({ name: `schema-${toolOutput}`, version: "1.0.0" })
    const transport = new StreamableHTTPClientTransport(new URL(running.url))

    try {
      await client.connect(transport)
      const tools = await client.listTools()
      const validation = validateToolsList(tools)
      const issues = validation.tools.flatMap((tool) =>
        tool.issues.map(
          (issue) =>
            `${tool.name} ${issue.path}: ${issue.code} (${issue.severity}) ${issue.message}`
        )
      )
      assert.deepEqual(issues, [], `${toolOutput} schemas failed OpenAI compatibility validation`)

      for (const tool of tools.tools) {
        assertNoDegradedType(tool.name, "input", renderInputSchema(tool.inputSchema))
        if (tool.outputSchema) {
          assertNoDegradedType(tool.name, "output", renderOutputSchema(tool.outputSchema))
        }
      }
    } finally {
      await client.close().catch(() => undefined)
      await running.close()
      await terminal.close()
      await bashProcesses.close()
      await externalMcp.close()
    }
  }
})

function assertNoDegradedType(toolName: string, kind: string, rendered: string): void {
  const typeOnly = rendered.replace(/\/\/.*$/gmu, "")
  assert.doesNotMatch(
    typeOnly,
    DEGRADED_OPENAI_TYPE,
    `${toolName} ${kind} schema degraded when rendered for OpenAI:\n${rendered}`
  )
}

function emptyExternalMcpRegistry(): ExternalMcpRegistry {
  return {
    connectedServers: [],
    toolCount: 0,
    capabilities: () => [],
    registerTools() {},
    catalog: () => [],
    call: async () => {
      throw new Error("No external MCP tools are configured in this test.")
    },
    close: async () => {},
  }
}
