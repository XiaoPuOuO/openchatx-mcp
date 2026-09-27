import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import process from "node:process"

import type { AgentIdentity } from "../agent/context.js"
import { countTokens } from "../tokenizer.js"

const DEFAULT_WARNING_THRESHOLD = 400_000
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu
const IMAGE_MIME_PATTERN = /^image\//iu
const IMAGE_DATA_URL_PATTERN = /data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/giu
const IMAGE_OMITTED_MARKER = "[image omitted]"

interface SessionBudgetState {
  inputTokens: number
  outputTokens: number
  summaryUuid?: string
}

interface PersistedContextBudgetState {
  sessions: Record<string, SessionBudgetState>
}

export interface ContextBudgetUsage {
  tokens: number
  inputTokens: number
  outputTokens: number
  threshold: number
}

export class ContextBudgetGuard {
  private readonly sessions = new Map<string, SessionBudgetState>()
  private persistChain: Promise<void> = Promise.resolve()

  constructor(
    private warningThreshold = DEFAULT_WARNING_THRESHOLD,
    private readonly tokenCounter: (value: string) => number = countTokens,
    private readonly statePath?: string
  ) {}

  setWarningThreshold(value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError("Context warning threshold must be a positive integer.")
    }
    this.warningThreshold = value
  }

  async initialize(): Promise<void> {
    if (!this.statePath) return

    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    try {
      const raw = await readFile(this.statePath, "utf8")
      const persisted = parsePersistedState(JSON.parse(raw))
      this.sessions.clear()
      for (const [sessionId, state] of Object.entries(persisted.sessions)) {
        this.sessions.set(sessionId, state)
      }
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return
      await this.quarantineCorruptState(error)
    }
  }

  async record(
    agent: AgentIdentity | undefined,
    toolName: string,
    input: Record<string, unknown>,
    modelResult: unknown
  ): Promise<string | undefined> {
    if (!agent) return undefined
    if (toolName === "summarize" && typeof input.uuid === "string") return undefined

    const state = this.sessions.get(agent.sessionId) ?? { inputTokens: 0, outputTokens: 0 }
    state.outputTokens += this.countTextTokens(serializeTextualValue(input))

    const modelOutput = modelFacingToolResultText(modelResult)
    if (modelOutput) state.inputTokens += this.countTextTokens(modelOutput)
    const totalTokens = state.inputTokens + state.outputTokens

    if (
      totalTokens >= this.warningThreshold &&
      toolName === "summarize" &&
      typeof input.summary === "string"
    ) {
      const uuid = modelOutput?.match(UUID_PATTERN)?.[0]
      if (uuid) {
        state.summaryUuid = uuid
        this.sessions.set(agent.sessionId, state)
        await this.persist()
        return undefined
      }
    }

    this.sessions.set(agent.sessionId, state)
    await this.persist()
    if (totalTokens < this.warningThreshold) return undefined

    if (state.summaryUuid) {
      return [
        "Context budget checkpoint is ready for this long-running session",
        `(~${totalTokens.toLocaleString("en-US")} cumulative tool input/output tokens).`,
        "You MUST NOT send a normal final completion report without the handoff instructions.",
        "In your final user-facing report, explicitly tell the user to open a new ChatGPT conversation",
        "and ask OpenChatX to call `summarize` with this UUID to restore the handoff:",
        `\`${state.summaryUuid}\`.`,
        "Include the UUID verbatim. Do not omit or paraphrase this new-chat instruction.",
      ].join(" ")
    }

    return [
      "Context budget warning: this OpenChatX session has accumulated",
      `~${totalTokens.toLocaleString("en-US")} tool input/output tokens, exceeding the`,
      `${this.warningThreshold.toLocaleString("en-US")} warning threshold.`,
      "You MUST NOT send ANY final user-facing completion report yet, even if the task is already complete.",
      "Before any final report, you MUST successfully call `summarize` exactly once with a compact",
      "summary and recent_context and obtain its UUID.",
      "Only after that succeeds may you send the final report.",
      "That final report MUST include the returned UUID verbatim and MUST explicitly tell the user",
      "to open a new ChatGPT conversation and ask OpenChatX to call `summarize` with that UUID",
      "to restore the handoff. If the task is not finished, continue working first.",
    ].join(" ")
  }

  usage(agent: AgentIdentity | undefined): ContextBudgetUsage | undefined {
    if (!agent) return undefined
    const state = this.sessions.get(agent.sessionId)
    const inputTokens = state?.inputTokens ?? 0
    const outputTokens = state?.outputTokens ?? 0
    return {
      tokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      threshold: this.warningThreshold,
    }
  }

  async removeSession(sessionId: string): Promise<boolean> {
    const removed = this.sessions.delete(sessionId)
    if (removed) await this.persist()
    return removed
  }

  async close(): Promise<void> {
    await this.persistChain
  }

  private countTextTokens(value: string): number {
    const exactCountMaxChars = 128_000
    if (value.length > exactCountMaxChars) return Math.ceil(value.length / 4)
    try {
      return this.tokenCounter(value)
    } catch {
      return Math.ceil(value.length / 4)
    }
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return
    const payload: PersistedContextBudgetState = {
      sessions: Object.fromEntries(this.sessions),
    }
    const serialized = `${JSON.stringify(payload, null, 2)}\n`
    const pending = this.persistChain
      .catch(() => undefined)
      .then(() => this.writeStateAtomically(serialized))
    this.persistChain = pending
    await pending
  }

  private async writeStateAtomically(serialized: string): Promise<void> {
    if (!this.statePath) return
    const directory = dirname(this.statePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const tempPath = join(
      directory,
      `.${basename(this.statePath)}.${process.pid}.${Date.now()}.tmp`
    )
    try {
      await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 })
      await rename(tempPath, this.statePath)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async quarantineCorruptState(error: unknown): Promise<void> {
    if (!this.statePath) return
    const quarantinePath = `${this.statePath}.corrupt-${Date.now()}`
    const reason = describeError(error)
    try {
      await rename(this.statePath, quarantinePath)
      console.warn(
        `OpenChatX context budget state was invalid (${reason}) and has been quarantined to ${JSON.stringify(quarantinePath)}. Starting with an empty context budget state.`
      )
    } catch (quarantineError) {
      if (!isNodeErrorCode(quarantineError, "ENOENT")) {
        console.warn(
          `OpenChatX context budget state was invalid (${reason}) and could not be quarantined (${describeError(quarantineError)}). Starting with an empty context budget state.`
        )
      }
    }
    this.sessions.clear()
  }
}

