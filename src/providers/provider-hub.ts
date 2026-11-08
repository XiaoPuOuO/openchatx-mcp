import process from "node:process"

import { z } from "zod"

import { loadSubagentConfig, type SubagentConfig, saveSubagentConfig } from "../subagents/config.js"
import type { SubagentRuntime } from "../subagents/runtime.js"

const providerPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  baseUrl: z.url(),
  type: z.enum(["openai-compatible", "anthropic", "google", "openai-chatgpt"]),
  local: z.boolean(),
  requiresApiKey: z.boolean(),
})

export type ProviderPreset = z.infer<typeof providerPresetSchema>

const TRAILING_SLASH_RE = /\/$/u
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "chatgpt",
    name: "Sign in with ChatGPT (OAuth)",
    description: "Use authorized ChatGPT plan usage, separately from OpenAI API billing.",
    baseUrl: "https://api.openai.com/v1",
    type: "openai-chatgpt",
    local: false,
    requiresApiKey: false,
  },
  {
    id: "openai",
    name: "OpenAI API Key",
    description: "Use the separately billed OpenAI Platform API.",
    baseUrl: "https://api.openai.com/v1",
    type: "openai-compatible",
    local: false,
    requiresApiKey: true,
  },
  {
    id: "claude",
    name: "Claude API Key",
    description: "Anthropic Messages API.",
    baseUrl: "https://api.anthropic.com/v1",
    type: "anthropic",
    local: false,
    requiresApiKey: true,
  },
  {
    id: "gemini",
    name: "Gemini API Key",
    description: "Google Gemini generateContent API.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    type: "google",
    local: false,
    requiresApiKey: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Route model requests across many hosted providers through OpenRouter.",
    baseUrl: "https://openrouter.ai/api/v1",
    type: "openai-compatible",
    local: false,
    requiresApiKey: true,
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Run OpenAI-compatible models locally through Ollama.",
    baseUrl: "http://127.0.0.1:11434/v1",
    type: "openai-compatible",
    local: true,
    requiresApiKey: false,
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    description: "Use the local LM Studio OpenAI-compatible server.",
    baseUrl: "http://127.0.0.1:1234/v1",
    type: "openai-compatible",
    local: true,
    requiresApiKey: false,
  },
  {
    id: "vllm",
    name: "vLLM",
    description: "Use a local or LAN vLLM OpenAI-compatible server.",
    baseUrl: "http://127.0.0.1:8000/v1",
    type: "openai-compatible",
    local: true,
    requiresApiKey: false,
  },
]

export interface ProviderProbeResult {
  provider: string
  ok: boolean
  status?: number
  modelCount?: number
  error?: string
}

export class ProviderHub {
  constructor(
    private readonly configPath: string,
    private readonly runtime?: SubagentRuntime
  ) {}

  presets(): ProviderPreset[] {
    return PROVIDER_PRESETS.map((preset) => ({ ...preset }))
  }

  config(): SubagentConfig {
    return loadSubagentConfig(this.configPath)
  }

  installPreset(
    presetId: string,
    providerId = presetId,
    apiKey?: string,
    baseUrlOverride?: string
  ): SubagentConfig {
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === presetId)
    if (!preset) throw new Error(`Unknown provider preset ${JSON.stringify(presetId)}.`)
    const current = this.config()
    if (current.providers[providerId])
      throw new Error(`Provider ${JSON.stringify(providerId)} already exists.`)
    const envKeys: Record<string, string | undefined> = {
      openai: process.env.OPENAI_API_KEY,
      claude: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
    }
    const resolvedApiKey = apiKey ?? envKeys[presetId]
    if (preset.requiresApiKey && !resolvedApiKey)
      throw new Error(`Provider preset ${presetId} requires an API key.`)
    const next: SubagentConfig = {
      ...current,
      providers: {
        ...current.providers,
        [providerId]:
          preset.type === "openai-chatgpt"
            ? {
                type: "openai-chatgpt",
                enabled: true,
                timeout: 120_000,
                description: preset.description,
              }
            : {
                type: preset.type,
                base_url: baseUrlOverride ?? preset.baseUrl,
                enabled: true,
                ...(resolvedApiKey ? { api_key: resolvedApiKey } : {}),
                timeout: 120_000,
                description: preset.description,
              },
      },
    }
    const saved = saveSubagentConfig(this.configPath, next)
    this.runtime?.updateConfig(saved)
    return saved
  }

  async probe(providerId: string): Promise<ProviderProbeResult> {
    const provider = this.config().providers[providerId]
    if (!provider) throw new Error(`Unknown provider ${JSON.stringify(providerId)}.`)
    if (this.runtime) {
      try {
        const models = await this.runtime.availableModels(providerId)
        return { provider: providerId, ok: true, status: 200, modelCount: models.length }
      } catch (error) {
        return {
          provider: providerId,
          ok: false,
          error: error instanceof Error ? error.message : "Provider probe failed.",
        }
      }
    }
    if (provider.type === "openai-chatgpt")
      return { provider: providerId, ok: false, error: "ChatGPT authentication is unavailable." }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(provider.timeout, 10_000))
    const apiKey =
      provider.api_key ?? (providerId === "openai" ? process.env.OPENAI_API_KEY : undefined)
    try {
      const response = await fetch(`${provider.base_url.replace(TRAILING_SLASH_RE, "")}/models`, {
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(provider.type === "openai-compatible" ? provider.headers : {}),
        },
        signal: controller.signal,
      })
      if (!response.ok) return { provider: providerId, ok: false, status: response.status }
      const payload: unknown = await response.json().catch(() => undefined)
      const modelCount =
        typeof payload === "object" &&
        payload !== null &&
        "data" in payload &&
        Array.isArray(payload.data)
          ? payload.data.length
          : undefined
      return {
        provider: providerId,
        ok: true,
        status: response.status,
        ...(modelCount === undefined ? {} : { modelCount }),
      }
    } catch (error) {
      return {
        provider: providerId,
        ok: false,
        error: error instanceof Error ? error.message : "Provider probe failed.",
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
