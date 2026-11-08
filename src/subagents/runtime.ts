import { randomUUID } from "node:crypto"
import { type FSWatcher, watch } from "node:fs"
import { basename, dirname } from "node:path"
import process from "node:process"
import type { AgentObserver } from "../agent/observer.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import type { RuntimeControlService } from "../runtime/runtime-control.js"
import {
  type SubagentSessionSnapshot,
  type SubagentSessionSummary,
  SubagentSessions,
} from "./agent-sessions.js"
import type { ChatGPTAuth, ChatGPTModel } from "./chatgpt-auth.js"
import {
  loadSubagentConfig,
  type SubagentConfig,
  type SubagentModelProfile,
  type SubagentProviderConfig,
} from "./config.js"
import { parseProviderModel } from "./model-metadata.js"

const TRAILING_SLASH_RE = /\/$/u
const GEMINI_MODEL_PREFIX_RE = /^models\//u
const MAX_JOBS = 150
const MAX_ACTIVE = 8
const JOB_TTL_MS = 24 * 60 * 60_000

export interface SubagentRunInput {
  profileId: string
  task: string
  system?: string
  thinking?: boolean
  thinkingEffort?: string
  maxOutputTokens?: number
}

export interface SubagentRunResult {
  profile: string
  model: string
  provider: string
  content: string
  usage?: Record<string, unknown>
}

export type SubagentJobStatus = "running" | "completed" | "failed"
export interface SubagentJob {
  job_id: string
  profile: string
  status: SubagentJobStatus
  created_at: string
  updated_at: string
  result?: SubagentRunResult
  error?: string
}

interface OwnedJob extends SubagentJob {
  owner: string
  notified: boolean
}

export class SubagentRuntime {
  private watcher?: FSWatcher
  private reloadTimer?: NodeJS.Timeout
  private readonly jobs = new Map<string, OwnedJob>()
  private sessions?: SubagentSessions

  constructor(
    private config: SubagentConfig,
    private readonly chatgpt?: Pick<ChatGPTAuth, "accessToken" | "models">
  ) {}

  enableAgentSessions(
    factory: McpServerFactory,
    observer: AgentObserver,
    storagePath: string,
    runtimeControl?: RuntimeControlService
  ): void {
    if (this.sessions) return
    this.sessions = new SubagentSessions(
      {
        limits: () => this.config.limits,
        ...(runtimeControl ? { approvalScopes: runtimeControl } : {}),
        tools: factory,
        observer,
        resolveProfile: (id) => this.lookup(id),
        apiKey: async (provider, providerId) => {
          if (provider.type !== "openai-chatgpt") return providerApiKey(provider, providerId)
          if (!this.chatgpt) throw new Error("ChatGPT authentication is unavailable.")
          return this.chatgpt.accessToken()
        },
      },
      storagePath
    )
  }

  removeOwnerSession(sessionId: string): number {
    return this.sessions?.removeOwnerSession(sessionId) ?? 0
  }

  limits(): SubagentConfig["limits"] {
    return this.config.limits
  }

  deleteSession(id: string, owner?: string): number {
    if (!this.sessions) throw new Error("Subagent sessions are unavailable.")
    return this.sessions.deleteSession(id, owner)
  }

  listSessions(): SubagentSessionSummary[] {
    return this.sessions?.list() ?? []
  }

  sessionSnapshot(id: string): SubagentSessionSnapshot {
    if (!this.sessions) throw new Error("Subagent sessions are unavailable.")
    return this.sessions.snapshot(id)
  }

  steerSession(id: string, message: string, owner?: string): SubagentSessionSnapshot {
    if (!this.sessions) throw new Error("Subagent sessions are unavailable.")
    return this.sessions.steer(id, message, owner)
  }

  updateConfig(config: SubagentConfig): void {
    this.config = config
  }

