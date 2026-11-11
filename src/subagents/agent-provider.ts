import { AgentProviderHttpError, parseRetryAfterMs } from "./agent-recovery.js"
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
export interface AgentAttachment {
  type: "image" | "audio"
  mimeType: string
  data: string
}
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  attachments?: AgentAttachment[]
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
  reasoningSummary?: string
  reasoningTokens?: number
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
  onReasoningSummary?: (delta: string) => void
}

const TRAILING_SLASH = /\/$/u
const GEMINI_MODEL_PREFIX_RE = /^models\//u
const SSE_DONE_RE = /^data:\s*\[DONE\]\s*$/mu
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

function thinkingEffort(profile: SubagentModelProfile): string | undefined {
  if (profile.thinking.mode !== "effort" || !profile.thinking.default_enabled) return undefined
  return profile.thinking.default
}

function imageDataUrl(part: AgentAttachment): string {
  return `data:${part.mimeType};base64,${part.data}`
}

function openAIMessage(item: AgentMessage): Record<string, unknown> {
  if (item.role === "user" && item.attachments?.length)
    return {
      role: "user",
      content: [
        { type: "text", text: item.content },
        ...item.attachments.map((part) =>
          part.type === "image"
            ? { type: "image_url", image_url: { url: imageDataUrl(part) } }
            : {
                type: "input_audio",
                input_audio: {
                  data: part.data,
                  format: part.mimeType.includes("mp3") ? "mp3" : "wav",
                },
              }
        ),
      ],
    }
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

function reasoningUsage(usage: Record<string, unknown>): { reasoningTokens?: number } {
  let details: Record<string, unknown> | undefined
  if (isRecord(usage.output_tokens_details)) details = usage.output_tokens_details
  else if (isRecord(usage.completion_tokens_details)) details = usage.completion_tokens_details
  const count = details?.reasoning_tokens ?? usage.thoughtsTokenCount
  return typeof count === "number" && Number.isFinite(count) && count > 0
    ? { reasoningTokens: count }
    : {}
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

function applyChatCompletionThinking(
  body: Record<string, unknown>,
  profile: SubagentModelProfile
): void {
  const thinking = profile.thinking
  if (thinking.mode === "boolean") body[thinking.request_field] = thinking.default_enabled
  if (thinking.mode === "effort") {
    if (thinking.enabled_field) body[thinking.enabled_field] = thinking.default_enabled
    const effort = thinkingEffort(profile)
    if (effort) body[thinking.request_field] = effort
  }
}

async function generateChatCompletions(input: AgentGenerateInput): Promise<AgentCompletion> {
  const provider = input.provider
  if (provider.type !== "openai-compatible") throw new Error("Invalid OpenAI-compatible provider.")
  const stream = Boolean(input.onText ?? input.onReasoningSummary)
  const body: Record<string, unknown> = {
    model: input.profile.model,
    messages: input.messages.map(openAIMessage),
    ...(input.tools.length
      ? { tools: input.tools.map((tool) => ({ type: "function", function: tool })) }
      : {}),
    ...(input.profile.temperature === undefined ? {} : { temperature: input.profile.temperature }),
    ...(input.profile.max_output_tokens ? { max_tokens: input.profile.max_output_tokens } : {}),
    ...input.profile.extra_body,
    ...(stream ? { stream: true } : {}),
  }
  applyChatCompletionThinking(body, input.profile)
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
      signal: input.signal,
    }
  )
  if (response.ok && isSseResponse(response)) {
    if (!response.body) throw new Error("Chat-completions stream has no body.")
    return readChatCompletionStream(response.body, input.onText, input.onReasoningSummary)
  }
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
    ...(isRecord(payload.usage)
      ? {
          usage: payload.usage,
          ...reasoningUsage(payload.usage),
        }
      : {}),
  }
}

interface ChatCompletionStreamState {
  text: string
  thinking: string
  usage?: Record<string, unknown>
  finished: boolean
  calls: Map<number, { id: string; name: string; args: string }>
}

function appendChatToolFragments(
  fragments: unknown,
  calls: ChatCompletionStreamState["calls"]
): void {
  if (!Array.isArray(fragments)) return
  for (const item of fragments) {
    if (!isRecord(item)) continue
    const index = typeof item.index === "number" ? item.index : 0
    const current = calls.get(index) ?? { id: "", name: "", args: "" }
    if (typeof item.id === "string") current.id += item.id
    if (isRecord(item.function)) {
      if (typeof item.function.name === "string") current.name += item.function.name
      if (typeof item.function.arguments === "string") current.args += item.function.arguments
    }
    calls.set(index, current)
  }
}

