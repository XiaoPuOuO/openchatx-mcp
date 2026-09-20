import { z } from "zod"

export const chatGptSubagentStatusSchema = z.enum(["running", "completed", "failed"])
export const chatGptSubagentActivitySchema = z.enum(["Working", "Searching the web", "Using tools", "Generating response"])

export type ChatGptSubagentStatus = z.infer<typeof chatGptSubagentStatusSchema>
export type ChatGptSubagentActivity = z.infer<typeof chatGptSubagentActivitySchema>

export interface ChatGptSubagentRequest {
  prompt: string
  agentId: string
  memory: boolean
}

export interface ChatGptCloneSelfRequest {
  sourceConversationUrl: string
  cloneId: string
  prompt: string
}

export interface ChatGptCloneRunRequest {
  cloneId: string
  prompt: string
}

export interface ChatGptSubagentCallContext {
  signal?: AbortSignal
}

export interface ChatGptSubagentPollResult {
  status: ChatGptSubagentStatus
  activity?: ChatGptSubagentActivity
  activityAgeMs?: number
  response?: string
  errorCode?: string
  errorMessage?: string
}

export type ChatGptSubagentErrorCode =
  | "BROWSER_UNAVAILABLE"
  | "CHATGPT_NOT_AUTHENTICATED"
  | "UNKNOWN_TURN"
  | "AGENT_BUSY"
  | "AGENT_LIMIT_REACHED"
  | "SUBAGENT_RATE_LIMITED"
  | "AGENT_TARGET_LOST"
  | "AGENT_IDLE_EXPIRED"
  | "TEMP_AGENT_EXPIRED"
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
  ask(request: ChatGptSubagentRequest, context: ChatGptSubagentCallContext): Promise<string>
  cloneSelf(request: ChatGptCloneSelfRequest, context: ChatGptSubagentCallContext): Promise<string>
  cloneRun(request: ChatGptCloneRunRequest, context: ChatGptSubagentCallContext): Promise<string>
  poll(turnId: string, waitMs: number, signal?: AbortSignal): Promise<ChatGptSubagentPollResult>
  drainEvents(): string[]
  dispose(): Promise<void>
}
