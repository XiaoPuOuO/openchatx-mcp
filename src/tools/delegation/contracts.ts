import { z } from "zod"

export const chatGptDelegationStatusSchema = z.enum(["running", "completed", "failed"])
export const chatGptDelegationActivitySchema = z.enum([
  "Working",
  "Searching the web",
  "Using tools",
  "Generating response",
])

type ChatGptDelegationStatus = z.infer<typeof chatGptDelegationStatusSchema>
export type ChatGptDelegationActivity = z.infer<typeof chatGptDelegationActivitySchema>

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

export interface ChatGptDelegationCallContext {
  signal?: AbortSignal
}

export interface ChatGptDelegationPollResult {
  status: ChatGptDelegationStatus
  activity?: ChatGptDelegationActivity
  activityAgeMs?: number
  response?: string
  errorCode?: string
  errorMessage?: string
}

export type ChatGptDelegationErrorCode =
  | "BROWSER_UNAVAILABLE"
  | "CHATGPT_NOT_AUTHENTICATED"
  | "UNKNOWN_TURN"
  | "AGENT_BUSY"
  | "AGENT_LIMIT_REACHED"
  | "SUBAGENT_RATE_LIMITED"
  | "AGENT_TARGET_LOST"
  | "AGENT_IDLE_EXPIRED"
  | "TEMP_AGENT_EXPIRED"
  | "SUBAGENT_PERSISTENCE_UNAVAILABLE"
  | "REQUEST_ABORTED"
  | "CHATGPT_UI_CHANGED"

export class ChatGptDelegationError extends Error {
  constructor(
    readonly code: ChatGptDelegationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ChatGptDelegationError"
  }
}

export interface ChatGptDelegationService {
  ask(request: ChatGptSubagentRequest, context: ChatGptDelegationCallContext): Promise<string>
  cloneSelf(
    request: ChatGptCloneSelfRequest,
    context: ChatGptDelegationCallContext
  ): Promise<string>
  cloneRun(request: ChatGptCloneRunRequest, context: ChatGptDelegationCallContext): Promise<string>
  poll(turnId: string, waitMs: number, signal?: AbortSignal): Promise<ChatGptDelegationPollResult>
  drainEvents(): string[]
  dispose(): Promise<void>
}
