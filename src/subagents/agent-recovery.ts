/** Provider failures are classified at the model-request boundary, never around tool execution. */
export class AgentProviderHttpError extends Error {
  constructor(
    readonly status: number,
    details: string,
    readonly retryAfterMs?: number
  ) {
    super(`Provider request failed (HTTP ${status}): ${details}`)
    this.name = "AgentProviderHttpError"
  }
}

const OVERFLOW =
  /context[_ -]?length[_ -]?exceeded|maximum context length|context window|context overflow|exceed_context_size|prompt (?:is )?too long|tokens in request more than max|input tokens exceed|too many input tokens/iu
const TRANSPORT =
  /fetch failed|socket hang up|connection reset|network (?:error|connection)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT/iu

export function isContextOverflow(error: unknown): boolean {
  return (
    (error instanceof AgentProviderHttpError && error.status === 413) ||
    (error instanceof Error && OVERFLOW.test(error.message))
  )
}

export function isTransientModelError(error: unknown): boolean {
  if (isContextOverflow(error)) return false
  if (error instanceof AgentProviderHttpError)
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      (error.status >= 500 && error.status < 600)
    )
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  return TRANSPORT.test(
    [error.message, error.cause instanceof Error ? error.cause.message : ""].join(" ")
  )
}

export function parseRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, Math.min(60_000, date - Date.now())) : undefined
}

export function retryDelayMs(attempt: number, retryAfter?: number): number {
  const backoff = Math.min(10_000, 700 * 2 ** Math.max(0, attempt - 1))
  const jitter = 0.8 + Math.random() * 0.4
  return Math.max(Math.round(backoff * jitter), retryAfter ?? 0)
}

export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    }
    const abort = () => {
      finish()
      reject(signal.reason ?? new Error("Model request cancelled."))
    }
    const timer = setTimeout(() => {
      finish()
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}
