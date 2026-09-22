export function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received ${value}.`)
  }
  return value
}

export function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected a non-negative integer, received ${value}.`)
  }
  return value
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

export function utf8Chunk(
  value: string,
  start: number,
  maxBytes: number,
  end = value.length
): { value: string; nextOffset: number } {
  let offset = start
  let bytes = 0
  const limit = Math.min(end, value.length)

  while (offset < limit) {
    const codePoint = value.codePointAt(offset)
    if (codePoint === undefined) break
    const codeUnits = codePoint > 0xffff ? 2 : 1
    if (offset + codeUnits > limit) break
    const characterBytes =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes + characterBytes > maxBytes) break
    bytes += characterBytes
    offset += codeUnits
  }

  return {
    value: value.slice(start, offset),
    nextOffset: offset,
  }
}

export function utf8Prefix(
  value: string,
  maxBytes: number
): { value: string; omittedBytes: number } {
  const chunk = utf8Chunk(value, 0, maxBytes)
  const boundedValue =
    chunk.nextOffset < value.length ? Buffer.from(chunk.value).toString() : chunk.value
  return {
    value: boundedValue,
    omittedBytes: Buffer.byteLength(value.slice(chunk.nextOffset), "utf8"),
  }
}
