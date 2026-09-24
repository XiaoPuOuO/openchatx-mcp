/** Stable public tool failure. Internal causes stay out of model-facing responses. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "ToolError"
  }
}

export function toToolError(error: unknown, code = "INTERNAL_ERROR"): ToolError {
  if (error instanceof ToolError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ToolError(code, message, error instanceof Error ? error : undefined)
}
