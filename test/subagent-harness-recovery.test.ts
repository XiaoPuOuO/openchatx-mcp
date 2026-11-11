import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

import {
  checkpointMessage,
  contextCompactionDue,
  splitForCompaction,
} from "../src/subagents/agent-compaction.js"
import type { AgentFunctionCall, AgentMessage } from "../src/subagents/agent-provider.js"
import {
  AgentProviderHttpError,
  isContextOverflow,
  isTransientModelError,
} from "../src/subagents/agent-recovery.js"
import {
  generateWithRecovery,
  type ModelRetryInfo,
} from "../src/subagents/agent-request-recovery.js"
import { isRepeatingToolBatch } from "../src/subagents/agent-sessions.js"
import { subagentConfigSchema } from "../src/subagents/config.js"
import { type SessionRecord, SubagentSessionStore } from "../src/subagents/session-store.js"

const profile = subagentConfigSchema.parse({
  providers: { local: { type: "openai-compatible", base_url: "http://localhost:9999/v1" } },
  models: {
    fixture: {
      provider: "local",
      model: "test-model",
      name: "Test",
      description: "Fixture",
      thinking: { mode: "none" },
      context_window: 3000,
    },
  },
})
const provider = profile.providers.local
const model = profile.models.fixture
assert.ok(provider && model)

test("model retry distinguishes transient failures, overflow, and permanent requests", () => {
  assert.equal(isTransientModelError(new AgentProviderHttpError(429, "rate limit")), true)
  assert.equal(isTransientModelError(new AgentProviderHttpError(503, "unavailable")), true)
  assert.equal(isTransientModelError(new AgentProviderHttpError(401, "unauthorized")), false)
  assert.equal(isTransientModelError(new AgentProviderHttpError(404, "model_not_found")), false)
  assert.equal(
    isContextOverflow(new AgentProviderHttpError(400, "maximum context length exceeded")),
    true
  )
  assert.equal(isContextOverflow(new AgentProviderHttpError(413, "request too large")), true)
  assert.equal(
    isTransientModelError(new AgentProviderHttpError(429, "context_length_exceeded")),
    false
  )
})

test("recoverable transport retries one model request, not the entire tool turn", async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let requests = 0
  const retries: Array<ModelRetryInfo | undefined> = []
  globalThis.fetch = async () => {
    requests += 1
    if (requests === 1)
      return new Response(JSON.stringify({ error: { message: "please retry" } }), {
        status: 429,
        headers: { "retry-after": "0" },
      })
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Recovered", role: "assistant" } }] }),
      { status: 200 }
    )
  }
  const controller = new AbortController()
  const done = await generateWithRecovery({
    provider,
    providerId: "local",
    profile: model,
    messages: () => [{ role: "user", content: "Test" }],
    tools: [],
    signal: controller.signal,
    compact: async () => false,
    onRetry: (info) => {
      retries.push(info)
    },
  })
  assert.equal(done.text, "Recovered")
  assert.equal(requests, 2)
  assert.equal(retries[0]?.attempt, 1)
  assert.equal(retries.at(-1), undefined)
})

test("context overflow makes one checkpoint and retries the logical model step", async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let count = 0
  let compactions = 0
  let history: AgentMessage[] = [{ role: "user", content: "Original context" }]
  globalThis.fetch = async (_url, options) => {
    count += 1
    const body = JSON.parse(String(options?.body)) as { messages: Array<{ content: string }> }
    if (count === 1)
      return new Response(JSON.stringify({ error: { message: "context_length_exceeded" } }), {
        status: 400,
      })
    assert.match(body.messages[0]?.content ?? "", /conversation-checkpoint/u)
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Continued after compaction" } }],
      }),
      { status: 200 }
    )
  }
  const output = await generateWithRecovery({
    provider,
    providerId: "local",
    profile: model,
    messages: () => history,
    tools: [],
    signal: new AbortController().signal,
    onRetry: () => {
      throw new Error("Overflow must not schedule generic retry.")
    },
    compact: async () => {
      compactions += 1
      history = [checkpointMessage("Original task and work state preserved")]
      return true
    },
  })
  assert.equal(output.text, "Continued after compaction")
  assert.equal(compactions, 1)
  assert.equal(count, 2)
})

test("SQLite checkpoint keeps the complete transcript while restoring only active context", () => {
  const folder = mkdtempSync(join(tmpdir(), "subagent-context-"))
  const path = join(folder, "sessions.db")
  try {
    const store = new SubagentSessionStore(path)
    const now = new Date().toISOString()
    const record: SessionRecord = {
      job_id: "job",
      session_id: "session",
      profile: "fixture",
      provider: "local",
      model: "test-model",
      title: "Task",
      root_owner: "parent",
      owner: "parent",
      depth: 1,
      status: "completed",
      created_at: now,
      updated_at: now,
      pending_guidance: 0,
      bootstrapped: true,
      notified: false,
    }
    const history: AgentMessage[] = [
      { role: "system", content: "Original instructions" },
      { role: "user", content: "Fix the issue without losing data" },
    ]
    for (let n = 0; n < 14; n++) {
      history.push({
        role: "assistant",
        content: "",
        calls: [{ id: `call-${n}`, name: "grep", arguments: { query: n } }],
      })
      history.push({ role: "tool", callId: `call-${n}`, name: "grep", content: "A".repeat(2000) })
    }
    store.create(record, history)
    assert.equal(contextCompactionDue(history, [], 3000), true)
    const parts = splitForCompaction(history, 3000, true)
    assert.ok(parts)
    assert.ok(parts.earlier.length > 8)
    assert.equal(parts.tail[0]?.role, "assistant")
    assert.equal(parts.tail.at(-1)?.role, "tool")
    const initial = history[0]
    assert.ok(initial)
    const active = [initial, checkpointMessage("Kept the task and completed fixes"), ...parts.tail]
    store.replaceActiveContext(record.job_id, active)
    assert.deepEqual(store.messages(record.job_id), active)
    store.appendMessage(record.job_id, { role: "user", content: "Continue after restart" })
    assert.equal(store.messages(record.job_id).at(-1)?.content, "Continue after restart")
    const readOnly = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(
        (
          readOnly.prepare("SELECT COUNT(*) AS n FROM message WHERE job_id='job'").get() as {
            n: number
          }
        ).n,
        history.length + 1
      )
    } finally {
      readOnly.close()
    }
    store.dispose()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test("repeated identical tool batches are stopped before another side-effect", () => {
  const calls: AgentFunctionCall[] = [
    { id: "first", name: "bash", arguments: { command: "echo hi" } },
  ]
  const history: AgentMessage[] = [{ role: "user", content: "run" }]
  for (let n = 0; n < 3; n++) {
    history.push({ role: "assistant", content: "", calls })
    history.push({ role: "tool", content: "ok", callId: `id-${n}` })
  }
  assert.equal(isRepeatingToolBatch(history, calls), true)
  assert.equal(isRepeatingToolBatch(history.slice(0, -2), calls), false)
  assert.equal(
    isRepeatingToolBatch([...history, { role: "user", content: "new instruction" }], calls),
    false
  )
})
