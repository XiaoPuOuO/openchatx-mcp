import assert from "node:assert/strict"
import test from "node:test"

import { createAgentObserver } from "../../src/agent/observer.js"
import { MCP_CONFIG } from "../../src/config.js"
import { createMcpServerFactory } from "../../src/mcp/server-factory.js"
import { startMcpHttpServer as startMcpHttpServerRaw } from "../../src/server/http-server.js"
import { REVIEW_PROMPT_TOOL_CALLS } from "../../src/tools/review/review-tool.js"
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
  for (const tool of tools.tools.filter((tool) => tool.name !== "file_write")) {
    assert.equal(tool.title, undefined)
    assert.equal((tool as unknown as Record<string, unknown>)._meta, undefined)
  }
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "start_here",
      "shell_run",
      "shell_poll",
      "apply_patch",
      "file_read",
      "file_write",
      "shell_reset",
      "shell_list",
      "shell_close",
      "subagent_run",
      "subagent_result",
      "fetch_url",
      "skill_list",
      "skill_use",
      "image_view",
      "computer_list",
      "computer_observe",
      "computer_inspect",
      "computer_click",
      "computer_type",
      "computer_press",
      "computer_hotkey",
      "computer_scroll",
      "computer_drag",
      "computer_app",
      "computer_window",
      "clone_self",
      "clone_run",
      "clone_result",
      "submit_review",
    ]
  )

  const startHere = tools.tools.find((tool) => tool.name === "start_here")
  assert.ok(startHere)
  assert.deepEqual(
    (startHere.inputSchema.properties as Record<string, Record<string, unknown>>).mode?.enum,
    ["code-review", "coding", "general"]
  )
  assert.deepEqual(Object.keys(startHere.inputSchema.properties ?? {}), ["mode", "task_id"])
  const shellList = tools.tools.find((tool) => tool.name === "shell_list")
  const skillUse = tools.tools.find((tool) => tool.name === "skill_use")
  assert.ok(shellList && skillUse)
  assert.deepEqual(Object.keys(shellList.inputSchema.properties ?? {}), [])
  assert.deepEqual(Object.keys(skillUse.inputSchema.properties ?? {}), ["name"])

  const shellRun = tools.tools.find((tool) => tool.name === "shell_run")
  const shellPoll = tools.tools.find((tool) => tool.name === "shell_poll")
  const fetchUrl = tools.tools.find((tool) => tool.name === "fetch_url")
  const fileWrite = tools.tools.find((tool) => tool.name === "file_write")
  const subagentResult = tools.tools.find((tool) => tool.name === "subagent_result")
  const computerDrag = tools.tools.find((tool) => tool.name === "computer_drag")
  assert.ok(shellRun && shellPoll && fetchUrl && fileWrite && subagentResult && computerDrag)

  const runYield = (shellRun.inputSchema.properties as Record<string, Record<string, unknown>>)
    .yield_time_ms
  const pollYield = (shellPoll.inputSchema.properties as Record<string, Record<string, unknown>>)
    .yield_time_ms
  const webProperties = fetchUrl.inputSchema.properties as Record<string, Record<string, unknown>>
  const webTokens = webProperties.max_output_tokens
  const webCompact = webProperties.compact
  const webFormat = webProperties.format
  const subagentWait = (
    subagentResult.inputSchema.properties as Record<string, Record<string, unknown>>
  ).wait_ms
  assert.equal(runYield?.default, MCP_CONFIG.shell.defaultWaitMs)
  assert.equal(runYield?.maximum, MCP_CONFIG.shell.maxWaitMs)
  assert.equal(pollYield?.default, MCP_CONFIG.shell.defaultPollWaitMs)
  assert.equal(pollYield?.maximum, MCP_CONFIG.shell.maxPollWaitMs)
  assert.equal(webTokens?.default, MCP_CONFIG.web.defaultOutputTokens)
  assert.equal(webTokens?.maximum, MCP_CONFIG.web.maxOutputTokens)
  assert.equal(webCompact?.default, false)
  assert.deepEqual(webFormat?.enum, ["markdown", "html"])
  assert.equal(fetchUrl.outputSchema, undefined)
  assert.deepEqual((fileWrite as unknown as Record<string, unknown>)._meta, {
    "openai/fileParams": ["file"],
  })
  const fileInput = fileWrite.inputSchema.properties?.file as Record<string, unknown>
  assert.deepEqual(fileInput.required, ["download_url", "file_id"])
  assert.deepEqual(Object.keys(fileInput.properties as Record<string, unknown>), [
    "download_url",
    "file_id",
    "mime_type",
    "file_name",
  ])
  assert.equal(subagentWait?.default, MCP_CONFIG.chatGpt.defaultPollWaitMs)
  assert.equal(subagentWait?.maximum, MCP_CONFIG.chatGpt.maxPollWaitMs)
  const dragProperties = computerDrag.inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >
  assert.equal("modifiers" in dragProperties, false)
  assert.equal(dragProperties.from?.anyOf, undefined)
  assert.equal(dragProperties.to?.anyOf, undefined)
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
        review: false,
        shell: false,
        applyPatch: false,
        fileRead: false,
        fileWrite: false,
        clones: false,
        subagents: false,
        web: false,
        skills: true,
        image: false,
        computer: false,
      },
      toolOutput: "compact",
    }
  )

  MCP_CONFIG.server.name = "mutated-after-bind"
  MCP_CONFIG.server.version = "0.0.0"
  Object.assign(MCP_CONFIG.tools, {
    review: true,
    shell: true,
    applyPatch: true,
    fileRead: true,
    fileWrite: true,
    clones: true,
    subagents: true,
    web: true,
    skills: false,
    image: true,
    computer: true,
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
    ["start_here", "skill_list", "skill_use"]
  )
  assert.equal(tools.tools.find((tool) => tool.name === "skill_list")?.outputSchema, undefined)
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
  await connected.client.callTool({ name: "shell_list", arguments: {} })

  const response = await fetch(`http://${running.host}:${running.port}/ui/api/agents`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    agents: Array<{ id: string; recent: Array<{ tool: string }> }>
  }
  const local = agentObserver.listAgents()[0]
  assert.equal(body.agents[0]?.id, local?.id)
  assert.equal(body.agents[0]?.recent[0]?.tool, "shell_list")
  assert.equal(local?.recent[0]?.tool, "shell_list")
})

