import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client"

import { MCP_CONFIG } from "../../src/config.js"
import { discoverPromptModes, readStartPrompt } from "../../src/tools/start-here/start-here.js"
import { createShellSession } from "../../src/tools/shell/session.js"
import { createShellSessionManager } from "../../src/tools/shell/session-manager.js"
import { callUntilComplete, connectClient, connectLegacyClient, postWithHost, startMcpHttpServer } from "./helpers.js"

test("publishes the assembled MCP tool surface", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "tool-surface-client")
  t.after(() => connected.client.close())

  assert.equal(connected.client.getProtocolEra(), "modern")
  assert.equal(connected.client.getNegotiatedProtocolVersion(), "2026-07-28")
  assert.ok(connected.client.getDiscoverResult())

  const tools = await connected.client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "start_here",
      "submit_review",
      "shell_run",
      "shell_poll",
      "apply_patch",
      "shell_reset",
      "shell_list",
      "shell_close",
      "clone_self",
      "clone_run",
      "clone_result",
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
    ]
  )

  const startHere = tools.tools.find((tool) => tool.name === "start_here")
  assert.ok(startHere)
  assert.deepEqual((startHere.inputSchema.properties as Record<string, Record<string, unknown>>).mode?.enum, [
    "code-review",
    "coding",
    "general",
  ])

  const shellRun = tools.tools.find((tool) => tool.name === "shell_run")
  const shellPoll = tools.tools.find((tool) => tool.name === "shell_poll")
  const fetchUrl = tools.tools.find((tool) => tool.name === "fetch_url")
  const subagentResult = tools.tools.find((tool) => tool.name === "subagent_result")
  assert.ok(shellRun && shellPoll && fetchUrl && subagentResult)

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
  assert.ok(fetchUrl.outputSchema)
  assert.equal(subagentWait?.default, MCP_CONFIG.chatGpt.defaultPollWaitMs)
  assert.equal(subagentWait?.maximum, MCP_CONFIG.chatGpt.maxPollWaitMs)
})

test("asks once for a Shellby review after sustained tool use and saves the response", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-review-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewFilePath = join(root, ".shellby", "reviews.jsonl")
  const running = await startMcpHttpServer({ port: 0, reviewPromptThreshold: 3, reviewFilePath })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "review-client", undefined, false, "review-session")
  t.after(() => connected.client.close())

  await connected.client.callTool({ name: "start_here", arguments: { mode: "general", task_slug: "review-feedback" } })

  const beforeThreshold = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.doesNotMatch(beforeThreshold.content.find((item) => item.type === "text")?.text ?? "", /submit_review/)

  const prompted = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.match(prompted.content.find((item) => item.type === "text")?.text ?? "", /submit_review/)

  const noRepeat = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.doesNotMatch(noRepeat.content.find((item) => item.type === "text")?.text ?? "", /submit_review/)

  const submitted = await connected.client.callTool({
    name: "submit_review",
    arguments: { rating: 8.7, review: "Fast local tools; shell polling was easy to follow." },
  })
  assert.match(submitted.content.find((item) => item.type === "text")?.text ?? "", /Review saved/)

  const records = (await readFile(reviewFilePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.rating, "8.7")
  assert.equal(Object.hasOwn(records[0] ?? {}, "session"), false)
  assert.doesNotMatch(JSON.stringify(records[0]), /review-session/)
})

test("requires start_here once per ChatGPT session", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "shellby-start-here-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const running = await startMcpHttpServer({
    port: 0,
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
    port: 0,
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
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "startup-local-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(result.isError, undefined)
})

test("keeps the stateless 2025-era fallback available", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer({ port: 0 })
  t.after(() => running.close())
  const connected = await connectLegacyClient(running.url, "legacy-compatibility-client")
  t.after(() => connected.client.close())

  assert.equal(connected.client.getProtocolEra(), "legacy")
  assert.equal(connected.client.getNegotiatedProtocolVersion(), "2025-11-25")
  assert.ok((await connected.client.listTools()).tools.length > 0)
})

test("supports structured output modes through the public MCP surface", { timeout: 20_000 }, async () => {
  for (const mode of ["always", "optional", "never"] as const) {
    const running = await startMcpHttpServer({ port: 0, toolOutputStructured: mode })
    const connected = await connectClient(running.url, `tool-output-${mode}`)
    try {
      const tools = await connected.client.listTools()
      const shellList = tools.tools.find((tool) => tool.name === "shell_list")
      assert.ok(shellList)
      const properties = shellList.inputSchema.properties as Record<string, Record<string, unknown>>

      if (mode === "always") {
        assert.ok(shellList.outputSchema)
        assert.equal("structured" in properties, false)
      } else {
        assert.equal(shellList.outputSchema, undefined)
        assert.equal("structured" in properties, mode === "optional")
      }

      const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
      assert.equal(Boolean(result.structuredContent), mode === "always")
      if (mode !== "always") assert.ok(result.content.some((item) => item.type === "text"))

      if (mode === "optional") {
        const structured = await connected.client.callTool({ name: "shell_list", arguments: { structured: true } })
        assert.ok(structured.structuredContent)
      }
    } finally {
      await connected.client.close()
      await running.close()
    }
  }
})

test("continues serving an existing client after an HTTP server restart", { timeout: 20_000 }, async (t) => {
  const firstServer = await startMcpHttpServer({ port: 0 })
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
  const running = await startMcpHttpServer({ port: 0 })
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
