import type { SubagentModelProfile } from "./config.js"
import type { SubagentRunInput } from "./runtime.js"

export type SubagentRunOverrides = Pick<
  SubagentRunInput,
  "thinking" | "thinkingEffort" | "maxOutputTokens"
>

export function overrideSubagentProfile(
  profile: SubagentModelProfile,
  input: SubagentRunOverrides
): SubagentModelProfile {
  const updated: SubagentModelProfile = { ...profile }
  if (input.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)
      throw new Error("max_output_tokens must be a positive integer.")
    if (profile.context_window && input.maxOutputTokens > profile.context_window)
      throw new Error("max_output_tokens cannot exceed the model context window.")
    updated.max_output_tokens = input.maxOutputTokens
  }
  if (input.thinking !== undefined) {
    if (profile.thinking.mode === "none" && input.thinking)
      throw new Error("Thinking is not supported by this model.")
    if (profile.thinking.mode !== "none")
      updated.thinking = { ...profile.thinking, default_enabled: input.thinking }
  }
  if (input.thinkingEffort !== undefined) {
    if (profile.thinking.mode !== "effort")
      throw new Error("thinking_effort requires a model with effort-based thinking.")
    if (!profile.thinking.levels.includes(input.thinkingEffort))
      throw new Error(`Unsupported thinking effort: ${input.thinkingEffort}.`)
    updated.thinking = {
      ...profile.thinking,
      default: input.thinkingEffort,
      default_enabled: input.thinking ?? true,
    }
  }
  return updated
}

const MODE_INSTRUCTIONS: Record<SubagentModelProfile["agent_mode"], string> = {
  build: "You can read and modify files as allowed by your tool permissions; verify your changes.",
  plan: "Plan and inspect without changing files, running mutating shell commands, or deploying.",
  explore: "Explore and research using only explicitly read-only tools; do not make changes.",
  review: "Review implementation and report actionable findings; do not modify the workspace.",
  custom: "",
}

export function subagentModeInstructions(profile: SubagentModelProfile): string {
  return [MODE_INSTRUCTIONS[profile.agent_mode], profile.system_prompt ?? ""]
    .filter(Boolean)
    .join("\n")
}
