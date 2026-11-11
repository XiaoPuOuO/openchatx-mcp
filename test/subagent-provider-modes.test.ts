import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import {
  runWithAgent,
  runWithAgentId,
  setAgentProjectId,
  setAgentSkillSelection,
  setAgentTaskSlug,
} from "../src/agent/context.js"
import { installToolRegistrationBoundary } from "../src/mcp/tool-registration-boundary.js"
import { generateAgentTurn } from "../src/subagents/agent-provider.js"
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

function sseResponse(events: Array<Record<string, unknown> | "[DONE]">): Response {
  const frames = events
    .map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\r\n\r\n`)
    .join("")
  // Split a frame across network chunks to exercise the incremental decoder.
  const cut = Math.max(1, Math.floor(frames.length / 3))
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.slice(0, cut)))
      controller.enqueue(encoder.encode(frames.slice(cut, cut + 5)))
      controller.enqueue(encoder.encode(frames.slice(cut + 5)))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
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

test("Claude tool-use rounds preserve signed thinking and redacted blocks verbatim", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const requests: Array<Record<string, unknown>> = []
  const blocks = [
    { type: "thinking", thinking: "Verified the requirements.", signature: "signed-thought" },
    { type: "redacted_thinking", data: "opaque-thought" },
    { type: "tool_use", id: "tool-1", name: "echo", input: { text: "ping" } },
  ]
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({ content: blocks, usage: { input_tokens: 3, output_tokens: 12 } }),
      { status: 200 }
    )
  }
  const config = subagentConfigSchema.parse({
    providers: { claude: { type: "anthropic", api_key: "fixture" } },
    models: {
      fixture: {
        ...profile("claude"),
        thinking: {
          mode: "effort",
          request_field: "output_config.effort",
          default_enabled: true,
          default: "medium",
          levels: ["low", "medium"],
        },
      },
    },
  })
  const provider = config.providers.claude
  const model = config.models.fixture
  assert.ok(provider && model)
  const common = {
    provider,
    providerId: "claude",
    profile: model,
    apiKey: "fixture",
    tools: [{ name: "echo", description: "Echo", parameters: { type: "object" } }],
  }
  const first = await generateAgentTurn({
    ...common,
    messages: [{ role: "user", content: "Call echo" }],
  })
  assert.equal(first.reasoningSummary, "Verified the requirements.")
  assert.deepEqual(first.rawOutput, blocks)
  assert.equal(first.calls[0]?.id, "tool-1")
  await generateAgentTurn({
    ...common,
    messages: [
      { role: "user", content: "Call echo" },
      { role: "assistant", content: first.text, calls: first.calls, rawOutput: first.rawOutput },
      { role: "tool", callId: "tool-1", name: "echo", content: "pong" },
    ],
  })
  const nextMessages = requests[1]?.messages as Array<{ role: string; content: unknown }>
  assert.deepEqual(nextMessages[1]?.content, blocks)
  assert.deepEqual(nextMessages[2]?.content, [
    { type: "tool_result", tool_use_id: "tool-1", content: "pong" },
  ])
})

test("OpenAI-compatible streaming reconstructs text, reasoning and parallel tool calls", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let sent: Record<string, unknown> | undefined
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(String(options?.body)) as Record<string, unknown>
    return sseResponse([
      { choices: [{ delta: { reasoning_content: "Checking " } }] },
      { choices: [{ delta: { reasoning_content: "tools." } }] },
      { choices: [{ delta: { content: "Running " } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call-1", function: { name: "grep", arguments: '{"query":' } },
                { index: 1, id: "call-2", function: { name: "grep", arguments: '{"query":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"one"}' } },
                { index: 1, function: { arguments: '"two"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { content: "searches" }, finish_reason: "tool_calls" }] },
      "[DONE]",
    ])
  }
  const config = subagentConfigSchema.parse({
    providers: { local: { type: "openai-compatible", base_url: "http://localhost:1234/v1" } },
    models: { fixture: profile("local") },
  })
  const provider = config.providers.local
  const model = config.models.fixture
  assert.ok(provider && model)
  let text = ""
  let reasoning = ""
  const completion = await generateAgentTurn({
    provider,
    providerId: "local",
    profile: model,
    messages: [{ role: "user", content: "Search" }],
    tools: [{ name: "grep", description: "Search", parameters: { type: "object" } }],
    onText: (delta) => {
      text += delta
    },
    onReasoningSummary: (delta) => {
      reasoning += delta
    },
  })
  assert.equal(sent?.stream, true)
  assert.equal(text, "Running searches")
  assert.equal(reasoning, "Checking tools.")
  assert.equal(completion.text, text)
  assert.equal(completion.reasoningSummary, reasoning)
  assert.deepEqual(completion.calls, [
    { id: "call-1", name: "grep", arguments: { query: "one" } },
    { id: "call-2", name: "grep", arguments: { query: "two" } },
  ])
})

test("Anthropic streaming preserves tool-use signatures and reports progress", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let sent: Record<string, unknown> | undefined
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(String(options?.body)) as Record<string, unknown>
    return sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 20 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Inspecting" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Searching" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tool-1", name: "grep", input: {} },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"query":' },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '"source"}' },
      },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ])
  }
  const config = subagentConfigSchema.parse({
    providers: { claude: { type: "anthropic", api_key: "fixture" } },
    models: { fixture: profile("claude") },
  })
  const provider = config.providers.claude
  const model = config.models.fixture
  assert.ok(provider && model)
  let text = ""
  let thinking = ""
  const done = await generateAgentTurn({
    provider,
    providerId: "claude",
    profile: model,
    apiKey: "fixture",
    messages: [{ role: "user", content: "Search" }],
    tools: [],
    onText: (delta) => {
      text += delta
    },
    onReasoningSummary: (delta) => {
      thinking += delta
    },
  })
  assert.equal(sent?.stream, true)
  assert.equal(text, "Searching")
  assert.equal(thinking, "Inspecting")
  assert.deepEqual(done.calls, [{ id: "tool-1", name: "grep", arguments: { query: "source" } }])
  assert.equal(done.reasoningSummary, thinking)
  assert.equal((done.rawOutput?.[0] as { signature?: string })?.signature, "signed")
  assert.deepEqual(done.usage, { input_tokens: 20, output_tokens: 12 })
})

test("Gemini streaming preserves signed parts, progress and usage", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let requestedUrl = ""
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return sseResponse([
      {
        candidates: [
          {
            content: {
              parts: [{ thought: true, text: "Checked", thoughtSignature: "signed-thought" }],
            },
          },
        ],
      },
      { candidates: [{ content: { parts: [{ text: "Found " }] } }] },
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "result" },
                {
                  functionCall: { name: "grep", args: { query: "source" } },
                  thoughtSignature: "signed-call",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 8, thoughtsTokenCount: 2 },
      },
    ])
  }
  const config = subagentConfigSchema.parse({
    providers: { gemini: { type: "google", api_key: "fixture" } },
    models: { fixture: profile("gemini") },
  })
  const provider = config.providers.gemini
  const model = config.models.fixture
  assert.ok(provider && model)
  let text = ""
  let summary = ""
  const result = await generateAgentTurn({
    provider,
    providerId: "gemini",
    profile: model,
    apiKey: "fixture",
    messages: [{ role: "user", content: "Search" }],
    tools: [],
    onText: (delta) => {
      text += delta
    },
    onReasoningSummary: (delta) => {
      summary += delta
    },
  })
  assert.match(requestedUrl, /streamGenerateContent\?alt=sse$/u)
  assert.equal(text, "Found result")
  assert.equal(summary, "Checked")
  assert.equal(result.text, text)
  assert.equal(result.reasoningSummary, summary)
  assert.deepEqual(result.calls, [
    { id: "gemini-call-1", name: "grep", arguments: { query: "source" } },
  ])
  assert.equal(
    (result.rawOutput?.[0] as { thoughtSignature?: string })?.thoughtSignature,
    "signed-thought"
  )
  assert.equal(
    (result.rawOutput?.[3] as { thoughtSignature?: string })?.thoughtSignature,
    "signed-call"
  )
  assert.equal(result.reasoningTokens, 2)
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

  const agentId = "123e4567-e89b-42d3-a456-426614174000"
  const start = await runWithAgent("session-a", () =>
    runWithAgentId(
      agentId,
      () => {
        setAgentTaskSlug("async-subagent")
        setAgentProjectId(undefined)
        setAgentSkillSelection(null)
        return client.callTool({
          name: "subagent_run",
          arguments: { action: "run", model: "async", task: "work", agent_id: agentId },
        })
      },
      "session-a"
    )
  )
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
  const next = await runWithAgent("session-a", () =>
    runWithAgentId(
      agentId,
      () => {
        setAgentTaskSlug("test")
        return client.callTool({ name: "next_tool", arguments: { agent_id: agentId } })
      },
      "session-a"
    )
  )
  const content = JSON.stringify(next.content)
  assert.match(content, /primary response/u)
  assert.match(content, new RegExp(second.job_id, "u"))
  assert.ok(content.indexOf("primary response") < content.indexOf(second.job_id))
  const following = await runWithAgent("session-a", () =>
    client.callTool({ name: "next_tool", arguments: { agent_id: agentId } })
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

test("ChatGPT Responses preserves reasoning summaries and function-call history", async (t) => {
  const requests: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const output = [
    {
      id: "reasoning-1",
      type: "reasoning",
      encrypted_content: "opaque-reasoning",
      summary: [{ type: "summary_text", text: "Checked the constraints." }],
    },
    {
      id: "function-1",
      type: "function_call",
      call_id: "call-1",
      name: "echo",
      arguments: JSON.stringify({ text: "ping" }),
    },
  ]
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)) as Record<string, unknown>)
    const body = [
      { type: "response.reasoning_summary_text.delta", delta: "Checked the " },
      { type: "response.reasoning_summary_text.delta", delta: "constraints." },
      { type: "response.output_text.delta", delta: "Working" },
      {
        type: "response.completed",
        response: {
          output,
          usage: { output_tokens_details: { reasoning_tokens: 42 } },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }
  const config = subagentConfigSchema.parse({
    providers: { chatgpt: { type: "openai-chatgpt" } },
    models: {
      test: {
        ...profile("chatgpt"),
        thinking: {
          mode: "effort",
          request_field: "reasoning.effort",
          levels: ["low", "medium"],
          default: "medium",
          default_enabled: true,
        },
      },
    },
  })
  const provider = config.providers.chatgpt
  const model = config.models.test
  assert.ok(provider)
  assert.ok(model)
  const input = {
    provider,
    providerId: "chatgpt",
    profile: model,
    apiKey: "fixture",
    tools: [
      { name: "echo", description: "Echo text", parameters: { type: "object", properties: {} } },
    ],
  }
  let summaryDeltas = ""
  const first = await generateAgentTurn({
    ...input,
    messages: [{ role: "user", content: "Test" }],
    onReasoningSummary: (delta) => {
      summaryDeltas += delta
    },
  })
  assert.equal(first.text, "Working")
  assert.equal(first.reasoningSummary, "Checked the constraints.")
  assert.equal(summaryDeltas, "Checked the constraints.")
  assert.equal(first.reasoningTokens, 42)
  assert.equal(first.calls[0]?.name, "echo")
  assert.deepEqual(requests[0]?.reasoning, { effort: "medium", summary: "auto" })
  const next = await generateAgentTurn({
    ...input,
    messages: [
      { role: "user", content: "Test" },
      { role: "assistant", content: first.text, calls: first.calls, rawOutput: first.rawOutput },
      { role: "tool", content: "pong", callId: "call-1", name: "echo" },
    ],
  })
  assert.equal(next.text, "Working")
  const followup = requests[1]?.input as Array<Record<string, unknown>>
  assert.equal(followup[1]?.type, "reasoning")
  assert.equal(followup[1]?.encrypted_content, "opaque-reasoning")
  assert.equal(followup[2]?.type, "function_call")
  assert.equal(followup[3]?.type, "function_call_output")
})

test("Gemini separates thought summary from answer and retains signed tool context", async (t) => {
  const requests: Array<Record<string, unknown>> = []
  const { server, url } = await listen((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    thought: true,
                    text: "Provider summary.",
                    thoughtSignature: "signed-reasoning",
                  },
                  { text: "The answer." },
                  {
                    functionCall: { name: "echo", args: { text: "ping" } },
                    thoughtSignature: "signed-call",
                  },
                ],
              },
            },
          ],
          usageMetadata: { thoughtsTokenCount: 21 },
        })
      )
    })
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const config = subagentConfigSchema.parse({
    providers: { gemini: { type: "google", base_url: `${url}/v1beta`, api_key: "fixture" } },
    models: {
      test: {
        ...profile("gemini"),
        model: "gemini-2.5-flash",
        thinking: {
          mode: "effort",
          request_field: "generationConfig.thinkingConfig.thinkingBudget",
          levels: ["low"],
          default: "low",
          default_enabled: true,
        },
      },
    },
  })
  const provider = config.providers.gemini
  const model = config.models.test
  assert.ok(provider)
  assert.ok(model)
  const input = {
    provider,
    providerId: "gemini",
    profile: model,
    apiKey: "fixture",
    tools: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: {} } }],
  }
  const first = await generateAgentTurn({
    ...input,
    messages: [{ role: "user", content: "Test" }],
  })
  assert.equal(first.text, "The answer.")
  assert.equal(first.reasoningSummary, "Provider summary.")
  assert.equal(first.reasoningTokens, 21)
  assert.equal(first.calls[0]?.name, "echo")
  assert.equal(first.rawOutput?.length, 3)
  const generation = requests[0]?.generationConfig as {
    thinkingConfig: Record<string, unknown>
  }
  assert.deepEqual(generation.thinkingConfig, { thinkingBudget: 1024, includeThoughts: true })
  await generateAgentTurn({
    ...input,
    messages: [
      { role: "user", content: "Test" },
      { role: "assistant", content: first.text, calls: first.calls, rawOutput: first.rawOutput },
      { role: "tool", content: "pong", name: "echo", callId: first.calls[0]?.id },
    ],
  })
  const contents = requests[1]?.contents as Array<{
    role: string
    parts: Array<Record<string, unknown>>
  }>
  const prior = contents.find((item) => item.role === "model")
  assert.equal(prior?.parts[0]?.thoughtSignature, "signed-reasoning")
  assert.equal(prior?.parts[2]?.thoughtSignature, "signed-call")
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
