import {
  type AgentCompletion,
  type AgentGenerateInput,
  type AgentMessage,
  generateAgentTurn,
} from "./agent-provider.js"
import {
  AgentProviderHttpError,
  isContextOverflow,
  isTransientModelError,
  retryDelayMs,
  waitForRetry,
} from "./agent-recovery.js"

export const MAX_MODEL_RETRIES = 4

export interface ModelRetryInfo {
  attempt: number
  reason: string
  nextAt: string
  delayMs: number
}

export interface ModelRequestWithRecovery extends Omit<AgentGenerateInput, "messages"> {
  messages: () => AgentMessage[]
  compact: () => Promise<boolean>
  onRetry: (info: ModelRetryInfo | undefined, outcome?: "completed" | "failed") => void
}

interface RequestState {
  attempts: number
  overflowRecovered: boolean
  streamed: boolean
}

async function recoverFailure(
  error: unknown,
  input: ModelRequestWithRecovery,
  state: RequestState
): Promise<void> {
  if (input.signal?.aborted || state.streamed) throw error
  if (isContextOverflow(error) && !state.overflowRecovered) {
    state.overflowRecovered = true
    if (await input.compact()) return
    throw new Error("Model context overflow: a usable checkpoint could not be created.", {
      cause: error,
    })
  }
  if (!isTransientModelError(error) || state.attempts >= MAX_MODEL_RETRIES) {
    if (state.attempts) input.onRetry(undefined, "failed")
    throw error
  }
  state.attempts += 1
  const delayMs = retryDelayMs(
    state.attempts,
    error instanceof AgentProviderHttpError ? error.retryAfterMs : undefined
  )
  input.onRetry({
    attempt: state.attempts,
    delayMs,
    reason: error instanceof Error ? error.message.slice(0, 240) : "Transport failure",
    nextAt: new Date(Date.now() + delayMs).toISOString(),
  })
  if (!input.signal)
    throw new Error("A cancellable signal is required for model retry.", { cause: error })
  await waitForRetry(delayMs, input.signal)
}

/**
 * Retry only model transports, never completed tool operations. A partial
 * streamed response is not replayed, avoiding duplicate user-visible output.
 */
export async function generateWithRecovery(
  input: ModelRequestWithRecovery
): Promise<AgentCompletion> {
  const state: RequestState = { attempts: 0, overflowRecovered: false, streamed: false }
  const onText = (delta: string) => {
    if (delta) state.streamed = true
    input.onText?.(delta)
  }
  const onReasoningSummary = (delta: string) => {
    if (delta) state.streamed = true
    input.onReasoningSummary?.(delta)
  }
  for (;;) {
    if (input.signal?.aborted) throw input.signal.reason
    try {
      const completed = await generateAgentTurn({
        ...input,
        messages: input.messages(),
        onText,
        onReasoningSummary,
      })
      if (state.attempts) input.onRetry(undefined, "completed")
      return completed
    } catch (error) {
      await recoverFailure(error, input, state)
    }
  }
}
