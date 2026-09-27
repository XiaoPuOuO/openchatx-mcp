import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { AgentIdentity } from "../src/agent/context.js"
import { ContextBudgetGuard } from "../src/mcp/context-budget.js"

function identity(sessionId: string): AgentIdentity {
  return {
    sessionId,
    agent: `agent-${sessionId}`,
    projectRouting: "unscoped",
  }
}

function textResult(text: string) {
  return { content: [{ type: "text", text }] }
}

test("defaults the session warning threshold to 400k tokens", () => {
  const guard = new ContextBudgetGuard()
  assert.equal(guard.usage(identity("one"))?.threshold, 400_000)
})

test("warns after cumulative tool input and output cross the session threshold", async () => {
  const guard = new ContextBudgetGuard(40, (value) => value.length)
  const agent = identity("one")

  assert.equal(
    await guard.record(agent, "grep", { pattern: "abc" }, textResult("12345")),
    undefined
  )
  assert.deepEqual(guard.usage(agent), {
    tokens: 22,
    inputTokens: 5,
    outputTokens: 17,
    threshold: 40,
  })

  const warning = await guard.record(agent, "grep", { pattern: "def" }, textResult("67890"))
  assert.deepEqual(guard.usage(agent), {
    tokens: 44,
    inputTokens: 10,
    outputTokens: 34,
    threshold: 40,
  })

  assert.match(warning ?? "", /Context budget warning/u)
  assert.match(warning ?? "", /tool input\/output tokens/u)
  assert.match(warning ?? "", /MUST NOT send ANY final user-facing completion report yet/u)
  assert.match(warning ?? "", /MUST successfully call `summarize` exactly once/u)
  assert.match(warning ?? "", /open a new ChatGPT conversation/u)
})

test("tool input alone contributes to the context budget", async () => {
  const guard = new ContextBudgetGuard(20, (value) => value.length)
  const agent = identity("one")

  const warning = await guard.record(
    agent,
    "file_write",
    { content: "x".repeat(30) },
    textResult("")
  )

  assert.match(warning ?? "", /Context budget warning/u)
})

test("image mimeType/data payloads in tool input and structured output do not inflate the budget", async () => {
  const guard = new ContextBudgetGuard(500, (value) => value.length)
  const agent = identity("one")
  const base64 = "A".repeat(4_000)

  const notice = await guard.record(
    agent,
    "screenshot",
    { mimeType: "image/png", data: base64 },
    {
      content: [{ type: "text", text: "Screenshot captured." }],
      structuredContent: {
        returnValue: { mimeType: "image/png", data: base64 },
        width: 1440,
        height: 900,
      },
    }
  )

  assert.equal(notice, undefined)
  assert.ok((guard.usage(agent)?.tokens ?? 0) < 500)
})

test("JSON text containing returnValue image mimeType/data does not inflate the budget", async () => {
  const guard = new ContextBudgetGuard(500, (value) => value.length)
  const agent = identity("one")
  const base64 = "A".repeat(4_000)
  const text = JSON.stringify({
    returnValue: {
      mimeType: "image/png",
      data: base64,
    },
  })

  const notice = await guard.record(agent, "screenshot", {}, textResult(text))

  assert.equal(notice, undefined)
  assert.ok((guard.usage(agent)?.tokens ?? 0) < 500)
})

test("image data URLs embedded in text content do not inflate the budget", async () => {
  const guard = new ContextBudgetGuard(500, (value) => value.length)
  const agent = identity("one")
  const dataUrl = `data:image/png;base64,${"A".repeat(4_000)}`

  const notice = await guard.record(
    agent,
    "screenshot",
    {},
    textResult(`Screenshot: ${dataUrl}\nwidth=1440 height=900`)
  )

  assert.equal(notice, undefined)
  assert.ok((guard.usage(agent)?.tokens ?? 0) < 500)
})