function updateChatCompletionDelta(
  delta: Record<string, unknown>,
  state: ChatCompletionStreamState,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): void {
  if (typeof delta.content === "string") {
    state.text += delta.content
    onText?.(delta.content)
  }
  if (typeof delta.reasoning_content === "string") {
    state.thinking += delta.reasoning_content
    onReasoningSummary?.(delta.reasoning_content)
  }
  appendChatToolFragments(delta.tool_calls, state.calls)
}

function updateChatCompletionStream(
  event: Record<string, unknown> | null,
  state: ChatCompletionStreamState,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): void {
  if (!event) {
    state.finished = true
    return
  }
  if (event.error) throw new Error(`Chat-completions stream failed: ${errorText(event)}`)
  if (isRecord(event.usage)) state.usage = event.usage
  if (!Array.isArray(event.choices) || !isRecord(event.choices[0])) return
  const choice = event.choices[0]
  if (typeof choice.finish_reason === "string") {
    if (choice.finish_reason === "length" || choice.finish_reason === "content_filter")
      throw new Error(`Chat-completions stopped: ${choice.finish_reason}`)
    state.finished = true
  }
  if (isRecord(choice.delta))
    updateChatCompletionDelta(choice.delta, state, onText, onReasoningSummary)
}

function completeChatToolCalls(calls: ChatCompletionStreamState["calls"]): AgentFunctionCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!call.id || !call.name)
        throw new Error("Chat-completions returned an incomplete function call.")
      let argumentsValue: unknown
      try {
        argumentsValue = JSON.parse(call.args)
      } catch (cause) {
        throw new Error("Chat-completions returned malformed tool arguments.", { cause })
      }
      if (!isRecord(argumentsValue))
        throw new Error("Chat-completions tool arguments must be an object.")
      return { id: call.id, name: call.name, arguments: argumentsValue }
    })
}

async function readChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): Promise<AgentCompletion> {
  const state: ChatCompletionStreamState = {
    text: "",
    thinking: "",
    finished: false,
    calls: new Map(),
  }
  for await (const event of readSseFrames(stream))
    updateChatCompletionStream(event, state, onText, onReasoningSummary)
  if (!state.finished) throw new Error("Chat-completions stream ended before completion.")
  return {
    text: state.text,
    calls: completeChatToolCalls(state.calls),
    ...(state.thinking ? { reasoningSummary: state.thinking } : {}),
    ...(state.usage ? { usage: state.usage, ...reasoningUsage(state.usage) } : {}),
  }
}

