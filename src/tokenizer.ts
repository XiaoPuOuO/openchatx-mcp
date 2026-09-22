import { get_encoding, type Tiktoken } from "tiktoken"

export const OUTPUT_TOKEN_ENCODING = "o200k_base"

let encoder: Tiktoken | undefined
const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

function getEncoder(): Tiktoken {
  encoder ??= get_encoding(OUTPUT_TOKEN_ENCODING)
  return encoder
}

export function countTokens(value: string): number {
  return getEncoder().encode_ordinary(value).length
}

export function tokenPrefix(
  value: string,
  maxTokens: number
): { value: string; tokenCount: number; truncated: boolean } {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new Error(`Expected a non-negative token limit, received ${maxTokens}.`)
  }

  const tokenizer = getEncoder()
  const tokens = tokenizer.encode_ordinary(value)
  if (tokens.length <= maxTokens) {
    return { value, tokenCount: tokens.length, truncated: false }
  }

  for (let tokenEnd = maxTokens; tokenEnd > 0; tokenEnd -= 1) {
    try {
      const prefix = utf8Decoder.decode(tokenizer.decode(tokens.slice(0, tokenEnd)))
      const tokenCount = tokenizer.encode_ordinary(prefix).length
      if (tokenCount <= maxTokens) {
        return {
          value: prefix,
          tokenCount,
          truncated: prefix.length < value.length,
        }
      }
    } catch {
      // A token boundary can split a multi-byte UTF-8 character. Back up until the prefix is valid text.
    }
  }

  return { value: "", tokenCount: 0, truncated: value.length > 0 }
}

export function tokenChunk(
  value: string,
  start: number,
  maxTokens: number,
  end = value.length
): { value: string; tokenCount: number; nextOffset: number; hasMore: boolean } {
  if (!Number.isSafeInteger(start) || start < 0 || start > value.length) {
    throw new Error(`Expected a valid start offset, received ${start}.`)
  }
  if (!Number.isSafeInteger(end) || end < start) {
    throw new Error(`Expected an end offset at or after start, received ${end}.`)
  }

  const limit = Math.min(end, value.length)
  if (start === limit) {
    return { value: "", tokenCount: 0, nextOffset: start, hasMore: false }
  }

  // maxTokens is a ceiling, not a target. Limiting each encode to a local
  // window avoids repeatedly tokenizing megabytes of retained output.
  const windowEnd = Math.min(limit, start + Math.max(256, maxTokens * 4))
  const bounded = tokenPrefix(value.slice(start, windowEnd), maxTokens)
  const nextOffset = start + bounded.value.length
  return {
    value: bounded.value,
    tokenCount: bounded.tokenCount,
    nextOffset,
    hasMore: nextOffset < limit,
  }
}