  startWatching(configPath: string): void {
    this.watcher?.close()
    this.watcher = watch(dirname(configPath), (_event, filename) => {
      if (filename && filename.toString() !== basename(configPath)) return
      if (this.reloadTimer) clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => {
        try {
          this.updateConfig(loadSubagentConfig(configPath))
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error"
          console.warn(`Subagent config reload failed: ${message}`)
        }
      }, 150)
      this.reloadTimer.unref()
    })
  }

  close(): void {
    this.watcher?.close()
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.sessions?.close()
    this.sessions = undefined
  }

  providerSummaries() {
    return Object.entries(this.config.providers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, provider]) => ({
        id,
        type: provider.type,
        enabled: provider.enabled,
        profileCount: Object.values(this.config.models).filter(
          (model) => model.provider === id && model.enabled
        ).length,
      }))
  }

  profiles() {
    return Object.entries(this.config.models)
      .filter(([, profile]) => profile.enabled && this.config.providers[profile.provider]?.enabled)
      .map(([id, profile]) => ({
        id,
        name: profile.name,
        description: profile.description,
        provider: profile.provider,
        model: profile.model,
        context_window: profile.context_window,
        max_output_tokens: profile.max_output_tokens,
        execution_mode: profile.execution_mode,
        tags: profile.tags,
        cost_tier: profile.cost_tier,
        thinking: profile.thinking,
      }))
  }

  executionMode(profileId: string): "sync" | "async" {
    return this.lookup(profileId).profile.execution_mode ?? "sync"
  }

  async availableModels(providerId: string): Promise<ChatGPTModel[]> {
    const provider = this.config.providers[providerId]
    if (!provider?.enabled)
      throw new Error(`Unknown or disabled provider ${JSON.stringify(providerId)}.`)
    if (provider.type === "openai-chatgpt") {
      if (!this.chatgpt) throw new Error("ChatGPT authentication is not configured.")
      return this.chatgpt.models()
    }
    const key = providerApiKey(provider, providerId)
    if ((provider.type === "anthropic" || provider.type === "google") && !key)
      throw new Error("An API key is required to discover models.")
    const base = provider.base_url.replace(TRAILING_SLASH_RE, "")
    const url = provider.type === "google" ? `${base}/models?pageSize=1000` : `${base}/models`
    const headers = discoveryHeaders(provider, key)
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(Math.min(provider.timeout, 20_000)),
    })
    if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status}).`)
    const data: unknown = await response.json()
    if (!isRecord(data)) throw new Error("Model discovery returned an invalid payload.")
    const list = provider.type === "google" ? data.models : data.data
    if (!Array.isArray(list)) throw new Error("Model discovery did not return a model list.")
    return list.flatMap((model): ChatGPTModel[] => {
      const parsed = parseProviderModel(model, provider.type)
      return parsed ? [parsed] : []
    })
  }

  async modelDetails(providerId: string, modelId: string): Promise<ChatGPTModel> {
    const provider = this.config.providers[providerId]
    if (!provider?.enabled)
      throw new Error(`Unknown or disabled provider ${JSON.stringify(providerId)}.`)
    if (!modelId) throw new Error("Model ID is required.")
    if (provider.type === "openai-chatgpt") {
      if (!this.chatgpt) throw new Error("ChatGPT authentication is unavailable.")
      const found = (await this.chatgpt.models()).find((model) => model.id === modelId)
      if (!found) throw new Error(`ChatGPT model ${JSON.stringify(modelId)} is not available.`)
      return found
    }
    const key = providerApiKey(provider, providerId)
    if ((provider.type === "anthropic" || provider.type === "google") && !key)
      throw new Error("An API key is required to retrieve model details.")
    const base = provider.base_url.replace(TRAILING_SLASH_RE, "")
    const response = await fetch(`${base}/models/${encodeURIComponent(modelId)}`, {
      headers: discoveryHeaders(provider, key),
      signal: AbortSignal.timeout(Math.min(provider.timeout, 20_000)),
    })
    if (!response.ok) throw new Error(`Model detail lookup failed (HTTP ${response.status}).`)
    const payload: unknown = await response.json()
    const details = parseProviderModel(payload, provider.type)
    if (!details) throw new Error("Provider returned invalid model details.")
    return { ...details, id: modelId }
  }

  startAsync(input: SubagentRunInput, owner: string): SubagentJob {
    if (this.sessions) return this.sessions.startAsync(input, owner)
    this.lookup(input.profileId)
    this.pruneJobs()
    const running = [...this.jobs.values()].filter((entry) => entry.status === "running").length
    if (running >= MAX_ACTIVE)
      throw new Error("Too many concurrent subagents. Retrieve or wait for a running job.")
    const now = new Date().toISOString()
    const job: OwnedJob = {
      job_id: `subagent-${randomUUID()}`,
      profile: input.profileId,
      status: "running",
      created_at: now,
      updated_at: now,
      owner,
      notified: false,
    }
    this.jobs.set(job.job_id, job)
    // The task outlives the MCP request. Its lifetime is not tied to the caller's AbortSignal.
    void Promise.resolve()
      .then(() => this.run(input))
      .then(
        (result) => {
          job.result = result
          job.status = "completed"
        },
        (error: unknown) => {
          job.error = error instanceof Error ? error.message : String(error)
          job.status = "failed"
        }
      )
      .finally(() => {
        job.updated_at = new Date().toISOString()
      })
    return publicJob(job)
  }

  getJob(id: string, owner: string): SubagentJob {
    if (this.sessions) return this.sessions.getJob(id, owner)
    const job = this.jobs.get(id)
    if (!job || job.owner !== owner) throw new Error(`Unknown subagent job ${JSON.stringify(id)}.`)
    if (job.status !== "running") job.notified = true
    return publicJob(job)
  }

  drainNotifications(owner: string): string[] {
    if (this.sessions) return this.sessions.drainNotifications(owner)
    const messages: string[] = []
    for (const job of this.jobs.values()) {
      if (job.owner !== owner || job.notified || job.status === "running") continue
      job.notified = true
      messages.push(
        `Subagent job ${job.job_id} ${job.status}. Call subagent_get with job_id="${job.job_id}" to retrieve the result.`
      )
    }
    return messages
  }

  async run(input: SubagentRunInput, signal?: AbortSignal): Promise<SubagentRunResult> {
    if (this.sessions) return this.sessions.run(input, signal)
    const { profile, provider } = this.lookup(input.profileId)
    switch (provider.type) {
      case "openai-compatible":
        return runOpenAiCompatible(profile, provider, input, signal)
      case "anthropic":
        return runAnthropic(profile, provider, input, signal)
      case "google":
        return runGemini(profile, provider, input, signal)
      case "openai-chatgpt":
        if (!this.chatgpt) throw new Error("ChatGPT authentication is unavailable.")
        return runChatGPT(profile, provider, input, await this.chatgpt.accessToken(), signal)
    }
  }

  private lookup(profileId: string): {
    profile: SubagentModelProfile
    provider: SubagentProviderConfig
  } {
    const profile = this.config.models[profileId]
    if (!profile?.enabled)
      throw new Error(`Unknown or disabled subagent profile ${JSON.stringify(profileId)}.`)
    const provider = this.config.providers[profile.provider]
    if (!provider?.enabled)
      throw new Error(`Provider ${JSON.stringify(profile.provider)} is disabled.`)
    return { profile, provider }
  }

  private pruneJobs(): void {
    const cutoff = Date.now() - JOB_TTL_MS
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && new Date(job.updated_at).getTime() < cutoff)
        this.jobs.delete(id)
    }
    const finished = [...this.jobs.values()].filter((job) => job.status !== "running")
    while (this.jobs.size >= MAX_JOBS && finished.length > 0) {
      const job = finished.shift()
      if (job) this.jobs.delete(job.job_id)
    }
  }
}

function publicJob(job: OwnedJob): SubagentJob {
  return {
    job_id: job.job_id,
    profile: job.profile,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

function providerApiKey(provider: SubagentProviderConfig, id: string): string | undefined {
  if (provider.type === "openai-chatgpt") return undefined
  if (provider.api_key) return provider.api_key
  if (provider.type === "anthropic") return process.env.ANTHROPIC_API_KEY
  if (provider.type === "google") return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  return id === "openai" ? process.env.OPENAI_API_KEY : undefined
}

function requestSignal(
  timeoutMs: number,
  signal?: AbortSignal
): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController()
  if (signal?.aborted) controller.abort(signal.reason)
  const timer = setTimeout(
    () => controller.abort(new Error("Subagent request timed out.")),
    timeoutMs
  )
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", abort, { once: true })
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    },
  }
}

async function runOpenAiCompatible(
  profile: SubagentModelProfile,
  provider: Extract<SubagentProviderConfig, { type: "openai-compatible" }>,
  input: SubagentRunInput,
  signal?: AbortSignal
): Promise<SubagentRunResult> {
  const request = requestSignal(provider.timeout, signal)
  try {
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: [
        ...(input.system ? [{ role: "system", content: input.system }] : []),
        { role: "user", content: input.task },
      ],
      ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
      ...profile.extra_body,
    }
    const max = resolveMaxOutputTokens(profile.max_output_tokens, input.maxOutputTokens)
    if (max !== undefined) body.max_tokens = max
    applyThinking(profile, input, body)
    const apiKey = providerApiKey(provider, profile.provider)
    const response = await fetch(
      `${provider.base_url.replace(TRAILING_SLASH_RE, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...provider.headers,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      }
    )
    const payload: unknown = await response.json()
    if (!isRecord(payload)) throw new Error("Provider response must be a JSON object.")
    if (!response.ok)
      throw new Error(
        `Provider request failed (HTTP ${response.status}): ${safeProviderError(payload)}`
      )
    return withResult(input, profile, extractContent(payload), payload.usage)
  } finally {
    request.close()
  }
}

