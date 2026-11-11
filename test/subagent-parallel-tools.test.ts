import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { runWithAgent, setAgentProjectId } from "../src/agent/context.js"
import { createAgentObserver } from "../src/agent/observer.js"
import { installToolRegistrationBoundary } from "../src/mcp/tool-registration-boundary.js"
import { subagentConfigSchema } from "../src/subagents/config.js"
import { SubagentRuntime } from "../src/subagents/runtime.js"

test("five grep calls overlap, mutations remain sequential and results keep model call order", async (t) => {
  let runningReads = 0
  let peakReads = 0
  let runningWrites = 0
  let peakWrites = 0
  let unsafeOverlap = false
  const recordedReplies: Record<string, string[]> = {}
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const llm = createServer(async (req, res) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages: Array<{ role: string; content: string }>
    }
    const task = body.messages.find((message) => message.role === "user")?.content ?? ""
    const replies = body.messages.filter((message) => message.role === "tool")
    const calls =
      task === "five grep"
        ? Array.from({ length: 5 }, (_, i) => ({
            id: `grep-${i + 1}`,
            type: "function",
            function: { name: "grep", arguments: JSON.stringify({ query: String(i + 1) }) },
          }))
        : [
            {
              id: "read-1",
              type: "function",
              function: { name: "grep", arguments: '{"query":"1"}' },
            },
            {
              id: "read-2",
              type: "function",
              function: { name: "grep", arguments: '{"query":"2"}' },
            },
            {
              id: "write-1",
              type: "function",
              function: { name: "write_stub", arguments: '{"value":"first"}' },
            },
            {
              id: "read-3",
              type: "function",
              function: { name: "grep", arguments: '{"query":"3"}' },
            },
            {
              id: "write-2",
              type: "function",
              function: { name: "write_stub", arguments: '{"value":"second"}' },
            },
          ]
    if (replies.length) recordedReplies[task] = replies.map((entry) => entry.content)
    res.setHeader("Content-Type", "application/json")
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: replies.length ? "Finished." : "",
              ...(!replies.length ? { tool_calls: calls } : {}),
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 35, total_tokens: 155 },
      })
    )
  })
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve))
  const address = llm.address()
  assert.ok(address && typeof address !== "string")
  t.after(() => new Promise<void>((resolve) => llm.close(() => resolve())))

  const runtime = new SubagentRuntime(
    subagentConfigSchema.parse({
      providers: {
        local: { type: "openai-compatible", base_url: `http://127.0.0.1:${address.port}/v1` },
      },
      models: {
        fixture: {
          provider: "local",
          model: "fixture",
          name: "Fixture",
          description: "Parallel tool fixture",
          enabled: true,
          context_window: 10000,
          thinking: { mode: "none" },
        },
      },
    })
  )
  const observer = createAgentObserver()
  const factory = () => {
    const server = new McpServer({ name: "parallel-fixture", version: "1.0.0" })
    installToolRegistrationBoundary(server, { structuredOutput: false, agentObserver: observer })
    server.registerTool(
      "start_here",
      {
        inputSchema: z.object({ mode: z.string(), task_id: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text", text: "Initialized." }] })
    )
    server.registerTool(
      "grep",
      {
        inputSchema: z.object({ query: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ query }) => {
        if (runningWrites) unsafeOverlap = true
        runningReads += 1
        peakReads = Math.max(peakReads, runningReads)
        await pause((6 - Number(query)) * 12)
        runningReads -= 1
        return { content: [{ type: "text", text: `match-${query}` }] }
      }
    )
    server.registerTool(
      "write_stub",
      {
        inputSchema: z.object({ value: z.string() }),
        annotations: { readOnlyHint: false },
      },
      async ({ value }) => {
        if (runningReads || runningWrites) unsafeOverlap = true
        runningWrites += 1
        peakWrites = Math.max(peakWrites, runningWrites)
        await pause(24)
        runningWrites -= 1
        return { content: [{ type: "text", text: `written-${value}` }] }
      }
    )
    return server
  }
  const folder = mkdtempSync(join(tmpdir(), "openchatx-parallel-"))
  runtime.enableAgentSessions(factory, observer, join(folder, "sessions.db"))
  t.after(() => {
    runtime.close()
    rmSync(folder, { recursive: true, force: true })
  })

  const first = await runWithAgent("parallel-owner", () => {
    setAgentProjectId(undefined)
    return runtime.run({ profileId: "fixture", task: "five grep" })
  })
  assert.equal(first.content, "Finished.")
  assert.equal(peakReads, 5)
  assert.equal(peakWrites, 0)
  assert.deepEqual(recordedReplies["five grep"], [
    "match-1",
    "match-2",
    "match-3",
    "match-4",
    "match-5",
  ])
  const firstJob = runtime.listSessions().find((session) => session.title === "five grep")
  assert.ok(firstJob)
  assert.equal(firstJob.modelTurns, 2)
  assert.deepEqual(firstJob.usage, {
    inputTokens: 240,
    outputTokens: 70,
    totalTokens: 310,
    lastInputTokens: 120,
  })
  assert.equal(firstJob.contextWindow, 10000)
  const events = runtime
    .sessionSnapshot(firstJob.job_id)
    .events.filter((event) => event.role === "tool")
  assert.equal(events.length, 5)
  assert.equal(new Set(events.map((event) => event.parallelBatch)).size, 1)
  assert.ok(events.every((event) => event.parallelBatch && event.durationMs !== undefined))

  peakReads = 0
  const second = await runWithAgent("parallel-owner", () =>
    runtime.run({ profileId: "fixture", task: "mixed" })
  )
  assert.equal(second.content, "Finished.")
  assert.equal(peakReads, 2)
  assert.equal(peakWrites, 1)
  assert.equal(unsafeOverlap, false)
  assert.deepEqual(recordedReplies.mixed, [
    "match-1",
    "match-2",
    "written-first",
    "match-3",
    "written-second",
  ])
  const mixed = runtime.listSessions().find((session) => session.title === "mixed")
  assert.ok(mixed)
  const runs = runtime.sessionSnapshot(mixed.job_id).events.filter((event) => event.role === "tool")
  assert.ok(runs[0]?.parallelBatch)
  assert.equal(runs[0]?.parallelBatch, runs[1]?.parallelBatch)
  assert.equal(runs[2]?.parallelBatch, undefined)
  assert.equal(runs[3]?.parallelBatch, undefined)
})
