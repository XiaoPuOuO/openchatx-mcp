import type { SubagentModelProfile, SubagentProviderConfig } from "./config.js"

export interface AgentFunction {
  name: string
  description: string
  parameters: Record<string, unknown>
}
export interface AgentFunctionCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  calls?: AgentFunctionCall[]
  callId?: string
  name?: string
  rawOutput?: unknown[]
}
export interface AgentCompletion {
  text: string
  calls: AgentFunctionCall[]
  usage?: Record<string, unknown>
  rawOutput?: unknown[]
}

export interface AgentGenerateInput {
  provider: SubagentProviderConfig
  providerId: string
  profile: SubagentModelProfile
  messages: AgentMessage[]
  tools: AgentFunction[]
  apiKey?: string
  signal?: AbortSignal
  onText?: (delta: string) => void
}

const TRAILING_SLASH = /\/$/u
const GEMINI_MODEL_PREFIX_RE = /^models\//u
const MAX_ERROR_CHARS = 450

export async function generateAgentTurn(input: AgentGenerateInput): Promise<AgentCompletion> {
  switch (input.provider.type) {
    case "openai-compatible":
      return generateChatCompletions(input)
    case "anthropic":
      return generateAnthropic(input)
    case "google":
      return generateGemini(input)
    case "openai-chatgpt":
      return generateChatGPT(input)
  }
}

function requestSignal(input: AgentGenerateInput): AbortSignal {
  const timeout = AbortSignal.timeout(input.provider.timeout)
  return input.signal ? AbortSignal.any([timeout, input.signal]) : timeout
}

function thinkingEffort(profile: SubagentModelProfile): string | undefined {
  if (profile.thinking.mode !== "effort" || !profile.thinking.default_enabled) return undefined
  return profile.thinking.default
}

function openAIMessage(item: AgentMessage): Record<string, unknown> {
  if (item.role === "tool")
    return { role: "tool", tool_call_id: item.callId, content: item.content }
  if (item.role === "assistant" && item.calls?.length)
    return {
      role: "assistant",
      content: item.content || null,
      tool_calls: item.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    }
  return { role: item.role, content: item.content }
}

function parseFunctionCalls(value: unknown): AgentFunctionCall[] {
  if (!Array.isArray(value)) return []
  const parsed: AgentFunctionCall[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const details = isRecord(item.function) ? item.function : item
    const id = typeof item.id === "string" ? item.id : undefined
    const name = typeof details.name === "string" ? details.name : undefined
    if (!id || !name) continue
    parsed.push({ id, name, arguments: parseArguments(details.arguments) })
  }
  return parsed
}

