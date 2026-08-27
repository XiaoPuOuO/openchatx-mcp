export interface ChatGptSubagentOptions {
  cdpEndpoint?: string
  connectTimeoutMs?: number
  chatGptUrl?: string
  maxConcurrentAgents?: number
  minInterTurnDelayMs?: number
  interactionDelayMs?: number
  timeoutMs?: number
  persistAgents?: boolean
}

export interface ChatGptSubagentRequest {
  prompt: string
  agentId: string
  oververbosity: number
  parentSessionId?: string
}

export interface ChatGptSubagentStartResult {
  agentId: string
  turnId: string
  status: "running"
}

export interface ChatGptSubagentPollResult {
  turnId: string
  status: "running" | "completed" | "failed"
  activity?: ChatGptSubagentActivity
  activityAgeMs?: number
  response?: string
  errorCode?: string
  errorMessage?: string
}

export type ChatGptSubagentActivity = "Working" | "Searching the web" | "Using tools" | "Generating response"

export type ChatGptSubagentErrorCode =
  | "BROWSER_UNAVAILABLE"
  | "CHATGPT_NOT_AUTHENTICATED"
  | "UNKNOWN_TURN"
  | "AGENT_BUSY"
  | "SUBAGENT_CAPACITY_REACHED"
  | "SUBAGENT_RATE_LIMITED"
  | "AGENT_TARGET_LOST"
  | "AGENT_IDLE_EXPIRED"
  | "REQUEST_ABORTED"
  | "CHATGPT_UI_CHANGED"

export class ChatGptSubagentError extends Error {
  constructor(
    readonly code: ChatGptSubagentErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ChatGptSubagentError"
  }
}

export interface ChatGptSubagentService {
  ask(request: ChatGptSubagentRequest, signal?: AbortSignal): Promise<ChatGptSubagentStartResult>
  poll(turnId: string, waitMs: number, signal?: AbortSignal): Promise<ChatGptSubagentPollResult>
  drainEvents?(sessionId?: string): string[]
  parentSessionForSession?(sessionId: string): string | undefined
  observeSessionToolCall?(sessionId: string, toolName: string): string | undefined
  dispose(): Promise<void>
}
