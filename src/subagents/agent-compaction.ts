import { type AgentFunction, type AgentMessage, generateAgentTurn } from "./agent-provider.js"
import type { SubagentModelProfile, SubagentProviderConfig } from "./config.js"

const MIN_RESERVE_TOKENS = 1024

/** Conservative text approximation; reported token usage takes precedence when available. */
export function estimateContextTokens(messages: AgentMessage[], tools: AgentFunction[]): number {
  const messageChars = messages.reduce(
    (total, message) => total + JSON.stringify(message).length,
    0
  )
  const toolChars = tools.reduce((total, tool) => total + JSON.stringify(tool).length, 0)
  return Math.ceil((messageChars + toolChars) / 3.5)
}

export function contextCompactionDue(
  messages: AgentMessage[],
  tools: AgentFunction[],
  contextWindow?: number,
  lastInputTokens?: number
): boolean {
  if (!contextWindow || messages.length < 7) return false
  const reserve = Math.max(MIN_RESERVE_TOKENS, Math.min(16_000, Math.ceil(contextWindow * 0.15)))
  return (
    Math.max(estimateContextTokens(messages, tools), lastInputTokens ?? 0) >=
    contextWindow - reserve
  )
}

function transcriptText(message: AgentMessage): string {
  const calls = message.calls?.map((call) => ({
    tool: call.name,
    input: JSON.stringify(call.arguments).slice(0, 400),
  }))
  const text = message.content
  const snippet =
    text.length > 1800
      ? `${text.slice(0, 1050)}\n[middle of tool/message clipped]\n${text.slice(-450)}`
      : text
  return `${message.role.toUpperCase()}${message.name ? ` [${message.name}]` : ""}: ${snippet}${
    calls?.length ? `\nTool calls: ${JSON.stringify(calls)}` : ""
  }`
}

function conversationGroups(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (message.role === "tool" && last?.[0]?.role === "assistant" && last[0].calls?.length)
      last.push(message)
    else groups.push([message])
  }
  return groups
}

function shrinkTailMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "tool" || message.content.length <= 4800) return message
  return {
    ...message,
    content: `${message.content.slice(0, 2800)}\n[older tool output clipped in active context]\n${message.content.slice(-1000)}`,
  }
}

export interface CompactionParts {
  earlier: AgentMessage[]
  tail: AgentMessage[]
  retained: number
}

export function splitForCompaction(
  messages: AgentMessage[],
  contextWindow?: number,
  force = false
): CompactionParts | undefined {
  if (messages.length < 7) return undefined
  const body = messages.slice(1)
  const groups = conversationGroups(body)
  const maxTail = contextWindow
    ? Math.min(10_000, Math.max(700, Math.floor(contextWindow * (force ? 0.12 : 0.2))))
    : 2000
  let tokens = 0
  let keptGroups = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = (groups[i] ?? []).map(shrinkTailMessage)
    const cost = estimateContextTokens(group, [])
    if (keptGroups > 0 && tokens + cost > maxTail) break
    tokens += cost
    keptGroups += 1
  }
  // Keep a meaningful prefix to summarize. Never compact only a couple messages.
  if (keptGroups >= groups.length || groups.length - keptGroups < 2) return undefined
  const earlier = groups.slice(0, -keptGroups).flat()
  const tail = groups.slice(-keptGroups).flat().map(shrinkTailMessage)
  return { earlier, tail, retained: tail.length }
}

export function formatCompactionTranscript(
  messages: AgentMessage[],
  contextWindow?: number
): string {
  const maxChars = Math.max(5000, Math.min(36_000, Math.floor((contextWindow ?? 20_000) * 1.3)))
  const transcript = messages.map(transcriptText).join("\n\n")
  if (transcript.length <= maxChars) return transcript
  const front = Math.floor(maxChars * 0.45)
  const back = maxChars - front
  return `${transcript.slice(0, front)}\n\n[older middle transcript omitted to fit the summarization request]\n\n${transcript.slice(-back)}`
}

export function checkpointMessage(summary: string): AgentMessage {
  return {
    role: "user",
    content: [
      "<conversation-checkpoint>",
      summary.trim(),
      "</conversation-checkpoint>",
      "Continue the original task using this checkpoint and the newer messages below.",
    ].join("\n"),
  }
}

export interface ContextCompactionRequest {
  messages: AgentMessage[]
  profile: SubagentModelProfile
  provider: SubagentProviderConfig
  apiKey: string | undefined
  signal: AbortSignal
  plan?: Array<{ description: string; status: string }>
  force?: boolean
}

export interface ContextCompactionResult {
  active: AgentMessage[]
  summary: string
  previousCount: number
  retained: number
  usage?: Record<string, unknown>
}

export async function buildCompactedContext(
  input: ContextCompactionRequest
): Promise<ContextCompactionResult | undefined> {
  const parts = splitForCompaction(input.messages, input.profile.context_window, input.force)
  const original = input.messages[0]
  if (!parts || original?.role !== "system") return undefined
  const compactProfile: SubagentModelProfile = {
    ...input.profile,
    max_output_tokens: Math.min(input.profile.max_output_tokens ?? 1800, 1800),
    thinking: { mode: "none" },
  }
  const transcript = [
    formatCompactionTranscript(parts.earlier, input.profile.context_window),
    ...(input.plan?.length ? [`CURRENT PLAN:\n${JSON.stringify(input.plan)}`] : []),
  ].join("\n\n")
  const completed = await generateAgentTurn({
    provider: input.provider,
    providerId: input.profile.provider,
    profile: compactProfile,
    messages: [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ],
    tools: [],
    apiKey: input.apiKey,
    signal: input.signal,
  })
  if (!completed.text.trim()) throw new Error("The model returned an empty context checkpoint.")
  return {
    active: [original, checkpointMessage(completed.text), ...parts.tail],
    summary: completed.text,
    previousCount: parts.earlier.length,
    retained: parts.retained,
    ...(completed.usage ? { usage: completed.usage } : {}),
  }
}

export const COMPACTION_SYSTEM_PROMPT = [
  "You are compacting the context of an autonomous coding agent for its next turn.",
  "Produce an accurate, concise continuation checkpoint, not a new plan.",
  "Preserve user requirements, permissions, decisions, completed and active tasks, exact file paths,",
  "the status of unfinished commands, warnings, blockers, and what the agent must do next.",
  "Do not invent results or claim tests passed without evidence. Use headings:",
  "Objective, Constraints, Work Completed, Current State, Next Steps, Important Files.",
  "Respond only with the checkpoint. Do not call tools.",
].join(" ")