async function generateChatCompletions(input: AgentGenerateInput): Promise<AgentCompletion> {
  const provider = input.provider
  if (provider.type !== "openai-compatible") throw new Error("Invalid OpenAI-compatible provider.")
  const body: Record<string, unknown> = {
    model: input.profile.model,
    messages: input.messages.map(openAIMessage),
    ...(input.tools.length
      ? { tools: input.tools.map((tool) => ({ type: "function", function: tool })) }
      : {}),
    ...(input.profile.temperature === undefined ? {} : { temperature: input.profile.temperature }),
    ...(input.profile.max_output_tokens ? { max_tokens: input.profile.max_output_tokens } : {}),
    ...input.profile.extra_body,
  }
  if (input.profile.thinking.mode === "boolean")
    body[input.profile.thinking.request_field] = input.profile.thinking.default_enabled
  if (input.profile.thinking.mode === "effort") {
    if (input.profile.thinking.enabled_field)
      body[input.profile.thinking.enabled_field] = input.profile.thinking.default_enabled
    const effort = thinkingEffort(input.profile)
    if (effort) body[input.profile.thinking.request_field] = effort
  }
  const response = await fetch(
    `${provider.base_url.replace(TRAILING_SLASH, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...provider.headers,
      },
      body: JSON.stringify(body),
      signal: requestSignal(input),
    }
  )
  const payload: unknown = await response.json()
  ensureOk(response, payload)
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]))
    throw new Error("Chat-completions response has no choices.")
  const message = payload.choices[0].message
  if (!isRecord(message)) throw new Error("Chat-completions response has no message.")
  const text = typeof message.content === "string" ? message.content : arrayText(message.content)
  return {
    text,
    calls: parseFunctionCalls(message.tool_calls),
    ...(isRecord(payload.usage) ? { usage: payload.usage } : {}),
  }
}

function anthropicMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  for (const item of messages) {
    if (item.role === "system") continue
    if (item.role === "tool") {
      const block = { type: "tool_result", tool_use_id: item.callId, content: item.content }
      const last = output.at(-1)
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((part: unknown) => isRecord(part) && part.type === "tool_result")
      ) {
        last.content.push(block)
      } else output.push({ role: "user", content: [block] })
    } else if (item.role === "assistant") {
      const parts: Record<string, unknown>[] = []
      if (item.content) parts.push({ type: "text", text: item.content })
      for (const call of item.calls ?? [])
        parts.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })
      output.push({ role: "assistant", content: parts })
    } else output.push({ role: "user", content: item.content })
  }
  return output
}

function applyAnthropicThinking(
  body: Record<string, unknown>,
  profile: SubagentModelProfile
): void {
  const thinking = profile.thinking
  if (thinking.mode === "effort") {
    if (thinking.default_enabled) {
      body.thinking = { type: "adaptive" }
      body.output_config = { effort: thinking.default }
    } else if (thinking.enabled_field) body.thinking = { type: "disabled" }
  } else if (thinking.mode === "boolean") {
    body.thinking = { type: thinking.default_enabled ? "adaptive" : "disabled" }
  }
}

async function generateAnthropic(input: AgentGenerateInput): Promise<AgentCompletion> {
  const provider = input.provider
  if (provider.type !== "anthropic") throw new Error("Invalid Anthropic provider.")
  if (!input.apiKey) throw new Error("Anthropic API Key is required.")
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
  const body: Record<string, unknown> = {
    model: input.profile.model,
    messages: anthropicMessages(input.messages),
    max_tokens: input.profile.max_output_tokens ?? 4096,
    ...(system ? { system } : {}),
    ...(input.tools.length
      ? {
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
    ...(input.profile.temperature === undefined ? {} : { temperature: input.profile.temperature }),
    ...input.profile.extra_body,
  }
  applyAnthropicThinking(body, input.profile)
  const response = await fetch(`${provider.base_url.replace(TRAILING_SLASH, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: requestSignal(input),
  })
  const payload: unknown = await response.json()
  ensureOk(response, payload)
  return parseAnthropicCompletion(payload)
}

function parseAnthropicCompletion(payload: unknown): AgentCompletion {
  if (!isRecord(payload) || !Array.isArray(payload.content))
    throw new Error("Anthropic response contained no content.")
  const calls: AgentFunctionCall[] = []
  let text = ""
  for (const part of payload.content) {
    if (!isRecord(part)) continue
    if (part.type === "text" && typeof part.text === "string") text += part.text
    if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string")
      calls.push({ id: part.id, name: part.name, arguments: parseArguments(part.input) })
  }
  return { text, calls, ...(isRecord(payload.usage) ? { usage: payload.usage } : {}) }
}

function geminiMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  for (const item of messages) {
    if (item.role === "system") continue
    if (item.role === "tool") {
      output.push({
        role: "user",
        parts: [{ functionResponse: { name: item.name, response: { result: item.content } } }],
      })
      continue
    }
    const parts: Record<string, unknown>[] = []
    if (item.content) parts.push({ text: item.content })
    for (const call of item.calls ?? [])
      parts.push({ functionCall: { name: call.name, args: call.arguments } })
    output.push({ role: item.role === "assistant" ? "model" : "user", parts })
  }
  return output
}

function geminiGenerationConfig(profile: SubagentModelProfile): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (profile.temperature !== undefined) config.temperature = profile.temperature
  if (profile.max_output_tokens) config.maxOutputTokens = profile.max_output_tokens
  const thinking = profile.thinking
  if (thinking.mode !== "effort") return config
  if (!thinking.default_enabled) {
    if (thinking.enabled_field) config.thinkingConfig = { thinkingBudget: 0 }
    return config
  }
  if (!profile.model.startsWith("gemini-2.5-")) {
    config.thinkingConfig = { thinkingLevel: thinking.default.toUpperCase() }
    return config
  }
  const budgets: Record<string, number> = { low: 1024, medium: 8192, high: 24576 }
  config.thinkingConfig = { thinkingBudget: budgets[thinking.default] ?? 8192 }
  return config
}

