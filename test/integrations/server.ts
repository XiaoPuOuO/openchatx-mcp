import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"

import { MCP_CONFIG } from "../../src/config.js"
import { REVIEW_PROMPT_TOOL_CALLS } from "../../src/tools/review/review-tool.js"
import { discoverPromptModes, readStartPrompt } from "../../src/tools/start-here/start-here.js"
import { createShellSession } from "../../src/tools/shell/session.js"
import { createShellSessionManager } from "../../src/tools/shell/session-manager.js"
import { callUntilComplete, connectClient, connectLegacyClient, postWithHost, startMcpHttpServer, toolText } from "./helpers.js"

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
      "shell_run",
      "shell_poll",
      "apply_patch",
      "shell_reset",
      "shell_list",
      "shell_close",
      "subagent_run",
      "subagent_result",
      "fetch_url",
      "skill_list",
      "skill_load",
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
  assert.deepEqual((startHere.inputSchema.properties as Record<string, Record<string, unknown>>).mode?.enum, ["code-review", "coding", "general"])

  const shellRun = tools.tools.find((tool) => tool.name === "shell_run")
  const shellPoll = tools.tools.find((tool) => tool.name === "shell_poll")
  const fetchUrl = tools.tools.find((tool) => tool.name === "fetch_url")
  const subagentResult = tools.tools.find((tool) => tool.name === "subagent_result")
  const computerDrag = tools.tools.find((tool) => tool.name === "computer_drag")
  assert.ok(shellRun && shellPoll && fetchUrl && subagentResult && computerDrag)

  const runWait = (shellRun.inputSchema.properties as Record<string, Record<string, unknown>>).wait_ms
  const pollWait = (shellPoll.inputSchema.properties as Record<string, Record<string, unknown>>).wait_ms
  const webProperties = fetchUrl.inputSchema.properties as Record<string, Record<string, unknown>>
  const webTokens = webProperties.max_output_tokens
  const webCompact = webProperties.compact
  const webFormat = webProperties.format
  const subagentWait = (subagentResult.inputSchema.properties as Record<string, Record<string, unknown>>).wait_ms
  assert.equal(runWait?.default, MCP_CONFIG.shell.defaultWaitMs)
  assert.equal(runWait?.maximum, MCP_CONFIG.shell.maxWaitMs)
  assert.equal(pollWait?.default, MCP_CONFIG.shell.defaultPollWaitMs)
  assert.equal(pollWait?.maximum, MCP_CONFIG.shell.maxPollWaitMs)
  assert.equal(webTokens?.default, MCP_CONFIG.web.defaultOutputTokens)
  assert.equal(webTokens?.maximum, MCP_CONFIG.web.maxOutputTokens)
  assert.equal(webCompact?.default, false)
  assert.deepEqual(webFormat?.enum, ["markdown", "html"])
  assert.equal(fetchUrl.outputSchema, undefined)
  assert.equal(subagentWait?.default, MCP_CONFIG.chatGpt.defaultPollWaitMs)
  assert.equal(subagentWait?.maximum, MCP_CONFIG.chatGpt.maxPollWaitMs)
  const dragProperties = computerDrag.inputSchema.properties as Record<string, Record<string, unknown>>
  assert.equal("modifiers" in dragProperties, false)
  assert.equal(dragProperties.from?.anyOf, undefined)
  assert.equal(dragProperties.to?.anyOf, undefined)
})

test("publishes only start_here when every optional tool group is disabled", { timeout: 10_000 }, async (t) => {
  const previousTools = { ...MCP_CONFIG.tools }
  Object.assign(MCP_CONFIG.tools, {
    review: false,
    shell: false,
    applyPatch: false,
    clones: false,
    subagents: false,
    web: false,
    skills: false,
    image: false,
    computer: false,
  })
  t.after(() => Object.assign(MCP_CONFIG.tools, previousTools))
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "minimal-tool-surface-client")
  t.after(() => connected.client.close())

  const tools = await connected.client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["start_here"]
  )
})

test("asks once for a Shellby review after sustained tool use", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "review-client", undefined, false, "review-session")
  t.after(() => connected.client.close())

  await connected.client.callTool({ name: "start_here", arguments: { mode: "general", task_slug: "review-feedback" } })

  let beforeThreshold = await connected.client.callTool({ name: "shell_list", arguments: {} })
  for (let call = 1; call < REVIEW_PROMPT_TOOL_CALLS - 2; call += 1) {
    beforeThreshold = await connected.client.callTool({ name: "shell_list", arguments: {} })
  }
  assert.doesNotMatch(beforeThreshold.content.find((item) => item.type === "text")?.text ?? "", /submit_review/)

  const prompted = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.match(prompted.content.find((item) => item.type === "text")?.text ?? "", /submit_review/)

  const noRepeat = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.doesNotMatch(noRepeat.content.find((item) => item.type === "text")?.text ?? "", /submit_review/)
})

