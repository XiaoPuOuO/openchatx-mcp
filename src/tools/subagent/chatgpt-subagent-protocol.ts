import { asRecord } from "../../utils.js"
import type { ChatGptSubagentActivity } from "./chatgpt-subagent-contracts.js"

export interface ChatGptTurnCompletion {
  text: string
  conversationId?: string
  turnId?: string
}

interface NormalizedMessage {
  role?: string
  status?: string
  endTurn?: boolean | null
  recipient?: string | null
  text: string
}

/** Reconstruct exactly one submitted ChatGPT turn from either HTTP SSE or a turn WebSocket topic. */
export class ChatGptTurnTracker {
  private sourceId?: string
  private sourceTurnId?: string
  private conversationId?: string
  private assistant?: NormalizedMessage
  private lastDeltaPath?: string
  private lastDeltaOperation?: string
  private complete = false

  constructor(
    private readonly prompt: string,
    private readonly onActivity?: (activity: ChatGptSubagentActivity) => void,
    private readonly onConversationId?: (conversationId: string) => void
  ) {}

  ingestFrame(payloadData: string): ChatGptTurnCompletion | undefined {
    const parsed = tryParseJson(payloadData)
    if (parsed === undefined) return undefined
    let completion: ChatGptTurnCompletion | undefined

    visitObjects(parsed, (record) => {
      const topicId = stringValue(record.topic_id)
      const envelope = asRecord(record.payload)
      if (!topicId?.startsWith("conversation-turn-") || envelope?.type !== "conversation-turn-stream") return
      const payload = asRecord(envelope.payload)
      if (!payload) return

      if (payload.type === "done") {
        if (this.sourceId !== topicId) return
        this.captureConversationId(payload)
        this.complete = true
        completion = this.result() ?? completion
        return
      }
      if (payload.type !== "stream-item") return

      const encodedItem = stringValue(payload.encoded_item)
      if (!encodedItem) return
      completion = this.ingestStream(encodedItem, topicId, topicId.slice("conversation-turn-".length)) ?? completion
    })

    return completion
  }

  ingestSse(text: string): ChatGptTurnCompletion | undefined {
    return this.ingestStream(text, "http")
  }

  private ingestStream(text: string, sourceId: string, turnId?: string): ChatGptTurnCompletion | undefined {
    for (const item of parseResponsePayloads(text)) {
      const record = asRecord(item)
      if (!record) continue

      const value = asRecord(record.v)
      const message = value ? normalizeMessage(value) : undefined
      if (message?.role === "user" && promptsMatch(message.text, this.prompt)) this.bind(sourceId, turnId)

      const inputMessage = asRecord(record.input_message)
      const input = inputMessage ? normalizeMessage({ message: inputMessage }) : undefined
      if (input?.role === "user" && promptsMatch(input.text, this.prompt)) this.bind(sourceId, turnId)

      if (this.sourceId !== sourceId) continue
      this.captureConversationId(record)
      this.onActivity?.(message ? classifyActivity(message) : "Working")

      if (message?.role === "assistant") {
        this.assistant = { ...message }
        this.lastDeltaPath = undefined
        this.lastDeltaOperation = undefined
      }

      this.applyDelta(record)
      if (record.type === "message_stream_complete") this.complete = true
    }

    return this.result()
  }

  private bind(sourceId: string, turnId?: string): void {
    if (this.sourceId) return
    this.sourceId = sourceId
    this.sourceTurnId = turnId
  }

  private captureConversationId(record: Record<string, unknown>): void {
    const conversationId = stringValue(record.conversation_id)
    if (this.conversationId || !conversationId) return
    this.conversationId = conversationId
    this.onConversationId?.(conversationId)
  }

  private applyDelta(delta: Record<string, unknown>): void {
    if (!this.assistant) return
    const explicitOperation = stringValue(delta.o)
    const operation = explicitOperation || this.lastDeltaOperation
    if (operation === "patch" && Array.isArray(delta.v)) {
      for (const nested of delta.v) {
        const record = asRecord(nested)
        if (record) this.applyDelta(record)
      }
      return
    }

    const explicitPath = stringValue(delta.p)
    const path = explicitPath || this.lastDeltaPath
    if (explicitPath) this.lastDeltaPath = explicitPath
    if (explicitOperation) this.lastDeltaOperation = explicitOperation
    if (!path) return

    if (operation === "append" && path === "/message/content/parts/0" && typeof delta.v === "string") {
      this.assistant.text += delta.v
      this.onActivity?.("Generating response")
    } else if (operation === "replace" && path === "/message/status" && typeof delta.v === "string") {
      this.assistant.status = delta.v
    } else if (operation === "replace" && path === "/message/end_turn" && typeof delta.v === "boolean") {
      this.assistant.endTurn = delta.v
    } else if (operation === "replace" && path === "/message/recipient" && (typeof delta.v === "string" || delta.v === null)) {
      this.assistant.recipient = delta.v as string | null
    }
  }

