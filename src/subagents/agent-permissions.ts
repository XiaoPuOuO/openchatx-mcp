import type { SubagentModelProfile } from "./config.js"

export type ToolDecision = "allow" | "ask" | "deny"
type ToolPolicy = Pick<
  SubagentModelProfile,
  "agent_mode" | "permissions" | "read_only" | "allowed_paths"
>
const TOOL_ID_SEPARATOR = /[.:/]/u
const PATH_SCOPED_TOOLS = new Set([
  "start_here",
  "skill_search",
  "tool_search",
  "subagent_plan",
  "agent_program",
  "file_read",
  "file_write",
  "file_edit",
  "grep",
  "glob",
  "apply_patch",
])

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const parts = pattern.split("*")
  let index = 0
  for (const [i, part] of parts.entries()) {
    if (!part) continue
    const found = value.indexOf(part, index)
    if (found < 0 || (i === 0 && found !== 0)) return false
    index = found + part.length
  }
  const last = parts.at(-1)
  return !last || value.endsWith(last)
}

/** An Agent can only restrict the shared runtime permissions, never override them. */
function policyFor(profile: ToolPolicy, name: string): ToolDecision {
  const matches = Object.entries(profile.permissions)
    .filter(([pattern]) => patternMatches(pattern, name))
    .sort(([left], [right]) => left.length - right.length)
  return matches.at(-1)?.[1] ?? "allow"
}

function mustRemainReadOnly(profile: ToolPolicy): boolean {
  return profile.read_only || ["plan", "explore", "review"].includes(profile.agent_mode)
}

/** An Agent can only restrict the shared runtime permissions, never override them. */
export function toolDecision(
  profile: ToolPolicy,
  name: string,
  readOnly: boolean,
  args?: Record<string, unknown>
): ToolDecision {
  const strictReadOnly = mustRemainReadOnly(profile)
  if (profile.allowed_paths?.length && !PATH_SCOPED_TOOLS.has(name)) return "deny"
  if (strictReadOnly && name === "tool_call") return "deny"
  if (strictReadOnly && !readOnly) {
    // Project selection changes only the session's routing context. Hide all
    // mutation-capable project actions from read-only agents.
    if (name === "subagent_plan") return policyFor(profile, name)
    if (name !== "project_manage") return "deny"
    if (args && !["use", "resolve", "list"].includes(String(args.action ?? ""))) return "deny"
  }
  const wrapper = policyFor(profile, name)
  if (name !== "tool_call" || !args) return wrapper
  const target = typeof args.tool === "string" ? args.tool : undefined
  if (!target) return "deny"
  const suffix = target.split(TOOL_ID_SEPARATOR).at(-1) ?? target
  const targetDecision = [policyFor(profile, target), policyFor(profile, suffix)]
  const policies = [wrapper, ...targetDecision]
  if (policies.includes("deny")) return "deny"
  if (policies.includes("ask")) return "ask"
  return "allow"
}
