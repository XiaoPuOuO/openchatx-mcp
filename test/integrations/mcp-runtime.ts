import assert from "node:assert/strict"
import test from "node:test"

import { createAgentObserver } from "../../src/agent/observer.js"
import { MCP_CONFIG } from "../../src/config.js"
import { createMcpServerFactory } from "../../src/mcp/server-factory.js"
import { startMcpHttpServer as startMcpHttpServerRaw } from "../../src/server/http-server.js"
import { connectClient, startMcpHttpServer, toolText } from "./helpers.js"

test("publishes the assembled MCP tool surface", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "tool-surface-client")
  t.after(() => connected.client.close())

  assert.equal(connected.client.getProtocolEra(), "modern")
  assert.equal(connected.client.getNegotiatedProtocolVersion(), "2026-07-28")
  assert.ok(connected.client.getDiscoverResult())

  const tools = await connected.client.listTools()
  for (const tool of tools.tools) {
    assert.equal(tool.title, undefined)
    assert.equal((tool as unknown as Record<string, unknown>)._meta, undefined)
  }
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "start_here",
      "bash",
      "terminal",
      "apply_patch",
      "file_read",
      "file_write",
      "file_edit",
      "fetch_url",
      "skill_search",
      "skill_load",
      "skill_manage",
      "rule_resolve",
      "rule_load",
      "rule_manage",
      "rule_import",
      "rule_export",
      "image_view",
    ]
  )

  const startHere = tools.tools.find((tool) => tool.name === "start_here")
  assert.ok(startHere)
  assert.deepEqual(
    (startHere.inputSchema.properties as Record<string, Record<string, unknown>>).mode?.enum,
    ["code-review", "coding", "general"]
  )
  assert.deepEqual(Object.keys(startHere.inputSchema.properties ?? {}), [
    "mode",
    "task_id",
    "project_id",
  ])
  const bash = tools.tools.find((tool) => tool.name === "bash")
  const skillLoad = tools.tools.find((tool) => tool.name === "skill_load")
  const ruleManage = tools.tools.find((tool) => tool.name === "rule_manage")
  assert.ok(bash && skillLoad && ruleManage)
  assert.deepEqual(Object.keys(skillLoad.inputSchema.properties ?? {}), ["name"])
  assert.deepEqual(
    (ruleManage.inputSchema.properties as Record<string, Record<string, unknown>>).mode?.enum,
    ["always", "auto_attached", "agent_requested", "manual"]
  )

  const fetchUrl = tools.tools.find((tool) => tool.name === "fetch_url")
  const fileWrite = tools.tools.find((tool) => tool.name === "file_write")
  assert.ok(bash && fetchUrl && fileWrite)

  const bashProperties = bash.inputSchema.properties as Record<string, Record<string, unknown>>
  assert.equal(bashProperties.timeout_ms?.default, 120_000)
  assert.equal(bashProperties.timeout_ms?.maximum, 15 * 60_000)
  assert.equal(bashProperties.max_output_tokens?.default, MCP_CONFIG.shell.defaultOutputTokens)
  assert.equal(bashProperties.max_output_tokens?.maximum, MCP_CONFIG.shell.maxOutputTokens)
  const webProperties = fetchUrl.inputSchema.properties as Record<string, Record<string, unknown>>
  const webTokens = webProperties.max_output_tokens
  const webCompact = webProperties.compact
  const webFormat = webProperties.format
  assert.equal(webTokens?.default, MCP_CONFIG.web.defaultOutputTokens)
  assert.equal(webTokens?.maximum, MCP_CONFIG.web.maxOutputTokens)
  assert.equal(webCompact?.default, false)
  assert.deepEqual(webFormat?.enum, ["markdown", "html"])
  assert.equal(fetchUrl.outputSchema, undefined)
  assert.deepEqual(Object.keys(fileWrite.inputSchema.properties ?? {}), [
    "filePath",
    "content",
    "project_id",
  ])
  assert.equal(fileWrite.outputSchema, undefined)
})

