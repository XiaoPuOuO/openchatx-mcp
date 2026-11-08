import type { ChatGPTModel } from "./chatgpt-auth.js"
import type { SubagentModelProfile, SubagentProviderConfig } from "./config.js"

type Thinking = SubagentModelProfile["thinking"]
type ProviderType = SubagentProviderConfig["type"]

const GEMINI_MODEL_PREFIX = /^models\//u
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

// Gemini generateContent thinkingLevel support is model-specific. These values are
// documented by Google; do not infer unsupported levels for unrecognized models.
const GEMINI_LEVELS: Record<string, { levels: string[]; default: string }> = {
  "gemini-3.8-flash": { levels: ["low", "medium", "high"], default: "medium" },
  "gemini-3.7-flash": { levels: ["low", "medium", "high"], default: "medium" },
  "gemini-3.6-flash": { levels: ["minimal", "low", "medium", "high"], default: "medium" },
  "gemini-3.5-flash": { levels: ["minimal", "low", "medium", "high"], default: "medium" },
  "gemini-3.5-flash-lite": { levels: ["minimal", "low", "medium", "high"], default: "minimal" },
  "gemini-3.1-pro-preview": { levels: ["low", "medium", "high"], default: "high" },
  "gemini-3.1-flash-lite-image": { levels: ["minimal", "high"], default: "minimal" },
  "gemini-3-flash-preview": { levels: ["minimal", "low", "medium", "high"], default: "high" },
  "gemini-3-pro-preview": { levels: ["low", "high"], default: "high" },
  "gemini-2.5-pro": { levels: ["low", "medium", "high"], default: "high" },
  "gemini-2.5-flash": { levels: ["low", "medium", "high"], default: "high" },
  "gemini-2.5-flash-lite": { levels: ["low", "medium", "high"], default: "medium" },
}

const OPENAI_EFFORTS: Record<string, string[]> = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
}

export function openaiThinkingConfig(id: string, chatgpt: boolean): Thinking | undefined {
  const levels = OPENAI_EFFORTS[id]
  if (!levels) return undefined
  const requestField = chatgpt ? "reasoning.effort" : "reasoning_effort"
  return {
    mode: "effort",
    request_field: requestField,
    levels,
    default: levels.includes("medium") ? "medium" : (levels[0] ?? "low"),
    ...(levels.includes("none") ? { enabled_field: requestField } : {}),
    default_enabled: true,
  }
}

export function parseProviderModel(value: unknown, type: ProviderType): ChatGPTModel | undefined {
  if (!isRecord(value)) return undefined
  const modelId = typeof value.id === "string" ? value.id : value.name
  if (typeof modelId !== "string" || !modelId) return undefined
  if (
    type === "google" &&
    Array.isArray(value.supportedGenerationMethods) &&
    !value.supportedGenerationMethods.includes("generateContent")
  )
    return undefined

  const id = type === "google" ? modelId.replace(GEMINI_MODEL_PREFIX, "") : modelId
  let name = id
  if (typeof value.display_name === "string") name = value.display_name
  else if (typeof value.displayName === "string") name = value.displayName
  const { context, maxOutput } = modelLimits(value, type)
  const thinking = modelThinking(value, type, id)
  return {
    id,
    name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(context !== undefined ? { context_window: context } : {}),
    ...(maxOutput !== undefined ? { max_output_tokens: maxOutput } : {}),
    ...(thinking ? { thinking } : {}),
  }
}

function modelLimits(model: Record<string, unknown>, type: ProviderType) {
  if (type === "anthropic")
    return {
      context: positiveInt(model.max_input_tokens),
      maxOutput: positiveInt(model.max_tokens),
    }
  if (type === "google")
    return {
      context: positiveInt(model.inputTokenLimit),
      maxOutput: positiveInt(model.outputTokenLimit),
    }
  return {
    context: positiveInt(model.context_window ?? model.context_length ?? model.max_model_len),
    maxOutput: positiveInt(model.max_output_tokens ?? model.max_tokens),
  }
}

function modelThinking(
  model: Record<string, unknown>,
  type: ProviderType,
  id: string
): Thinking | undefined {
  if (type === "anthropic") return anthropicThinking(model)
  if (type === "google") return geminiThinking(id, model)
  if (type === "openai-compatible") return openaiThinkingConfig(id, false)
  return undefined
}

function anthropicThinking(model: Record<string, unknown>): Thinking | undefined {
  const capabilities = asRecord(model.capabilities)
  const thinking = asRecord(capabilities?.thinking)
  if (thinking?.supported !== true) return undefined
  const types = asRecord(thinking.types)
  if (!capabilitySupported(types, "adaptive")) return undefined

  const effort = asRecord(capabilities?.effort)
  const levels = supportedEfforts(effort)
  if (levels.length === 0)
    return { mode: "boolean", request_field: "thinking.type", default_enabled: true }

  // Anthropic publishes per-model effort defaults; the API takes precedence.
  const documentedDefault =
    model.id === "claude-opus-5-5" || model.id === "claude-haiku-5-5" ? "medium" : "high"
  const defaultEffort = typeof effort?.default === "string" ? effort.default : documentedDefault
  return {
    mode: "effort",
    request_field: "output_config.effort",
    levels,
    default: preferredEffort(levels, defaultEffort),
    ...(capabilitySupported(types, "disabled") ? { enabled_field: "thinking.type" } : {}),
    default_enabled: true,
  }
}

function supportedEfforts(effort?: Record<string, unknown>): string[] {
  if (effort?.supported !== true) return []
  return EFFORT_ORDER.filter((key) => capabilitySupported(effort, key))
}

function capabilitySupported(parent: Record<string, unknown> | undefined, key: string): boolean {
  return asRecord(parent?.[key])?.supported === true
}

function preferredEffort(levels: string[], candidate: string): string {
  if (levels.includes(candidate)) return candidate
  if (levels.includes("medium")) return "medium"
  return levels[0] ?? "low"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function geminiThinking(id: string, model: Record<string, unknown>): Thinking | undefined {
  if (model.thinking !== true) return undefined
  const preset = GEMINI_LEVELS[id]
  if (!preset) return undefined
  const isLegacy = id.startsWith("gemini-2.5-")
  const canDisable = id.startsWith("gemini-2.5-flash")
  const requestField = isLegacy
    ? "generationConfig.thinkingConfig.thinkingBudget"
    : "generationConfig.thinkingConfig.thinkingLevel"
  return {
    mode: "effort",
    request_field: requestField,
    levels: preset.levels,
    default: preset.default,
    ...(canDisable ? { enabled_field: "generationConfig.thinkingConfig.thinkingBudget" } : {}),
    default_enabled: id !== "gemini-2.5-flash-lite",
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
