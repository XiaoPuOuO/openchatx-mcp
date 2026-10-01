const SENSITIVE_KEY =
  /(?:api[_-]?key|token|secret|password|authorization|cookie|credential|private[_-]?key)/iu
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/giu
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{12,}\b/gu

export function redactSecrets(value: unknown): unknown {
  return redactValue(value)
}

export function redactText(value: string): string {
  return value.replace(BEARER, "Bearer [REDACTED]").replace(OPENAI_KEY, "[REDACTED]")
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]"
  if (typeof value === "string") return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ])
    )
  }
  return value
}
