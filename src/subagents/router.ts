import { loadSubagentConfig, type SubagentConfig, type SubagentModelProfile } from "./config.js"
import type { SubagentRunInput, SubagentRunResult, SubagentRuntime } from "./runtime.js"

export type CostTier = "low" | "medium" | "high"

export interface SmartRouteInput {
  task: string
  preferredTags?: string[]
  localOnly?: boolean
  maxCostTier?: CostTier
  minContextWindow?: number
}

export interface SmartRouteSelection {
  profile: string
  provider: string
  name: string
  model: string
  score: number
  reasons: string[]
  local: boolean
  costTier: CostTier
}

const COST_ORDER: Record<CostTier, number> = { low: 0, medium: 1, high: 2 }
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])
const WORD_RE = /[a-z0-9][a-z0-9+._-]*/gu

export class SmartModelRouter {
  constructor(
    private readonly configPath: string,
    private readonly runtime?: SubagentRuntime
  ) {}

  select(input: SmartRouteInput): SmartRouteSelection {
    const config = loadSubagentConfig(this.configPath)
    const candidates = Object.entries(config.models)
      .filter(([, model]) => model.enabled && config.providers[model.provider]?.enabled)
      .map(([id, model]) => scoreCandidate(id, model, config, input))
      .filter((candidate): candidate is SmartRouteSelection => candidate !== undefined)
      .sort((left, right) => right.score - left.score || left.profile.localeCompare(right.profile))
    const selected = candidates[0]
    if (!selected) throw new Error("No configured subagent model satisfies the routing policy.")
    return selected
  }

  async run(
    input: SmartRouteInput & Omit<SubagentRunInput, "profileId" | "task">,
    signal?: AbortSignal
  ): Promise<{ selection: SmartRouteSelection; result: SubagentRunResult }> {
    if (!this.runtime) throw new Error("Smart model routing runtime is unavailable.")
    const selection = this.select(input)
    const result = await this.runtime.run(
      {
        profileId: selection.profile,
        task: input.task,
        system: input.system,
        thinking: input.thinking,
        thinkingEffort: input.thinkingEffort,
        maxOutputTokens: input.maxOutputTokens,
      },
      signal
    )
    return { selection, result }
  }
}

function scoreCandidate(
  id: string,
  model: SubagentModelProfile,
  config: SubagentConfig,
  input: SmartRouteInput
): SmartRouteSelection | undefined {
  const provider = config.providers[model.provider]
  if (!provider) return undefined
  const local = isLocalProvider(provider.base_url)
  if (input.localOnly && !local) return undefined
  const costTier = model.cost_tier
  if (input.maxCostTier && COST_ORDER[costTier] > COST_ORDER[input.maxCostTier]) return undefined
  if (input.minContextWindow && model.context_window < input.minContextWindow) return undefined

  const taskTerms = new Set(input.task.toLowerCase().match(WORD_RE) ?? [])
  const searchable = [id, model.name, model.description, ...model.tags].join(" ").toLowerCase()
  const reasons: string[] = []
  let score = 1

  for (const term of taskTerms) {
    if (!searchable.includes(term)) continue
    score += model.tags.some((tag) => tag.toLowerCase() === term) ? 8 : 2
  }
  for (const tag of input.preferredTags ?? []) {
    if (model.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) {
      score += 12
      reasons.push(`tag:${tag}`)
    }
  }
  if (local) {
    score += 3
    reasons.push("local provider")
  }
  if (costTier === "low") {
    score += 2
    reasons.push("low cost")
  }
  if (model.context_window >= 100_000) {
    score += 1
    reasons.push("large context")
  }
  if (reasons.length === 0) reasons.push("best description/profile match")

  return {
    profile: id,
    provider: model.provider,
    name: model.name,
    model: model.model,
    score,
    reasons,
    local,
    costTier,
  }
}

function isLocalProvider(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}