async function generateGemini(input: AgentGenerateInput): Promise<AgentCompletion> {
  const provider = input.provider
  if (provider.type !== "google") throw new Error("Invalid Gemini provider.")
  if (!input.apiKey) throw new Error("Gemini API Key is required.")
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
  const generationConfig = geminiGenerationConfig(input.profile)
  const body = {
    contents: geminiMessages(input.messages),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools }] } : {}),
    ...input.profile.extra_body,
  }
  const model = encodeURIComponent(input.profile.model.replace(GEMINI_MODEL_PREFIX_RE, ""))
  const response = await fetch(
    `${provider.base_url.replace(TRAILING_SLASH, "")}/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
      body: JSON.stringify(body),
      signal: requestSignal(input),
    }
  )
  const payload: unknown = await response.json()
  ensureOk(response, payload)
  return parseGeminiCompletion(payload)
}

function parseGeminiCompletion(payload: unknown): AgentCompletion {
  if (!isRecord(payload) || !Array.isArray(payload.candidates) || !isRecord(payload.candidates[0]))
    throw new Error("Gemini response has no candidate.")
  const candidate = payload.candidates[0]
  const parts =
    isRecord(candidate.content) && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : []
  let text = ""
  const calls: AgentFunctionCall[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (typeof part.text === "string") text += part.text
    if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
      calls.push({
        id: `gemini-call-${calls.length + 1}`,
        name: part.functionCall.name,
        arguments: parseArguments(part.functionCall.args),
      })
    }
  }
  return {
    text,
    calls,
    ...(isRecord(payload.usageMetadata) ? { usage: payload.usageMetadata } : {}),
  }
}

function toResponsesInput(messages: AgentMessage[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === "tool") {
      wire.push({ type: "function_call_output", call_id: message.callId, output: message.content })
      continue
    }
    if (message.role !== "assistant" || !message.calls?.length) {
      wire.push({ role: message.role, content: message.content })
      continue
    }
    if (message.rawOutput?.length) {
      for (const item of message.rawOutput) {
        if (isRecord(item)) wire.push(item)
      }
      continue
    }
    if (message.content) wire.push({ role: "assistant", content: message.content })
    for (const call of message.calls)
      wire.push({
        type: "function_call",
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        call_id: call.id,
      })
  }
  return wire
}

async function generateChatGPT(input: AgentGenerateInput): Promise<AgentCompletion> {
  if (!input.apiKey) throw new Error("ChatGPT OAuth access token is required.")
  const wire = toResponsesInput(input.messages)
  const body: Record<string, unknown> = {
    model: input.profile.model,
    input: wire,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    ...(input.profile.max_output_tokens
      ? { max_output_tokens: input.profile.max_output_tokens }
      : {}),
    ...(input.tools.length
      ? {
          tools: input.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false,
          })),
        }
      : {}),
    ...input.profile.extra_body,
  }
  if (input.profile.thinking.mode === "effort" && input.profile.thinking.default_enabled)
    body.reasoning = { effort: input.profile.thinking.default }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify(body),
    signal: requestSignal(input),
  })
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined)
    ensureOk(response, payload)
  }
  if (!response.body) throw new Error("ChatGPT response returned no stream.")
  const { completed, text } = await readChatGPTStream(response.body, input.onText)
  return parseChatGPTCompletion(completed, text)
}

function parseChatGPTCompletion(
  completed: Record<string, unknown>,
  textDelta: string
): AgentCompletion {
  const output = Array.isArray(completed.output) ? completed.output : []
  const calls: AgentFunctionCall[] = []
  let text = textDelta
  for (const item of output) {
    if (!isRecord(item)) continue
    if (
      item.type === "function_call" &&
      typeof item.name === "string" &&
      typeof item.call_id === "string"
    )
      calls.push({ id: item.call_id, name: item.name, arguments: parseArguments(item.arguments) })
    if (item.type === "message" && !text && Array.isArray(item.content))
      text += arrayText(item.content)
  }
  return {
    text,
    calls,
    rawOutput: output,
    ...(isRecord(completed.usage) ? { usage: completed.usage } : {}),
  }
}

async function readChatGPTStream(
  stream: ReadableStream<Uint8Array>,
  onText?: (delta: string) => void
): Promise<{ completed: Record<string, unknown>; text: string }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  let completed: Record<string, unknown> | undefined
  try {
    for (;;) {
      const part = await reader.read()
      buffer += decoder.decode(part.value, { stream: !part.done })
      buffer = buffer.replace(/\r\n/gu, "\n")
      if (part.done) buffer = buffer.replace(/\r/gu, "\n")
      let offset = buffer.indexOf("\n\n")
      while (offset !== -1) {
        const block = buffer.slice(0, offset)
        buffer = buffer.slice(offset + 2)
        const event = parseSseData(block)
        if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
          text += event.delta
          onText?.(event.delta)
        }
        if (event?.type === "response.completed" && isRecord(event.response))
          completed = event.response
        if (
          event?.type === "error" ||
          event?.type === "response.failed" ||
          event?.type === "response.incomplete"
        )
          throw new Error(`ChatGPT response failed: ${errorText(event)}`)
        offset = buffer.indexOf("\n\n")
      }
      if (part.done) break
    }
  } finally {
    reader.releaseLock()
  }
  if (!completed) throw new Error("ChatGPT response stream ended before completion.")
  return { completed, text }
}

function parseSseData(block: string): Record<string, unknown> | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
  if (!data || data === "[DONE]") return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function arrayText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("")
}

function ensureOk(response: Response, payload: unknown): void {
  if (response.ok) return
  throw new Error(`Provider request failed (HTTP ${response.status}): ${errorText(payload)}`)
}

function errorText(value: unknown): string {
  const details = isRecord(value) && isRecord(value.error) ? value.error : value
  if (!isRecord(details)) return "Unknown error"
  if (typeof details.message === "string") return details.message.slice(0, MAX_ERROR_CHARS)
  if (typeof details.code === "string") return details.code
  return "Unknown error"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
