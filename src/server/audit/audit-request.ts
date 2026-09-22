import { asRecord } from "../../utils.js"

export interface McpAuditCall {
  finish(input?: {
    toolResult?: unknown
    modelResult?: unknown
    error?: unknown
    httpStatus?: number
    state?: "finished" | "closed"
  }): void
}

export interface McpAuditRequest {
  claimTool(toolName: string, argumentsValue: unknown): McpAuditCall | undefined
  finishTransport(input: { httpStatus: number; state: "finished" | "closed" }): void
}

interface PendingAuditCall {
  name: string
  argumentsValue: unknown
  call: McpAuditCall
  claimed: boolean
}

export function createAuditRequest(
  payload: unknown,
  startToolCall: (toolName: string, argumentsValue: unknown, via?: "then_run") => McpAuditCall,
  onToolList: () => void
): McpAuditRequest {
  const pending: PendingAuditCall[] = []
  for (const request of requestsFromPayload(payload)) {
    if (isToolListRequest(request)) {
      onToolList()
      continue
    }
    const parsed = parseToolCall(request)
    if (!parsed) continue
    pending.push({
      name: parsed.name,
      argumentsValue: parsed.arguments,
      call: startToolCall(parsed.name, parsed.arguments),
      claimed: false,
    })
  }

  return {
    claimTool(toolName, argumentsValue) {
      const match =
        pending.find(
          (item) =>
            !item.claimed &&
            item.name === toolName &&
            inputMatches(item.argumentsValue, argumentsValue)
        ) ?? pending.find((item) => !item.claimed && item.name === toolName)
      // Top-level MCP calls are preloaded into pending. An unmatched execution is created internally by then_run.
      if (!match) return startToolCall(toolName, argumentsValue, "then_run")
      match.claimed = true
      return match.call
    },
    finishTransport({ httpStatus, state }) {
      for (const item of pending) {
        if (item.claimed) continue
        item.claimed = true
        // SDK rejections can bypass the handler. Record transport metadata without inventing a generic error notice.
        item.call.finish({ httpStatus, state })
      }
    },
  }
}

function requestsFromPayload(payload: unknown): unknown[] {
  return Array.isArray(payload) ? payload : [payload]
}

function parseToolCall(value: unknown): { name: string; arguments?: unknown } | undefined {
  const request = asRecord(value)
  if (!request) return undefined
  if (request.method !== "tools/call") return undefined
  const params = asRecord(request.params)
  const name = params?.name
  if (typeof name !== "string" || !name) return undefined
  return { name, arguments: params.arguments }
}

function inputMatches(expected: unknown, actual: unknown): boolean {
  if (Object.is(expected, actual)) return true
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => inputMatches(item, actual[index]))
    )
  }
  const expectedRecord = asRecord(expected)
  const actualRecord = asRecord(actual)
  if (expectedRecord && actualRecord) {
    return Object.entries(expectedRecord).every(
      ([key, value]) => Object.hasOwn(actualRecord, key) && inputMatches(value, actualRecord[key])
    )
  }
  return false
}

function isToolListRequest(value: unknown): boolean {
  return asRecord(value)?.method === "tools/list"
}