function isSseResponse(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") ?? false
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
      if (item.rawOutput?.length) {
        // Claude requires the original signed thinking/tool blocks, unchanged,
        // when continuing a tool-use turn.
        output.push({ role: "assistant", content: item.rawOutput })
        continue
      }
      const parts: Record<string, unknown>[] = []
      if (item.content) parts.push({ type: "text", text: item.content })
      for (const call of item.calls ?? [])
        parts.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })
      output.push({ role: "assistant", content: parts })
    } else if (item.attachments?.length) {
      output.push({
        role: "user",
        content: [
          { type: "text", text: item.content },
          ...item.attachments.map((part) =>
            part.type === "image"
              ? {
                  type: "image",
                  source: { type: "base64", media_type: part.mimeType, data: part.data },
                }
              : {
                  type: "text",
                  text: `[Audio attachment (${part.mimeType}) cannot be read by Anthropic's text API.]`,
                }
          ),
        ],
      })
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
  const stream = Boolean(input.onText ?? input.onReasoningSummary)
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
  if (stream) body.stream = true
  const response = await fetch(`${provider.base_url.replace(TRAILING_SLASH, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (response.ok && isSseResponse(response)) {
    if (!response.body) throw new Error("Anthropic stream has no body.")
    return readAnthropicStream(response.body, input.onText, input.onReasoningSummary)
  }
  const payload: unknown = await response.json()
  ensureOk(response, payload)
  return parseAnthropicCompletion(payload)
}

function parseAnthropicCompletion(payload: unknown): AgentCompletion {
  if (!isRecord(payload) || !Array.isArray(payload.content))
    throw new Error("Anthropic response contained no content.")
  const calls: AgentFunctionCall[] = []
  const thinking: string[] = []
  const rawOutput: Record<string, unknown>[] = []
  let text = ""
  for (const part of payload.content) {
    if (!isRecord(part)) continue
    rawOutput.push(part)
    if (part.type === "text" && typeof part.text === "string") text += part.text
    if (part.type === "thinking" && typeof part.thinking === "string") thinking.push(part.thinking)
    if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string")
      calls.push({ id: part.id, name: part.name, arguments: parseArguments(part.input) })
  }
  return {
    text,
    calls,
    rawOutput,
    ...(thinking.length ? { reasoningSummary: thinking.join("\n\n") } : {}),
    ...(isRecord(payload.usage) ? { usage: payload.usage } : {}),
  }
}

interface AnthropicStreamState {
  blocks: Map<number, Record<string, unknown>>
  jsonInputs: Map<number, string>
  usage: Record<string, unknown>
  finished: boolean
}

function updateAnthropicStreamStatus(
  event: Record<string, unknown>,
  state: AnthropicStreamState
): void {
  if (event.type === "error") throw new Error(`Anthropic stream failed: ${errorText(event)}`)
  if (event.type === "message_start" && isRecord(event.message) && isRecord(event.message.usage))
    state.usage = { ...state.usage, ...event.message.usage }
  if (event.type === "message_delta") {
    if (isRecord(event.usage)) state.usage = { ...state.usage, ...event.usage }
    if (isRecord(event.delta) && event.delta.stop_reason === "max_tokens")
      throw new Error("Anthropic stream stopped at max_tokens.")
  }
  if (event.type === "message_stop") state.finished = true
}

function updateAnthropicBlockDelta(
  index: number,
  block: Record<string, unknown>,
  delta: Record<string, unknown>,
  state: AnthropicStreamState,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): void {
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    block.text = String(block.text ?? "") + delta.text
    onText?.(delta.text)
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    block.thinking = String(block.thinking ?? "") + delta.thinking
    onReasoningSummary?.(delta.thinking)
  }
  if (delta.type === "signature_delta" && typeof delta.signature === "string")
    block.signature = String(block.signature ?? "") + delta.signature
  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string")
    state.jsonInputs.set(index, (state.jsonInputs.get(index) ?? "") + delta.partial_json)
}

function finishAnthropicToolInput(
  index: number,
  block: Record<string, unknown>,
  state: AnthropicStreamState
): void {
  if (!state.jsonInputs.has(index)) return
  let parsed: unknown
  try {
    parsed = JSON.parse(state.jsonInputs.get(index) ?? "")
  } catch (cause) {
    throw new Error("Anthropic stream returned invalid tool arguments.", { cause })
  }
  if (!isRecord(parsed)) throw new Error("Anthropic tool arguments must be an object.")
  block.input = parsed
  state.jsonInputs.delete(index)
}

function updateAnthropicStreamBlock(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): void {
  const index = typeof event.index === "number" ? event.index : undefined
  if (index === undefined) return
  if (event.type === "content_block_start" && isRecord(event.content_block))
    state.blocks.set(index, { ...event.content_block })
  const block = state.blocks.get(index)
  if (!block) return
  if (event.type === "content_block_delta" && isRecord(event.delta))
    updateAnthropicBlockDelta(index, block, event.delta, state, onText, onReasoningSummary)
  if (event.type === "content_block_stop") finishAnthropicToolInput(index, block, state)
}

async function readAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): Promise<AgentCompletion> {
  const state: AnthropicStreamState = {
    blocks: new Map(),
    jsonInputs: new Map(),
    usage: {},
    finished: false,
  }
  for await (const event of readSseFrames(stream)) {
    if (!event) continue
    updateAnthropicStreamStatus(event, state)
    updateAnthropicStreamBlock(event, state, onText, onReasoningSummary)
  }
  if (!state.finished) throw new Error("Anthropic stream ended before message_stop.")
  if (state.jsonInputs.size) throw new Error("Anthropic stream ended during a tool call.")
  return parseAnthropicCompletion({
    content: [...state.blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value),
    usage: state.usage,
  })
}

function geminiParts(item: AgentMessage): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []
  if (item.role === "assistant" && item.rawOutput?.length) {
    for (const part of item.rawOutput) {
      if (isRecord(part)) parts.push(part)
    }
    return parts
  }
  if (item.content) parts.push({ text: item.content })
  for (const attachment of item.attachments ?? [])
    parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } })
  for (const call of item.calls ?? [])
    parts.push({ functionCall: { name: call.name, args: call.arguments } })
  return parts
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
    output.push({ role: item.role === "assistant" ? "model" : "user", parts: geminiParts(item) })
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
    config.thinkingConfig = { thinkingLevel: thinking.default.toUpperCase(), includeThoughts: true }
    return config
  }
  const budgets: Record<string, number> = { low: 1024, medium: 8192, high: 24576 }
  config.thinkingConfig = {
    thinkingBudget: budgets[thinking.default] ?? 8192,
    includeThoughts: true,
  }
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
  const stream = Boolean(input.onText ?? input.onReasoningSummary)
  const endpoint = stream ? "streamGenerateContent?alt=sse" : "generateContent"
  const response = await fetch(
    `${provider.base_url.replace(TRAILING_SLASH, "")}/models/${model}:${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
      body: JSON.stringify(body),
      signal: input.signal,
    }
  )
  if (response.ok && isSseResponse(response)) {
    if (!response.body) throw new Error("Gemini stream has no body.")
    return readGeminiStream(response.body, input.onText, input.onReasoningSummary)
  }
  const payload: unknown = await response.json()
  ensureOk(response, payload)
  return parseGeminiCompletion(payload)
}

