import { tokenChunk } from "../../tokenizer.js"

const COMPACT_THRESHOLD = 64 * 1024

export interface TranscriptBuffer {
  readonly start: number
  readonly end: number
  append(chunk: string): void
  read(
    cursor: number,
    maxTokens: number,
    upperBound?: number
  ): {
    output: string
    tokenCount: number
    nextCursor: number
    hasMore: boolean
    cursorExpired: boolean
  }
}

export function createTranscriptBuffer(maxLength: number): TranscriptBuffer {
  let value = ""
  let baseOffset = 0
  let retainedStart = 0
  const compactThreshold = Math.min(maxLength, COMPACT_THRESHOLD)

  function append(chunk: string): void {
    if (chunk.length === 0) return

    value += chunk
    const overflow = value.length - retainedStart - maxLength
    if (overflow > 0) {
      let nextStart = retainedStart + overflow
      if (
        nextStart < value.length &&
        isHighSurrogate(value.charCodeAt(nextStart - 1)) &&
        isLowSurrogate(value.charCodeAt(nextStart))
      ) {
        nextStart += 1
      }
      retainedStart = nextStart
    }

    if (retainedStart >= compactThreshold) {
      value = value.slice(retainedStart)
      baseOffset += retainedStart
      retainedStart = 0
    }
  }

  function read(cursor: number, maxTokens: number, upperBound?: number) {
    const end = baseOffset + value.length
    const start = baseOffset + retainedStart
    const availableEnd = Math.min(upperBound ?? end, end)
    const cursorExpired = cursor < start

    if (availableEnd <= start) {
      return {
        output: "",
        tokenCount: 0,
        nextCursor: availableEnd,
        hasMore: false,
        cursorExpired,
      }
    }

    const effectiveCursor = Math.min(Math.max(cursor, start), availableEnd)
    const localStart = effectiveCursor - baseOffset
    const localEnd = availableEnd - baseOffset
    const bounded = tokenChunk(value, localStart, maxTokens, localEnd)

    return {
      output: bounded.value,
      tokenCount: bounded.tokenCount,
      nextCursor: baseOffset + bounded.nextOffset,
      hasMore: bounded.hasMore,
      cursorExpired,
    }
  }

  return {
    get start() {
      return baseOffset + retainedStart
    },
    get end() {
      return baseOffset + value.length
    },
    append,
    read,
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}