test("ordinary base64-looking text is still counted when it is not an image payload", async () => {
  const guard = new ContextBudgetGuard(1_000, (value) => value.length)
  const agent = identity("one")
  const ordinaryBase64 = "A".repeat(4_000)

  const warning = await guard.record(
    agent,
    "tool",
    {},
    textResult(`encoded-data=${ordinaryBase64}`)
  )

  assert.match(warning ?? "", /Context budget warning/u)
})

test("keeps token budgets isolated by session", async () => {
  const guard = new ContextBudgetGuard(20, (value) => value.length)
  const first = identity("one")
  const second = identity("two")

  await guard.record(first, "grep", {}, textResult("123456789"))
  assert.equal(await guard.record(second, "grep", {}, textResult("123456789")), undefined)
  assert.match(
    (await guard.record(first, "grep", { pattern: "abcdefghij" }, textResult("x"))) ?? "",
    /Context budget warning/u
  )
})

test("records a summarize checkpoint UUID and reminds the agent to report it", async () => {
  const guard = new ContextBudgetGuard(5, (value) => value.length)
  const agent = identity("one")
  const uuid = "123e4567-e89b-42d3-a456-426614174000"

  await guard.record(agent, "grep", {}, textResult("12345"))
  const summarizeNotice = await guard.record(
    agent,
    "summarize",
    { summary: "summary", recent_context: "recent" },
    textResult(uuid)
  )
  assert.equal(summarizeNotice, undefined)

  const notice = await guard.record(agent, "grep", {}, textResult("next"))
  assert.match(notice ?? "", /checkpoint is ready/u)
  assert.match(notice ?? "", /open a new ChatGPT conversation/u)
  assert.match(notice ?? "", /call `summarize` with this UUID/u)
  assert.match(notice ?? "", new RegExp(uuid, "u"))
})

test("does not track or decorate summarize retrieval output", async () => {
  const guard = new ContextBudgetGuard(5, (value) => value.length)
  const agent = identity("one")
  const uuid = "123e4567-e89b-42d3-a456-426614174000"

  await guard.record(agent, "grep", {}, textResult("12345"))
  const notice = await guard.record(agent, "summarize", { uuid }, textResult(uuid))

  assert.equal(notice, undefined)
})

test("loads legacy total-only state without losing the accumulated budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-context-budget-legacy-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "context-budget.json")
  await writeFile(
    statePath,
    JSON.stringify({ sessions: { legacy: { toolTokens: 123_456 } } }),
    "utf8"
  )

  const guard = new ContextBudgetGuard(1_000_000, (value) => value.length, statePath)
  await guard.initialize()

  assert.deepEqual(guard.usage(identity("legacy")), {
    tokens: 123_456,
    inputTokens: 123_456,
    outputTokens: 0,
    threshold: 1_000_000,
  })
})

test("persists usage across guard instances and removes it only when the session is deleted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-context-budget-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "context-budget.json")
  const agent = identity("persisted-session")

  const first = new ContextBudgetGuard(1_000, (value) => value.length, statePath)
  await first.initialize()
  await first.record(agent, "grep", { pattern: "persist" }, textResult("result"))
  const persistedTokens = first.usage(agent)?.tokens ?? 0
  assert.ok(persistedTokens > 0)
  await first.close()

  const second = new ContextBudgetGuard(1_000, (value) => value.length, statePath)
  await second.initialize()
  assert.equal(second.usage(agent)?.tokens, persistedTokens)
  assert.equal(await second.removeSession(agent.sessionId), true)
  await second.close()

  const third = new ContextBudgetGuard(1_000, (value) => value.length, statePath)
  await third.initialize()
  assert.equal(third.usage(agent)?.tokens, 0)
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { sessions: {} })
  assert.equal(
    (await readdir(root)).some(
      (name) => name.startsWith(".context-budget.json.") && name.endsWith(".tmp")
    ),
    false
  )
})