async function runAnthropic(
  profile: SubagentModelProfile,
  provider: Extract<SubagentProviderConfig, { type: "anthropic" }>,
  input: SubagentRunInput,
  signal?: AbortSignal
): Promise<SubagentRunResult> {
  const apiKey = providerApiKey(provider, profile.provider)
  if (!apiKey) throw new Error("Anthropic API Key is not configured.")
  const request = requestSignal(provider.timeout, signal)
  try {
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: [{ role: "user", content: input.task }],
      ...(input.system ? { system: input.system } : {}),
      max_tokens: resolveMaxOutputTokens(profile.max_output_tokens, input.maxOutputTokens) ?? 4096,
      ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
      ...profile.extra_body,
    }
    if (profile.thinking.mode === "effort") {
      if (input.thinking ?? profile.thinking.default_enabled) {
        body.thinking = { type: "adaptive" }
        body.output_config = { effort: resolveEffort(profile, input) }
      } else if (profile.thinking.enabled_field === "thinking.type") {
        body.thinking = { type: "disabled" }
      }
    } else if (profile.thinking.mode === "boolean") {
      body.thinking = {
        type: (input.thinking ?? profile.thinking.default_enabled) ? "adaptive" : "disabled",
      }
    }
    const response = await fetch(`${provider.base_url.replace(TRAILING_SLASH_RE, "")}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    })
    const payload: unknown = await response.json()
    if (!response.ok)
      throw new Error(
        `Anthropic request failed (HTTP ${response.status}): ${safeProviderError(payload)}`
      )
    if (!isRecord(payload) || !Array.isArray(payload.content))
      throw new Error("Invalid Anthropic response.")
    const content = payload.content
      .map((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""
      )
      .join("")
    return withResult(input, profile, content, payload.usage)
  } finally {
    request.close()
  }
}

async function runGemini(
  profile: SubagentModelProfile,
  provider: Extract<SubagentProviderConfig, { type: "google" }>,
  input: SubagentRunInput,
  signal?: AbortSignal
): Promise<SubagentRunResult> {
  const apiKey = providerApiKey(provider, profile.provider)
  if (!apiKey) throw new Error("Gemini API Key is not configured.")
  const request = requestSignal(provider.timeout, signal)
  try {
    const generationConfig: Record<string, unknown> = {
      ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
    }
    const max = resolveMaxOutputTokens(profile.max_output_tokens, input.maxOutputTokens)
    if (max !== undefined) generationConfig.maxOutputTokens = max
    applyGeminiThinking(profile, input, generationConfig)
    const body = {
      contents: [{ role: "user", parts: [{ text: input.task }] }],
      ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...profile.extra_body,
    }
    const model = encodeURIComponent(profile.model.replace(GEMINI_MODEL_PREFIX_RE, ""))
    const response = await fetch(
      `${provider.base_url.replace(TRAILING_SLASH_RE, "")}/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: request.signal,
      }
    )
    const payload: unknown = await response.json()
    if (!response.ok)
      throw new Error(
        `Gemini request failed (HTTP ${response.status}): ${safeProviderError(payload)}`
      )
    if (!isRecord(payload) || !Array.isArray(payload.candidates))
      throw new Error("Invalid Gemini response.")
    const candidate = payload.candidates[0]
    const content =
      isRecord(candidate) && isRecord(candidate.content) && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
            .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
            .join("")
        : ""
    if (!content) throw new Error("Gemini did not return text content.")
    return withResult(input, profile, content, payload.usageMetadata)
  } finally {
    request.close()
  }
}