interface GeminiStreamState {
  parts: Record<string, unknown>[]
  usage?: Record<string, unknown>
  finished: boolean
}

function appendGeminiStreamParts(
  candidate: Record<string, unknown>,
  state: GeminiStreamState,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): void {
  if (!isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) return
  for (const part of candidate.content.parts) {
    if (!isRecord(part)) continue
    state.parts.push(part)
    if (typeof part.text !== "string") continue
    if (part.thought === true) onReasoningSummary?.(part.text)
    else onText?.(part.text)
  }
}

function updateGeminiStream(
  payload: Record<string, unknown>,
  state: GeminiStreamState,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): void {
  if (payload.error) throw new Error(`Gemini stream failed: ${errorText(payload)}`)
  if (isRecord(payload.usageMetadata)) state.usage = payload.usageMetadata
  if (!Array.isArray(payload.candidates) || !isRecord(payload.candidates[0])) return
  const candidate = payload.candidates[0]
  if (typeof candidate.finishReason === "string") {
    if (candidate.finishReason !== "STOP")
      throw new Error(`Gemini generation stopped: ${candidate.finishReason}`)
    state.finished = true
  }
  appendGeminiStreamParts(candidate, state, onText, onReasoningSummary)
}

async function readGeminiStream(
  stream: ReadableStream<Uint8Array>,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): Promise<AgentCompletion> {
  const state: GeminiStreamState = { parts: [], finished: false }
  for await (const payload of readSseFrames(stream))
    if (payload) updateGeminiStream(payload, state, onText, onReasoningSummary)
  if (!state.finished) throw new Error("Gemini stream ended before finishReason.")
  return parseGeminiCompletion({
    candidates: [{ content: { parts: state.parts } }],
    ...(state.usage ? { usageMetadata: state.usage } : {}),
  })
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
  const summaries: string[] = []
  const calls: AgentFunctionCall[] = []
  const rawOutput: Record<string, unknown>[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    // Preserve signed thought parts for Gemini's multi-turn function-call history.
    rawOutput.push(part)
    if (part.thought === true) {
      // Provider-supplied thought summary is distinct from the final answer.
      if (typeof part.text === "string" && part.text.trim()) summaries.push(part.text)
      continue
    }
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
    rawOutput,
    ...(summaries.length ? { reasoningSummary: summaries.join("\n\n") } : {}),
    ...(isRecord(payload.usageMetadata)
      ? { usage: payload.usageMetadata, ...reasoningUsage(payload.usageMetadata) }
      : {}),
  }
}

function responseUserMedia(message: AgentMessage): Record<string, unknown> {
  return {
    role: "user",
    content: [
      { type: "input_text", text: message.content },
      ...(message.attachments ?? []).map((part) =>
        part.type === "image"
          ? { type: "input_image", image_url: imageDataUrl(part) }
          : {
              type: "input_audio",
              input_audio: {
                data: part.data,
                format: part.mimeType.includes("mp3") ? "mp3" : "wav",
              },
            }
      ),
    ],
  }
}

