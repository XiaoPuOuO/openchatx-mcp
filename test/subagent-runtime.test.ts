import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import test from "node:test"

import type { SubagentConfig } from "../src/subagents/config.js"
import { SubagentRuntime } from "../src/subagents/runtime.js"
import { tempDir } from "./helpers/temp.js"

test("subagent runtime hot-reloads direct config file edits", async (t) => {
  const root = await tempDir(t, "openchatx-subagent-watch-")
  const configPath = join(root, "subagents.json")
  await writeFile(configPath, JSON.stringify({ providers: {}, models: {} }))
  const runtime = new SubagentRuntime({ providers: {}, models: {} })
  runtime.startWatching(configPath)
  t.after(() => runtime.close())

  await writeFile(
    configPath,
    JSON.stringify({
      providers: {
        local: {
          type: "openai-compatible",
          base_url: "http://127.0.0.1:1/v1",
          enabled: true,
          timeout: 5000,
        },
      },
      models: {
        watched: {
          provider: "local",
          model: "watched-model",
          name: "Watched",
          description: "Reloaded profile",
          enabled: true,
          context_window: 8192,
          thinking: { mode: "none" },
        },
      },
    })
  )

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (runtime.profiles().some((profile) => profile.id === "watched")) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail("subagent config watcher did not reload the edited file")
})

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