test("publishes only start_here when every optional tool group is disabled", {
  timeout: 10_000,
}, async (t) => {
  const running = await startMcpHttpServer({
    profile: {
      tools: {
        review: false,
        shell: false,
        applyPatch: false,
        fileRead: false,
        fileWrite: false,
        clones: false,
        subagents: false,
        web: false,
        skills: false,
        image: false,
        computer: false,
      },
    },
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "minimal-tool-surface-client")
  t.after(() => connected.client.close())

  const tools = await connected.client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["start_here"]
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

test("asks once for a Shellby review after sustained tool use", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(
    running.url,
    "review-client",
    undefined,
    false,
    "review-session"
  )
  t.after(() => connected.client.close())

  await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "review-feedback" },
  })

  let beforeThreshold = await connected.client.callTool({ name: "shell_list", arguments: {} })
  for (let call = 1; call < REVIEW_PROMPT_TOOL_CALLS - 2; call += 1) {
    beforeThreshold = await connected.client.callTool({ name: "shell_list", arguments: {} })
  }
  assert.doesNotMatch(
    beforeThreshold.content.find((item) => item.type === "text")?.text ?? "",
    /submit_review/u
  )

  const prompted = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.match(prompted.content.find((item) => item.type === "text")?.text ?? "", /submit_review/u)

  const noRepeat = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.doesNotMatch(
    noRepeat.content.find((item) => item.type === "text")?.text ?? "",
    /submit_review/u
  )
})

test("publishes ordinary tool results only through the compact MCP surface", {
  timeout: 10_000,
}, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "compact-output-client")
  t.after(() => connected.client.close())

  const shellList = (await connected.client.listTools()).tools.find(
    (tool) => tool.name === "shell_list"
  )
  assert.ok(shellList)
  assert.equal(shellList.outputSchema, undefined)
  assert.equal("structured" in (shellList.inputSchema.properties as Record<string, unknown>), false)

  const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(result.structuredContent, undefined)
  assert.match(toolText(result), /count=\d+ limit=\d+/u)
})

test("preserves structured tool output when configured", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ profile: { toolOutput: "structured" } })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "structured-output-client")
  t.after(() => connected.client.close())

  const shellList = (await connected.client.listTools()).tools.find(
    (tool) => tool.name === "shell_list"
  )
  assert.ok(shellList?.outputSchema)

  const result = await connected.client.callTool({
    name: "shell_list",
    arguments: {},
  })
  assert.ok(result.structuredContent)
  assert.equal(typeof (result.structuredContent as { count: number }).count, "number")
})