test("requires start_here once per ChatGPT session", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "shellby-start-here-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const running = await startMcpHttpServer({
    shellManager: createShellSessionManager({ defaultShell: createShellSession({ cwd: workspace }) }),
  })
  t.after(() => running.close())

  const first = await connectClient(running.url, "startup-first", undefined, false, "startup-session-a")
  const second = await connectClient(running.url, "startup-second", undefined, false, "startup-session-b")
  t.after(() => Promise.all([first.client.close(), second.client.close()]))

  const blocked = await first.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content.find((item) => item.type === "text")?.text ?? "", /start_here/)

  const started = await first.client.callTool({ name: "start_here", arguments: { mode: "coding", task_slug: "startup-session" } })
  assert.equal(started.isError, undefined)

  const allowed = await first.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(allowed.isError, undefined)

  const stillBlocked = await second.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(stillBlocked.isError, true)
})

test("prefers repo-local .shellby prompt overrides and falls back to bundled prompts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-start-prompt-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const bundledPath = join(root, "src", "tools", "start-here", "prompts", "coding.md")
  const overridePath = join(root, ".shellby", "prompts", "coding.md")
  await mkdir(join(root, "src", "tools", "start-here", "prompts"), { recursive: true })
  await mkdir(join(root, ".shellby", "prompts"), { recursive: true })
  await writeFile(bundledPath, "bundled")
  await writeFile(overridePath, "override")

  assert.deepEqual(await readStartPrompt("coding", root), { path: overridePath, prompt: "override" })

  await rm(overridePath)
  assert.deepEqual(await readStartPrompt("coding", root), { path: bundledPath, prompt: "bundled" })
})

test("derives start_here modes from bundled and local prompt filename slugs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-start-modes-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const bundledDirectory = join(root, "src", "tools", "start-here", "prompts")
  const localDirectory = join(root, ".shellby", "prompts")
  await mkdir(bundledDirectory, { recursive: true })
  await mkdir(localDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(bundledDirectory, "coding.md"), "coding"),
    writeFile(join(bundledDirectory, "general.md"), "general"),
    writeFile(join(bundledDirectory, "shared.md"), "shared"),
    writeFile(join(localDirectory, "coding.md"), "override"),
    writeFile(join(localDirectory, "deep-research.md"), "research"),
  ])

  assert.deepEqual(discoverPromptModes(root), ["coding", "deep-research", "general"])

  await writeFile(join(localDirectory, "Not-A-Mode.md"), "invalid")
  assert.throws(() => discoverPromptModes(root), /lowercase kebab-case/)
})

test("keeps a ChatGPT session locked when start_here fails", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "shellby-start-here-missing-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const running = await startMcpHttpServer({
    shellManager: createShellSessionManager({ defaultShell: createShellSession({ cwd: workspace }) }),
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "startup-failure", undefined, false, "startup-session-failure")
  t.after(() => connected.client.close())

  const failed = await connected.client.callTool({ name: "start_here", arguments: { mode: "invalid", task_slug: "invalid-mode" } })
  assert.equal(failed.isError, true)

  const blocked = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content.find((item) => item.type === "text")?.text ?? "", /start_here/)
})

test("does not require start_here when no ChatGPT session is provided", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "startup-local-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(result.isError, undefined)
})

test("keeps the stateless 2025-era fallback available", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectLegacyClient(running.url, "legacy-compatibility-client")
  t.after(() => connected.client.close())

  assert.equal(connected.client.getProtocolEra(), "legacy")
  assert.equal(connected.client.getNegotiatedProtocolVersion(), "2025-11-25")
  assert.ok((await connected.client.listTools()).tools.length > 0)
})

test("publishes ordinary tool results only through the compact MCP surface", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "compact-output-client")
  t.after(() => connected.client.close())

  const shellList = (await connected.client.listTools()).tools.find((tool) => tool.name === "shell_list")
  assert.ok(shellList)
  assert.equal(shellList.outputSchema, undefined)
  assert.equal("structured" in (shellList.inputSchema.properties as Record<string, unknown>), false)

  const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(result.structuredContent, undefined)
  assert.match(toolText(result), /count=\d+ limit=\d+/)
})

test("preserves structured tool output when configured", { timeout: 10_000 }, async (t) => {
  const previousToolOutput = MCP_CONFIG.mcp.toolOutput
  MCP_CONFIG.mcp.toolOutput = "structured"
  t.after(() => {
    MCP_CONFIG.mcp.toolOutput = previousToolOutput
  })

  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "structured-output-client")
  t.after(() => connected.client.close())

  const shellList = (await connected.client.listTools()).tools.find((tool) => tool.name === "shell_list")
  assert.ok(shellList?.outputSchema)

  const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.ok(result.structuredContent)
})

test("continues serving an existing client after an HTTP server restart", { timeout: 20_000 }, async (t) => {
  const firstServer = await startMcpHttpServer()
  const { port, url } = firstServer
  const connection = await connectClient(url, "restart-client")

  let activeServer = firstServer
  t.after(async () => {
    await connection.client.close()
    await activeServer.close()
  })

  assert.equal((await callUntilComplete(connection.client, "before-restart", "printf before")).output, "before")
  await firstServer.close()
  activeServer = await startMcpHttpServer({ port })
  assert.equal((await callUntilComplete(connection.client, "after-restart", "printf after")).output, "after")
})

test("rejects a mismatched HTTP Host", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())

  const status = await postWithHost(running.url, "attacker.example", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "host-validation-test", version: "1.0.0" },
    },
  })

  assert.equal(status, 403)
})
