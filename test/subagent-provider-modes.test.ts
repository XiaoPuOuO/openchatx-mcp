import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { runWithAgent, setAgentTaskSlug } from "../src/agent/context.js"
import { installToolRegistrationBoundary } from "../src/mcp/tool-registration-boundary.js"
import { parseChatGPTModels } from "../src/subagents/chatgpt-auth.js"
import { subagentConfigSchema } from "../src/subagents/config.js"
import { parseProviderModel } from "../src/subagents/model-metadata.js"
import { readChatGPTEvents, SubagentRuntime } from "../src/subagents/runtime.js"
import { registerSubagentTools } from "../src/tools/subagents/subagent-tools.js"

async function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function profile(provider: string, execution_mode: "sync" | "async" = "sync") {
  return {
    provider,
    model: "test-model",
    name: "Test",
    description: "Fixture",
    enabled: true,
    execution_mode,
    context_window: 100_000,
    thinking: { mode: "none" as const },
  }
}

test("Anthropic and Gemini use their native endpoints and API-key headers", async (t) => {
  const requests: Array<{
    path: string
    headers: import("node:http").IncomingHttpHeaders
    body: Record<string, unknown>
  }> = []
  const { server, url } = await listen((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      })
      res.setHeader("content-type", "application/json")
      res.end(
        req.url?.includes("generateContent")
          ? JSON.stringify({
              candidates: [{ content: { parts: [{ text: "gemini-result" }] } }],
              usageMetadata: { totalTokenCount: 10 },
            })
          : JSON.stringify({
              content: [{ type: "text", text: "claude-result" }],
              usage: { input_tokens: 5, output_tokens: 3 },
            })
      )
    })
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const config = subagentConfigSchema.parse({
    providers: {
      claude: {
        type: "anthropic",
        base_url: `${url}/v1`,
        api_key: "anthropic-test",
        enabled: true,
      },
      gemini: { type: "google", base_url: `${url}/v1beta`, api_key: "gemini-test", enabled: true },
    },
    models: { c: profile("claude"), g: profile("gemini") },
  })
  const runtime = new SubagentRuntime(config)
  const claude = await runtime.run({ profileId: "c", task: "hi", system: "system" })
  const gemini = await runtime.run({ profileId: "g", task: "hi", system: "system" })
  assert.equal(claude.content, "claude-result")
  assert.equal(gemini.content, "gemini-result")
  assert.equal(requests[0]?.path, "/v1/messages")
  assert.equal(requests[0]?.headers["x-api-key"], "anthropic-test")
  assert.equal(requests[0]?.headers["anthropic-version"], "2023-06-01")
  assert.equal(requests[0]?.body.system, "system")
  assert.equal(requests[1]?.path, "/v1beta/models/test-model:generateContent")
  assert.equal(requests[1]?.headers["x-goog-api-key"], "gemini-test")
  assert.equal(
    requests[1]?.body.systemInstruction && typeof requests[1].body.systemInstruction,
    "object"
  )
})

