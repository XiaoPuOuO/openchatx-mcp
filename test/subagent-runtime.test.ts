import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import type { SubagentConfig } from "../src/subagents/config.js"
import { SubagentRuntime } from "../src/subagents/runtime.js"

test("subagent runtime sends only curated profile settings to an OpenAI-compatible provider", async (t) => {
  let received: Record<string, unknown> | undefined
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    res.setHeader("Content-Type", "application/json")
    res.end(
      JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { total_tokens: 42 } })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const address = server.address()
  assert.ok(address && typeof address === "object")

  const config: SubagentConfig = {
    providers: {
      local: {
        type: "openai-compatible",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        enabled: true,
        timeout: 5000,
      },
    },
    models: {
      fast: {
        provider: "local",
        model: "Qwen3.8-Flash-Next",
        name: "Fast",
        description: "Fast chores",
        enabled: true,
        context_window: 131072,
        thinking: {
          mode: "boolean",
          request_field: "enable_thinking",
          default_enabled: false,
        },
      },
    },
  }
  const runtime = new SubagentRuntime(config)
  const result = await runtime.run({ profileId: "fast", task: "hello" })
  assert.equal(result.content, "done")
  assert.equal(received?.model, "Qwen3.8-Flash-Next")
  assert.equal(received?.enable_thinking, false)
  assert.equal("max_tokens" in (received ?? {}), false)
})

test("subagent runtime validates configured thinking effort and optional max output", async (t) => {
  let received: Record<string, unknown> | undefined
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ choices: [{ message: { content: "heavy" } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const address = server.address()
  assert.ok(address && typeof address === "object")

  const runtime = new SubagentRuntime({
    providers: {
      local: {
        type: "openai-compatible",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        enabled: true,
        timeout: 5000,
      },
    },
    models: {
      heavy: {
        provider: "local",
        model: "Qwen3.8-2.4T-A95B",
        name: "Heavy",
        description: "Complex work",
        enabled: true,
        context_window: 262144,
        max_output_tokens: 12000,
        thinking: {
          mode: "effort",
          request_field: "reasoning_effort",
          levels: ["low", "medium", "high"],
          default: "medium",
          enabled_field: "enable_thinking",
          default_enabled: true,
        },
      },
    },
  })
  await runtime.run({
    profileId: "heavy",
    task: "solve",
    thinkingEffort: "high",
    maxOutputTokens: 20000,
  })
  assert.equal(received?.enable_thinking, true)
  assert.equal(received?.reasoning_effort, "high")
  assert.equal(received?.max_tokens, 12000)
  await runtime.run({ profileId: "heavy", task: "solve", thinking: false })
  assert.equal(received?.enable_thinking, false)
  assert.equal("reasoning_effort" in (received ?? {}), false)
  await assert.rejects(
    runtime.run({ profileId: "heavy", task: "solve", thinkingEffort: "extreme" }),
    /thinking_effort/u
  )
})