function applyGeminiThinking(
  profile: SubagentModelProfile,
  input: SubagentRunInput,
  generationConfig: Record<string, unknown>
): void {
  if (profile.thinking.mode !== "effort") return
  const enabled = input.thinking ?? profile.thinking.default_enabled
  if (!enabled) {
    if (profile.thinking.enabled_field) generationConfig.thinkingConfig = { thinkingBudget: 0 }
    return
  }
  if (!profile.model.startsWith("gemini-2.5-")) {
    generationConfig.thinkingConfig = { thinkingLevel: resolveEffort(profile, input).toUpperCase() }
    return
  }
  const budgets: Record<string, number> = { low: 1024, medium: 8192, high: 24576 }
  const effort = resolveEffort(profile, input)
  const budget = budgets[effort]
  if (!budget) throw new Error(`Unsupported thinking effort ${effort} for ${profile.model}.`)
  generationConfig.thinkingConfig = { thinkingBudget: budget }
}

async function runChatGPT(
  profile: SubagentModelProfile,
  provider: Extract<SubagentProviderConfig, { type: "openai-chatgpt" }>,
  input: SubagentRunInput,
  token: string,
  signal?: AbortSignal
): Promise<SubagentRunResult> {
  const request = requestSignal(provider.timeout, signal)
  try {
    const body: Record<string, unknown> = {
      model: profile.model,
      input: input.task,
      ...(input.system ? { instructions: input.system } : {}),
      store: false,
      stream: true,
    }
    const max = resolveMaxOutputTokens(profile.max_output_tokens, input.maxOutputTokens)
    if (max !== undefined) body.max_output_tokens = max
    if (profile.thinking.mode === "effort") {
      const enabled = input.thinking ?? profile.thinking.default_enabled
      if (enabled) body.reasoning = { effort: resolveEffort(profile, input) }
      else if (profile.thinking.levels.includes("none")) body.reasoning = { effort: "none" }
    }
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    })
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined)
      throw new Error(
        `ChatGPT inference failed (HTTP ${response.status}): ${safeProviderError(payload)}`
      )
    }
    if (!response.body) throw new Error("ChatGPT inference returned no event stream.")
    return withResult(input, profile, ...(await readChatGPTEvents(response.body)))
  } finally {
    request.close()
  }
}

