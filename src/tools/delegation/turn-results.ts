import type { ChatGptDelegationPollResult, ChatGptDelegationService } from "./contracts.js"

export interface DelegatedTurnResult {
  turn_id: string
  status: ChatGptDelegationPollResult["status"]
  activity?: ChatGptDelegationPollResult["activity"]
  activity_age_ms?: number
  response?: string
  error?: string
}

interface PollDelegatedTurnsOptions {
  service: ChatGptDelegationService
  turnIds: readonly string[]
  waitMs: number
  signal?: AbortSignal
  formatFailure: (result: ChatGptDelegationPollResult) => string
  formatError: (error: unknown) => string
}

/** Poll delegated turns concurrently and project the service result into the shared MCP shape. */
export function pollDelegatedTurns(
  options: PollDelegatedTurnsOptions
): Promise<DelegatedTurnResult[]> {
  return Promise.all(
    options.turnIds.map(async (turnId) => {
      try {
        const result = await options.service.poll(turnId, options.waitMs, options.signal)
        return {
          turn_id: turnId,
          status: result.status,
          activity: result.activity,
          activity_age_ms: result.activityAgeMs,
          response: result.response,
          error: result.status === "failed" ? options.formatFailure(result) : undefined,
        }
      } catch (error) {
        return {
          turn_id: turnId,
          status: "failed" as const,
          error: options.formatError(error),
        }
      }
    })
  )
}
