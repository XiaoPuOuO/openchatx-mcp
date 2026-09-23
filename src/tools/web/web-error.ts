export class WebOpenError extends Error {
  constructor(
    readonly code:
      | "invalid_url"
      | "invalid_cursor"
      | "cursor_expired"
      | "connection_refused"
      | "open_failed"
      | "resource_too_large"
      | "unsupported_content_type",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "WebOpenError"
  }
}