function appendResponsesAssistant(wire: Record<string, unknown>[], message: AgentMessage): void {
  if (message.content) wire.push({ role: "assistant", content: message.content })
  for (const call of message.calls ?? [])
    wire.push({
      type: "function_call",
      name: call.name,
      arguments: JSON.stringify(call.arguments),
      call_id: call.id,
    })
}

function toResponsesInput(messages: AgentMessage[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === "tool") {
      wire.push({ type: "function_call_output", call_id: message.callId, output: message.content })
      continue
    }
    if (message.role === "assistant" && message.rawOutput?.length) {
      for (const item of message.rawOutput) {
        if (isRecord(item)) wire.push(item)
      }
      continue
    }
    if (message.role === "user" && message.attachments?.length) {
      wire.push(responseUserMedia(message))
      continue
    }
    if (message.role !== "assistant" || !message.calls?.length) {
      wire.push({ role: message.role, content: message.content })
      continue
    }
    appendResponsesAssistant(wire, message)
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
    body.reasoning = { effort: input.profile.thinking.default, summary: "auto" }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined)
    ensureOk(response, payload)
  }
  if (!response.body) throw new Error("ChatGPT response returned no stream.")
  const { completed, text, summary } = await readChatGPTStream(
    response.body,
    input.onText,
    input.onReasoningSummary
  )
  return parseChatGPTCompletion(completed, text, summary)
}

function responseReasoningSummary(output: unknown[]): string {
  const summaries: string[] = []
  for (const item of output) {
    if (!isRecord(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) continue
    for (const part of item.summary) {
      if (
        isRecord(part) &&
        part.type === "summary_text" &&
        typeof part.text === "string" &&
        part.text.trim()
      )
        summaries.push(part.text)
    }
  }
  return summaries.join("\n\n").trim()
}

function parseChatGPTCompletion(
  completed: Record<string, unknown>,
  textDelta: string,
  summaryDelta = ""
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
  const reasoningSummary = responseReasoningSummary(output) || summaryDelta.trim()
  return {
    text,
    calls,
    rawOutput: output,
    ...(reasoningSummary ? { reasoningSummary } : {}),
    ...(isRecord(completed.usage)
      ? { usage: completed.usage, ...reasoningUsage(completed.usage) }
      : {}),
  }
}

interface ChatGPTStreamState {
  text: string
  summary: string
  completed?: Record<string, unknown>
}

function updateChatGPTStream(
  event: Record<string, unknown> | undefined,
  state: ChatGPTStreamState,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): void {
  if (!event) return
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    state.text += event.delta
    onText?.(event.delta)
  }
  if (event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
    state.summary += event.delta
    onReasoningSummary?.(event.delta)
  }
  if (event.type === "response.completed" && isRecord(event.response))
    state.completed = event.response
  if (
    event.type === "error" ||
    event.type === "response.failed" ||
    event.type === "response.incomplete"
  )
    throw new Error(`ChatGPT response failed: ${errorText(event)}`)
}

async function readChatGPTStream(
  stream: ReadableStream<Uint8Array>,
  onText?: (delta: string) => void,
  onReasoningSummary?: (delta: string) => void
): Promise<{ completed: Record<string, unknown>; text: string; summary: string }> {
  const state: ChatGPTStreamState = { text: "", summary: "" }
  for await (const event of readSseFrames(stream))
    if (event) updateChatGPTStream(event, state, onText, onReasoningSummary)
  if (!state.completed) throw new Error("ChatGPT response stream ended before completion.")
  return { ...state, completed: state.completed }
}

/** Shared SSE decoder: handles UTF-8 and delimiters split across network chunks. */
async function* readSseFrames(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown> | null> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
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
        if (SSE_DONE_RE.test(block)) yield null
        else {
          const event = parseSseData(block)
          if (event) yield event
        }
        offset = buffer.indexOf("\n\n")
      }
      if (part.done) break
    }
  } finally {
    reader.releaseLock()
  }
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
  throw new AgentProviderHttpError(
    response.status,
    errorText(payload),
    parseRetryAfterMs(response.headers)
  )
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
