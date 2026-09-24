import { type FSWatcher, watch } from "node:fs"
import { basename, dirname } from "node:path"

import {
  loadSubagentConfig,
  type SubagentConfig,
  type SubagentModelProfile,
  type SubagentProviderConfig,
} from "./config.js"

const TRAILING_SLASH_RE = /\/$/u

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

export class SubagentRuntime {
  private watcher?: FSWatcher
  private reloadTimer?: NodeJS.Timeout

  constructor(private config: SubagentConfig) {}

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
        thinking: profile.thinking,
      }))
  }

  async run(input: SubagentRunInput, signal?: AbortSignal): Promise<SubagentRunResult> {
    const profile = this.config.models[input.profileId]
    if (!profile?.enabled)
      throw new Error(`Unknown or disabled subagent profile ${JSON.stringify(input.profileId)}.`)
    const provider = this.config.providers[profile.provider]
    if (!provider?.enabled)
      throw new Error(`Provider ${JSON.stringify(profile.provider)} is disabled.`)
    return runOpenAiCompatible(profile, provider, input, signal)
  }
}

async function runOpenAiCompatible(
  profile: SubagentModelProfile,
  provider: SubagentProviderConfig,
  input: SubagentRunInput,
  signal?: AbortSignal
): Promise<SubagentRunResult> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error("Subagent request timed out.")),
    provider.timeout
  )
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", abort, { once: true })

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
    const maxOutputTokens = resolveMaxOutputTokens(profile.max_output_tokens, input.maxOutputTokens)
    if (maxOutputTokens !== undefined) body.max_tokens = maxOutputTokens
    applyThinking(profile, input, body)

    const response = await fetch(
      `${provider.base_url.replace(TRAILING_SLASH_RE, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
          ...provider.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    )
    const rawPayload: unknown = await response.json()
    if (!isRecord(rawPayload)) throw new Error("Provider response must be a JSON object.")
    const payload = rawPayload
    if (!response.ok) {
      throw new Error(`Provider request failed (${response.status}): ${JSON.stringify(payload)}`)
    }
    const content = extractContent(payload)
    return {
      profile: input.profileId,
      provider: profile.provider,
      model: profile.model,
      content,
      ...(isRecord(payload.usage) ? { usage: payload.usage } : {}),
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
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
  if (profile.thinking.enabled_field) {
    body[profile.thinking.enabled_field] = thinkingEnabled
  }
  if (!thinkingEnabled) return

  const effort = input.thinkingEffort ?? profile.thinking.default
  if (!profile.thinking.levels.includes(effort)) {
    throw new Error(
      `thinking_effort must be one of ${profile.thinking.levels.join(", ")} for ${profile.name}.`
    )
  }
  body[profile.thinking.request_field] = effort
}

function extractContent(payload: Record<string, unknown>): string {
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new Error("Provider response did not contain choices[0].")
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