export async function readChatGPTEvents(
  body: ReadableStream<Uint8Array>
): Promise<[string, Record<string, unknown> | undefined]> {
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  let usage: Record<string, unknown> | undefined
  let completed = false
  let errorMessage: string | undefined
  const reader = body.getReader()
  const processBlock = (block: string): void => {
    const value = parseChatGPTStreamEvent(block)
    if (!value) return
    switch (value.type) {
      case "response.output_text.delta":
        if (typeof value.delta === "string") text += value.delta
        break
      case "response.completed": {
        completed = true
        if (isRecord(value.response)) {
          if (isRecord(value.response.usage)) usage = value.response.usage
          if (!text) text = extractResponseOutputText(value.response)
        }
        break
      }
      case "response.failed":
      case "error":
        errorMessage = safeProviderError(value)
        break
      case "response.incomplete":
        errorMessage = "ChatGPT response was incomplete."
        break
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      // Normalize the accumulated buffer, not individual chunks: CRLF can straddle reads.
      buffer = buffer.replace(/\r\n/gu, "\n")
      if (done) buffer = buffer.replace(/\r/gu, "\n")
      let end = buffer.indexOf("\n\n")
      while (end !== -1) {
        processBlock(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf("\n\n")
      }
      if (done) {
        if (buffer.trim()) processBlock(buffer)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (errorMessage) throw new Error(`ChatGPT response failed: ${errorMessage}`)
  if (!completed) throw new Error("ChatGPT response stream ended before completion.")
  if (!text) throw new Error("ChatGPT response contained no text.")
  return [text, usage]
}

function parseChatGPTStreamEvent(block: string): Record<string, unknown> | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function extractResponseOutputText(response: Record<string, unknown>): string {
  return Array.isArray(response.output)
    ? response.output
        .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
        .map((part) =>
          isRecord(part) && part.type === "output_text" && typeof part.text === "string"
            ? part.text
            : ""
        )
        .join("")
    : ""
}

function withResult(
  input: SubagentRunInput,
  profile: SubagentModelProfile,
  content: string,
  usage?: unknown
): SubagentRunResult {
  return {
    profile: input.profileId,
    provider: profile.provider,
    model: profile.model,
    content,
    ...(isRecord(usage) ? { usage } : {}),
  }
}

function resolveMaxOutputTokens(
  profileLimit: number | undefined,
  requested: number | undefined
): number | undefined {
  if (requested === undefined) return profileLimit
  if (profileLimit === undefined) return requested
  return Math.min(requested, profileLimit)
}

function resolveEffort(profile: SubagentModelProfile, input: SubagentRunInput): string {
  if (profile.thinking.mode !== "effort") throw new Error("Thinking effort is not configured.")
  const effort = input.thinkingEffort ?? profile.thinking.default
  if (!profile.thinking.levels.includes(effort))
    throw new Error(
      `thinking_effort must be one of ${profile.thinking.levels.join(", ")} for ${profile.name}.`
    )
  return effort
}

function applyThinking(
  profile: SubagentModelProfile,
  input: SubagentRunInput,
  body: Record<string, unknown>
): void {
  if (profile.thinking.mode === "none") return
  if (profile.thinking.mode === "boolean") {
    body[profile.thinking.request_field] = input.thinking ?? profile.thinking.default_enabled
    return
  }
  const thinkingEnabled = input.thinking ?? profile.thinking.default_enabled
  if (profile.thinking.enabled_field) body[profile.thinking.enabled_field] = thinkingEnabled
  if (!thinkingEnabled) return
  body[profile.thinking.request_field] = resolveEffort(profile, input)
}

function extractContent(payload: Record<string, unknown>): string {
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0]))
    throw new Error("Provider response did not contain choices[0].")
  const message = choices[0].message
  if (!isRecord(message)) throw new Error("Provider response did not contain a message.")
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
  }
  throw new Error("Provider response did not contain text content.")
}

function safeProviderError(payload: unknown): string {
  if (!isRecord(payload)) return "No error details."
  const error = isRecord(payload.error) ? payload.error : payload
  if (typeof error.message === "string") return error.message.slice(0, 500)
  if (typeof error.code === "string") return error.code
  return "No error details."
}

function discoveryHeaders(
  provider: Exclude<SubagentProviderConfig, { type: "openai-chatgpt" }>,
  key?: string
): Record<string, string> {
  if (provider.type === "anthropic")
    return { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" }
  if (provider.type === "google") return { "x-goog-api-key": key ?? "" }
  return { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...provider.headers }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