test("bound MCP factories snapshot identity, tool groups, and output mode", {
  timeout: 10_000,
}, async (t) => {
  const previousServer = { ...MCP_CONFIG.server }
  const previousTools = { ...MCP_CONFIG.tools }
  const previousToolOutput = MCP_CONFIG.mcp.toolOutput
  t.after(() => {
    Object.assign(MCP_CONFIG.server, previousServer)
    Object.assign(MCP_CONFIG.tools, previousTools)
    MCP_CONFIG.mcp.toolOutput = previousToolOutput
  })

  const createMcpServer = createMcpServerFactory(
    {},
    {
      server: { name: "profile-snapshot", version: "9.9.9" },
      tools: {
        shell: false,
        applyPatch: false,
        fileRead: false,
        fileWrite: false,
        web: false,
        skills: true,
        image: false,
      },
      toolOutput: "compact",
    }
  )

  MCP_CONFIG.server.name = "mutated-after-bind"
  MCP_CONFIG.server.version = "0.0.0"
  Object.assign(MCP_CONFIG.tools, {
    shell: true,
    applyPatch: true,
    fileRead: true,
    fileWrite: true,
    web: true,
    skills: false,
    image: true,
  })
  MCP_CONFIG.mcp.toolOutput = "structured"

  const running = await startMcpHttpServerRaw({ createMcpServer }, { port: 0 })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "profile-snapshot-client")
  t.after(() => connected.client.close())

  assert.equal(connected.client.getServerVersion()?.name, "profile-snapshot")
  assert.equal(connected.client.getServerVersion()?.version, "9.9.9")
  const tools = await connected.client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "start_here",
      "skill_search",
      "skill_load",
      "skill_manage",
      "rule_resolve",
      "rule_load",
      "rule_manage",
      "rule_import",
      "rule_export",
    ]
  )
  assert.equal(tools.tools.find((tool) => tool.name === "skill_search")?.outputSchema, undefined)
})

test("one HTTP observer drives dashboard state and tool observation", {
  timeout: 10_000,
}, async (t) => {
  const agentObserver = createAgentObserver()
  const running = await startMcpHttpServer({ agentObserver })
  t.after(() => running.close())
  const connected = await connectClient(
    running.url,
    "observer-composition-client",
    undefined,
    false,
    "observer-composition-session"
  )
  t.after(() => connected.client.close())

  await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "observer-composition" },
  })
  await connected.client.callTool({ name: "bash", arguments: { command: "printf observed" } })

  const response = await fetch(`http://${running.host}:${running.port}/ui/api/agents`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    agents: Array<{ id: string; recent: Array<{ tool: string }> }>
  }
  const local = agentObserver.listAgents()[0]
  assert.equal(body.agents[0]?.id, local?.id)
  assert.equal(body.agents[0]?.recent[0]?.tool, "bash")
  assert.equal(local?.recent[0]?.tool, "bash")
})

test("publishes start_here and core rule tools when optional groups are disabled", {
  timeout: 10_000,
}, async (t) => {
  const running = await startMcpHttpServer({
    profile: {
      tools: {
        shell: false,
        applyPatch: false,
        fileRead: false,
        fileWrite: false,
        web: false,
        skills: false,
        image: false,
      },
    },
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "minimal-tool-surface-client")
  t.after(() => connected.client.close())

  const tools = await connected.client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["start_here", "rule_resolve", "rule_load", "rule_manage", "rule_import", "rule_export"]
  )
})

test("file_read and file_write can be enabled independently", { timeout: 10_000 }, async (t) => {
  for (const [fileRead, fileWrite] of [
    [false, true],
    [true, false],
  ] as const) {
    const running = await startMcpHttpServer({ profile: { tools: { fileRead, fileWrite } } })
    t.after(() => running.close())
    const connected = await connectClient(
      running.url,
      `file-tool-toggle-${String(fileRead)}-${String(fileWrite)}`
    )
    t.after(() => connected.client.close())

    const names = (await connected.client.listTools()).tools.map((tool) => tool.name)
    assert.equal(names.includes("file_read"), fileRead)
    assert.equal(names.includes("file_write"), fileWrite)
  }
})

test("publishes ordinary tool results only through the compact MCP surface", {
  timeout: 10_000,
}, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "compact-output-client")
  t.after(() => connected.client.close())

  const bash = (await connected.client.listTools()).tools.find((tool) => tool.name === "bash")
  assert.ok(bash)
  assert.equal(bash.outputSchema, undefined)

  const result = await connected.client.callTool({
    name: "bash",
    arguments: { command: "printf compact" },
  })
  assert.equal(result.structuredContent, undefined)
  assert.match(toolText(result), /output=compact/u)
})

test("preserves structured tool output when configured", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ profile: { toolOutput: "structured" } })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "structured-output-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "bash",
    arguments: { command: "printf structured" },
  })
  assert.ok(result.structuredContent)
  assert.equal((result.structuredContent as { output: string }).output, "structured")
})
