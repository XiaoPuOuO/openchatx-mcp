import assert from "node:assert/strict"
import test from "node:test"

import {
  getAgentIdentity,
  runWithAgent,
  setAgentGoalId,
  setAgentProjectId,
} from "../../src/agent/context.js"
import { createAgentObserver } from "../../src/agent/observer.js"
import { MCP_CONFIG } from "../../src/config.js"
import { ContextBudgetGuard } from "../../src/mcp/context-budget.js"
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
      "skill_manage",
      "rule_resolve",
      "rule_manage",
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
  const skillSearch = tools.tools.find((tool) => tool.name === "skill_search")
  const ruleManage = tools.tools.find((tool) => tool.name === "rule_manage")
  assert.ok(bash && skillSearch && ruleManage)
  assert.deepEqual(
    (skillSearch.inputSchema.properties as Record<string, Record<string, unknown>>).action?.enum,
    ["search", "load"]
  )
  assert.deepEqual(
    (ruleManage.inputSchema.properties as Record<string, Record<string, unknown>>).mode?.enum,
    ["always", "auto_attached", "agent_requested", "manual"]
  )
  assert.deepEqual(
    (ruleManage.inputSchema.properties as Record<string, Record<string, unknown>>).action?.enum,
    ["create", "edit", "delete", "import", "export"]
  )

  const fetchUrl = tools.tools.find((tool) => tool.name === "fetch_url")
  const fileWrite = tools.tools.find((tool) => tool.name === "file_write")
  assert.ok(bash && fetchUrl && fileWrite)

  const bashProperties = bash.inputSchema.properties as Record<string, Record<string, unknown>>
  assert.equal(bashProperties.timeout_ms?.default, 30_000)
  assert.equal(bashProperties.timeout_ms?.maximum, 60 * 60_000)
  assert.equal(bashProperties.kill_after_ms?.maximum, 60 * 60_000)
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
    ["start_here", "skill_search", "skill_manage", "rule_resolve", "rule_manage"]
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

test("toggling unlimited context preserves an initialized session and its dashboard metadata", {
  timeout: 10_000,
}, async (t) => {
  let now = 1_000
  const observer = createAgentObserver(() => now)
  const budget = new ContextBudgetGuard(1_000_000, () => 1)
  const running = await startMcpHttpServerRaw(
    {
      createMcpServer: createMcpServerFactory(
        { contextBudget: budget },
        { tools: { shell: true, web: false } }
      ),
      agentObserver: observer,
      contextBudget: budget,
    },
    { port: 0 }
  )
  t.after(() => running.close())
  const sessionId = "unlimited-preserves-initialization-session"
  const connected = await connectClient(
    running.url,
    "unlimited-preserves",
    undefined,
    false,
    sessionId
  )
  t.after(() => connected.client.close())
  const started = await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "keep-my-name" },
  })
  assert.notEqual(started.isError, true)
  runWithAgent(sessionId, () => {
    setAgentProjectId("project-one")
    setAgentGoalId("goal-one")
  })
  const initialCall = await connected.client.callTool({
    name: "bash",
    arguments: { command: "printf before" },
  })
  assert.notEqual(initialCall.isError, true)
  const before = observer.listAgents()[0]
  assert.ok(before)
  assert.equal(before.taskSlug, "keep-my-name")
  assert.equal(before.projectId, "project-one")
  assert.equal(before.goalId, "goal-one")

  const events: Array<ReturnType<typeof observer.listAgents>[number]> = []
  const unsubscribe = observer.subscribe((event) => {
    if (event.type === "agent_changed") events.push(event.agent)
  })
  t.after(unsubscribe)
  now = 5_000
  const base = `http://${running.host}:${running.port}/ui/api/agents/${before.id}`
  for (const unlimited of [true, false]) {
    const response = await fetch(`${base}/unlimited-context`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unlimited }),
    })
    assert.equal(response.status, 200)
    const after = observer.listAgents()[0]
    const identity = runWithAgent(sessionId, () => getAgentIdentity())
    assert.equal(identity?.taskSlug, before.taskSlug)
    assert.equal(identity?.projectId, before.projectId)
    assert.equal(identity?.goalId, before.goalId)
    assert.equal(after?.taskSlug, before.taskSlug)
    assert.equal(after?.projectId, before.projectId)
    assert.equal(after?.goalId, before.goalId)
    assert.equal(after?.lastSeenAt, before.lastSeenAt)
    assert.deepEqual(after?.recent, before.recent)
    assert.equal(after?.contextBudget?.unlimited === true, unlimited)
    assert.equal(events.at(-1)?.taskSlug, before.taskSlug)
    assert.equal(events.at(-1)?.projectId, before.projectId)
    assert.equal(events.at(-1)?.goalId, before.goalId)
  }

  const nextCall = await connected.client.callTool({
    name: "bash",
    arguments: { command: "printf after" },
  })
  assert.notEqual(nextCall.isError, true)
  assert.match(toolText(nextCall), /after/u)
  assert.equal(observer.listAgents()[0]?.taskSlug, before.taskSlug)
})