function parsePersistedState(value: unknown): PersistedContextBudgetState {
  if (!isRecord(value) || !isRecord(value.sessions)) {
    throw new TypeError("Context budget state must contain a sessions object.")
  }
  const sessions: Record<string, SessionBudgetState> = {}
  for (const [sessionId, rawState] of Object.entries(value.sessions)) {
    const legacyTokens =
      isRecord(rawState) && typeof rawState.toolTokens === "number"
        ? rawState.toolTokens
        : undefined
    const inputTokens =
      isRecord(rawState) && typeof rawState.inputTokens === "number"
        ? rawState.inputTokens
        : legacyTokens
    const outputTokens =
      isRecord(rawState) && typeof rawState.outputTokens === "number" ? rawState.outputTokens : 0
    if (
      !isRecord(rawState) ||
      typeof inputTokens !== "number" ||
      !Number.isFinite(inputTokens) ||
      inputTokens < 0 ||
      !Number.isFinite(outputTokens) ||
      outputTokens < 0 ||
      (rawState.summaryUuid !== undefined && typeof rawState.summaryUuid !== "string")
    ) {
      throw new TypeError(`Invalid context budget state for session ${JSON.stringify(sessionId)}.`)
    }
    sessions[sessionId] = {
      inputTokens,
      outputTokens,
      ...(typeof rawState.summaryUuid === "string" ? { summaryUuid: rawState.summaryUuid } : {}),
    }
  }
  return { sessions }
}

function modelFacingToolResultText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const parts: string[] = []
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      const serialized = serializeModelFacingContentItem(item)
      if (serialized !== undefined) parts.push(serialized)
    }
  }
  if (value.structuredContent !== undefined) {
    parts.push(serializeTextualValue(value.structuredContent))
  }
  return parts.length > 0 ? parts.join("\n") : undefined
}

function serializeModelFacingContentItem(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined
  if (!record) return undefined
  if (record.type === "text" && typeof record.text === "string") {
    return sanitizeTextContent(record.text)
  }
  if (record.type === "image" || record.type === "audio") return undefined
  if (record.type === "resource") {
    const resource = isRecord(record.resource) ? record.resource : undefined
    if (resource && typeof resource.blob === "string") return undefined
  }
  return serializeTextualValue(record)
}

function serializeTextualValue(value: unknown): string {
  return JSON.stringify(sanitizeTextualValue(value))
}

function sanitizeTextualValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeTextContent(value)
  if (Array.isArray(value)) return value.map(sanitizeTextualValue)
  if (!isRecord(value)) return value

  if (isImagePayloadRecord(value)) {
    return {
      ...Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "data")
          .map(([key, nested]) => [key, sanitizeTextualValue(nested)])
      ),
      data: IMAGE_OMITTED_MARKER,
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, sanitizeTextualValue(nested)])
  )
}

function isImagePayloadRecord(value: Record<string, unknown>): boolean {
  return (
    typeof value.mimeType === "string" &&
    IMAGE_MIME_PATTERN.test(value.mimeType) &&
    typeof value.data === "string" &&
    value.data.length >= 1_024
  )
}

function sanitizeTextContent(value: string): string {
  const parsed = tryParseJson(value)
  if (parsed !== undefined) return JSON.stringify(sanitizeTextualValue(parsed))
  return value.replace(IMAGE_DATA_URL_PATTERN, IMAGE_OMITTED_MARKER)
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? "Unknown error"
  } catch {
    return "Unknown error"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