test("async Subagent returns job_id, isolates sessions, and notifies in a subsequent tool result", async (t) => {
  const { server, url } = await listen((_req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ choices: [{ message: { content: "background result" } }] }))
    }, 35)
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const runtime = new SubagentRuntime(
    subagentConfigSchema.parse({
      providers: { local: { type: "openai-compatible", base_url: `${url}/v1`, enabled: true } },
      models: { async: profile("local", "async") },
    })
  )
  const mcp = new McpServer({ name: "subagent-test", version: "1.0.0" })
  const client = new Client({ name: "subagent-client", version: "1.0.0" })
  t.after(() => Promise.all([mcp.close(), client.close()]))
  installToolRegistrationBoundary(mcp, { structuredOutput: false, subagentRuntime: runtime })
  registerSubagentTools(mcp, runtime)
  mcp.registerTool("next_tool", {}, async () => ({
    content: [{ type: "text", text: "primary response" }],
  }))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)])

  const start = await runWithAgent("session-a", () => {
    setAgentTaskSlug("test")
    return client.callTool({
      name: "subagent_run",
      arguments: { action: "run", model: "async", task: "work" },
    })
  })
  const jobId = JSON.stringify(start.content).match(/subagent-[a-f0-9-]{36}/u)?.[0]
  assert.ok(jobId)
  assert.match(JSON.stringify(start.content), /Subagent started/u)
  assert.throws(() => runtime.getJob(jobId, "session-b"), /Unknown subagent job/u)
  assert.deepEqual(runtime.drainNotifications("session-b"), [])

  for (let i = 0; i < 100 && runtime.getJob(jobId, "session-a").status === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  // Retrieving a finished job marks its notice as acknowledged; start another to verify notice.
  assert.equal(runtime.getJob(jobId, "session-a").result?.content, "background result")
  const second = runtime.startAsync({ profileId: "async", task: "work again" }, "session-a")
  await new Promise((resolve) => setTimeout(resolve, 120))
  const next = await runWithAgent("session-a", () => {
    setAgentTaskSlug("test")
    return client.callTool({ name: "next_tool", arguments: {} })
  })
  const content = JSON.stringify(next.content)
  assert.match(content, /primary response/u)
  assert.match(content, new RegExp(second.job_id, "u"))
  assert.ok(content.indexOf("primary response") < content.indexOf(second.job_id))
  const following = await runWithAgent("session-a", () =>
    client.callTool({ name: "next_tool", arguments: {} })
  )
  assert.doesNotMatch(JSON.stringify(following.content), new RegExp(second.job_id, "u"))
})

test("ChatGPT model discovery filters account-visible models and enriches documented capacities", () => {
  const models = parseChatGPTModels({
    models: [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
      { slug: "hidden-model", visibility: "hidden" },
      { slug: "custom", visibility: "list", context_window: 245_000 },
    ],
  })
  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-6.1-sol", "custom"]
  )
  assert.equal(models[0]?.context_window, 500_000)
  assert.equal(models[0]?.max_output_tokens, 128_000)
  assert.equal(models[1]?.context_window, 245_000)
})