  private result(): ChatGptTurnCompletion | undefined {
    if (!this.complete || !this.sourceId || !this.assistant) return undefined
    if (this.assistant.status !== "finished_successfully" || this.assistant.endTurn !== true) return undefined
    if (this.assistant.recipient && this.assistant.recipient !== "all") return undefined
    if (!this.assistant.text) return undefined
    return { text: this.assistant.text, conversationId: this.conversationId, turnId: this.sourceTurnId }
  }
}

function promptsMatch(observed: string, submitted: string): boolean {
  return normalizePrompt(observed) === normalizePrompt(submitted)
}

function normalizePrompt(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim()
}

function normalizeMessage(record: Record<string, unknown>): NormalizedMessage | undefined {
  const message = asRecord(record.message)
  if (!message) return undefined
  const author = asRecord(message.author)
  if (!author) return undefined
  return {
    role: stringValue(author.role),
    status: stringValue(message.status),
    endTurn: typeof message.end_turn === "boolean" || message.end_turn === null ? (message.end_turn as boolean | null) : undefined,
    recipient: typeof message.recipient === "string" || message.recipient === null ? (message.recipient as string | null) : undefined,
    text: extractMessageText(asRecord(message.content)),
  }
}

function extractMessageText(content?: Record<string, unknown>): string {
  if (!content) return ""
  if (Array.isArray(content.parts)) return content.parts.filter((part): part is string => typeof part === "string").join("\n")
  return stringValue(content.text) ?? ""
}

function classifyActivity(message: NormalizedMessage): ChatGptSubagentActivity {
  const recipient = message.recipient?.toLowerCase()
  if (recipient && recipient !== "all") return recipient.includes("web") || recipient.includes("search") ? "Searching the web" : "Using tools"
  return message.role === "assistant" ? "Generating response" : "Working"
}

function parseResponsePayloads(text: string): unknown[] {
  const payloads: unknown[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line === "data: [DONE]") continue
    const candidate = line.startsWith("data:") ? line.slice(5).trim() : line
    const parsed = tryParseJson(candidate)
    if (parsed !== undefined) payloads.push(parsed)
  }
  return payloads
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function visitObjects(value: unknown, visitor: (record: Record<string, unknown>) => void, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, visitor, seen)
    return
  }
  const record = value as Record<string, unknown>
  visitor(record)
  for (const nested of Object.values(record)) visitObjects(nested, visitor, seen)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export interface ConversationMessage {
  role: "user" | "assistant"
  text: string
}

export function findLatestAssistantAfterPrompt(
  messages: readonly ConversationMessage[],
  prompt: string,
  expectedUserTurnCount: number
): ConversationMessage | undefined {
  const userTurnCount = messages.filter((message) => message.role === "user").length
  if (userTurnCount !== expectedUserTurnCount) return undefined

  let promptIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user" && message.text.trim() === prompt.trim()) {
      promptIndex = index
      break
    }
  }
  if (promptIndex < 0) return undefined

  for (let index = messages.length - 1; index > promptIndex; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant" && message.text) return message
  }
  return undefined
}

/** Normalize conversation history for the one-shot recovery check and frozen fixtures. */
export function extractConversationMessages(payload: unknown): ConversationMessage[] {
  const root = asRecord(payload)
  if (Array.isArray(root?.messages)) return root.messages.map(messageFromRaw).filter((value): value is ConversationMessage => value !== undefined)
  const current = stringValue(root?.current_node)
  const mapping = asRecord(root?.mapping)
  if (!current || !mapping) return []
  const branch: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let id: string | undefined = current
  while (id && !seen.has(id)) {
    seen.add(id)
    const node = asRecord(mapping[id])
    if (!node) break
    branch.push(node)
    id = stringValue(node.parent)
  }
  return branch
    .reverse()
    .map((node) => messageFromRaw(node.message))
    .filter((value): value is ConversationMessage => value !== undefined)
}

function messageFromRaw(value: unknown): ConversationMessage | undefined {
  const message = asRecord(value)
  const author = asRecord(message?.author)
  const role = stringValue(author?.role)
  const text = extractMessageText(asRecord(message?.content))
  if (!text || (role !== "user" && role !== "assistant")) return undefined
  if (role === "assistant") {
    if (message?.end_turn !== true) return undefined
    const recipient = message.recipient
    if (recipient && recipient !== "all") return undefined
  }
  return { role, text }
}