test("a session removed during an unlimited update is not recreated", {
  timeout: 10_000,
}, async (t) => {
  let signalSaved: () => void = () => {}
  let release: () => void = () => {}
  const saved = new Promise<void>((resolve) => {
    signalSaved = resolve
  })
  const continueUpdate = new Promise<void>((resolve) => {
    release = resolve
  })
  class PausedBudget extends ContextBudgetGuard {
    override async setUnlimitedSession(sessionId: string, unlimited: boolean): Promise<void> {
      await super.setUnlimitedSession(sessionId, unlimited)
      signalSaved()
      await continueUpdate
    }
  }
  const observer = createAgentObserver()
  const budget = new PausedBudget()
  const identity = { sessionId: "removed-during-update", agent: "removed-agent", taskSlug: "task" }
  observer.updateContextBudget(identity, budget.usage(identity))
  const running = await startMcpHttpServerRaw(
    { createMcpServer: createMcpServerFactory({}), agentObserver: observer, contextBudget: budget },
    { port: 0 }
  )
  t.after(async () => {
    release()
    await running.close()
  })
  const response = fetch(
    `http://${running.host}:${running.port}/ui/api/agents/removed-agent/unlimited-context`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unlimited: true }),
    }
  )
  await saved
  assert.equal(observer.deleteAgent(identity.agent), true)
  await budget.removeSession(identity.sessionId)
  release()
  assert.equal((await response).status, 404)
  assert.deepEqual(observer.listAgents(), [])
})

test("dashboard changes unlimited context only for the selected session", async (t) => {
  const observer = createAgentObserver()
  const budget = new ContextBudgetGuard(10, (text) => text.length)
  const first = { sessionId: "session-first", agent: "first" }
  const second = { sessionId: "session-second", agent: "second" }
  observer.updateContextBudget(first, budget.usage(first))
  observer.updateContextBudget(second, budget.usage(second))
  const running = await startMcpHttpServerRaw(
    {
      createMcpServer: createMcpServerFactory({}),
      agentObserver: observer,
      contextBudget: budget,
    },
    { port: 0 }
  )
  t.after(() => running.close())
  const base = `http://${running.host}:${running.port}/ui/api`
  const response = await fetch(`${base}/agents/first/unlimited-context`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unlimited: true }),
  })
  assert.equal(response.status, 200)
  assert.equal(budget.usage(first)?.unlimited, true)
  assert.notEqual(budget.usage(second)?.unlimited, true)
  const listed = (await (await fetch(`${base}/agents`)).json()) as {
    agents: Array<{ id: string; contextBudget: { unlimited?: boolean } }>
  }
  assert.equal(listed.agents.find((agent) => agent.id === "first")?.contextBudget.unlimited, true)
  const invalid = await fetch(`${base}/agents/first/unlimited-context`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unlimited: "true" }),
  })
  assert.equal(invalid.status, 400)
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
    ["start_here", "rule_resolve", "rule_manage"]
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