test("ChatGPT Responses SSE handles chunked output and requires a terminal completed event", async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const wire = [
        `data: {"type":"response.output_text.delta","delta":"Hello "}\r\n\r\n`,
        `data: {"type":"response.output_text.delta","delta":"world"}\r\n\r\n`,
        `data: {"type":"response.completed","response":{"usage":{"total_tokens":8}}}\r\n\r\n`,
      ].join("")
      // Split CRLF and JSON across stream chunks.
      const splitAt = wire.indexOf("\r") + 1
      controller.enqueue(encoder.encode(wire.slice(0, splitAt)))
      controller.enqueue(encoder.encode(wire.slice(splitAt, splitAt + 48)))
      controller.enqueue(encoder.encode(wire.slice(splitAt + 48)))
      controller.close()
    },
  })
  const [content, usage] = await readChatGPTEvents(stream)
  assert.equal(content, "Hello world")
  assert.equal(usage?.total_tokens, 8)
  const truncated = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: {"type":"response.output_text.delta","delta":"incomplete"}\n\n`)
      )
      controller.close()
    },
  })
  await assert.rejects(readChatGPTEvents(truncated), /before completion/u)
})

test("provider model metadata populates verified limits and supported thinking controls", () => {
  const claude = parseProviderModel(
    {
      id: "claude-opus-5-5",
      display_name: "Claude Opus",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: {
        thinking: {
          supported: true,
          types: { adaptive: { supported: true }, disabled: { supported: true } },
        },
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: false },
        },
      },
    },
    "anthropic"
  )
  assert.equal(claude?.context_window, 1_000_000)
  assert.equal(claude?.max_output_tokens, 128_000)
  assert.deepEqual(claude?.thinking, {
    mode: "effort",
    request_field: "output_config.effort",
    levels: ["low", "medium", "high"],
    default: "medium",
    enabled_field: "thinking.type",
    default_enabled: true,
  })

  const gemini = parseProviderModel(
    {
      name: "models/gemini-2.5-flash",
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      thinking: true,
      supportedGenerationMethods: ["generateContent"],
    },
    "google"
  )
  assert.equal(gemini?.id, "gemini-2.5-flash")
  assert.equal(gemini?.context_window, 1_048_576)
  assert.equal(gemini?.max_output_tokens, 65_536)
  assert.equal(gemini?.thinking?.mode, "effort")
  if (gemini?.thinking?.mode === "effort") {
    assert.equal(gemini.thinking.request_field, "generationConfig.thinkingConfig.thinkingBudget")
    assert.equal(gemini.thinking.enabled_field, "generationConfig.thinkingConfig.thinkingBudget")
  }
  assert.equal(
    parseProviderModel(
      { name: "models/embed-only", supportedGenerationMethods: ["embedContent"] },
      "google"
    ),
    undefined
  )
  const unknown = parseProviderModel({ id: "unrecognized-model" }, "openai-compatible")
  assert.equal(unknown?.context_window, undefined)
  assert.equal(unknown?.thinking, undefined)
})

test("model detail retrieval uses provider-native authenticated model endpoints", async (t) => {
  const urls: string[] = []
  const { server, url } = await listen((req, res) => {
    urls.push(req.url ?? "")
    res.setHeader("Content-Type", "application/json")
    if (req.url?.startsWith("/v1/models/")) {
      assert.equal(req.headers["x-api-key"], "claude-fixture")
      res.end(
        JSON.stringify({
          id: "claude-opus-5-5",
          max_input_tokens: 200_000,
          max_tokens: 16_000,
        })
      )
    } else {
      assert.equal(req.headers["x-goog-api-key"], "gemini-fixture")
      res.end(
        JSON.stringify({
          name: "models/gemini-2.5-flash",
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          thinking: true,
        })
      )
    }
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const runtime = new SubagentRuntime(
    subagentConfigSchema.parse({
      providers: {
        claude: { type: "anthropic", base_url: `${url}/v1`, api_key: "claude-fixture" },
        gemini: { type: "google", base_url: `${url}/v1beta`, api_key: "gemini-fixture" },
      },
      models: {},
    })
  )
  const claude = await runtime.modelDetails("claude", "claude-opus-5-5")
  const gemini = await runtime.modelDetails("gemini", "gemini-2.5-flash")
  assert.deepEqual(urls, ["/v1/models/claude-opus-5-5", "/v1beta/models/gemini-2.5-flash"])
  assert.equal(claude.context_window, 200_000)
  assert.equal(gemini.max_output_tokens, 65_536)
})

test("Gemini thinking control uses budget for 2.5 and maps off to zero", async (t) => {
  const requests: Array<Record<string, unknown>> = []
  const { server, url } = await listen((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }))
    })
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const model = parseProviderModel(
    {
      name: "models/gemini-2.5-flash",
      thinking: true,
      supportedGenerationMethods: ["generateContent"],
    },
    "google"
  )
  assert.equal(model?.thinking?.mode, "effort")
  const runtime = new SubagentRuntime(
    subagentConfigSchema.parse({
      providers: { gemini: { type: "google", base_url: `${url}/v1beta`, api_key: "fixture" } },
      models: {
        flash: { ...profile("gemini"), model: "gemini-2.5-flash", thinking: model?.thinking },
      },
    })
  )
  await runtime.run({ profileId: "flash", task: "first", thinkingEffort: "low" })
  await runtime.run({ profileId: "flash", task: "second", thinking: false })
  assert.deepEqual(
    (requests[0]?.generationConfig as { thinkingConfig?: unknown })?.thinkingConfig,
    {
      thinkingBudget: 1024,
    }
  )
  assert.deepEqual(
    (requests[1]?.generationConfig as { thinkingConfig?: unknown })?.thinkingConfig,
    {
      thinkingBudget: 0,
    }
  )
})
