import type { RequestId } from "@modelcontextprotocol/server"
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
  claimTool(requestId: RequestId, toolName: string): McpAuditCall | undefined
  startNestedTool(toolName: string, argumentsValue: unknown): McpAuditCall
  finishTransport(input: { httpStatus: number; state: "finished" | "closed" }): void
}

interface PendingAuditCall {
  requestId?: RequestId
  name: string
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
      requestId: parsed.requestId,
      name: parsed.name,
      call: startToolCall(parsed.name, parsed.arguments),
      claimed: false,
    })
  }

  return {
    claimTool(requestId, toolName) {
      const match = pending.find(
        (item) => !item.claimed && item.requestId === requestId && item.name === toolName
      )
      if (!match) return
      match.claimed = true
      return match.call
    },
    startNestedTool(toolName, argumentsValue) {
      return startToolCall(toolName, argumentsValue, "then_run")
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

function parseToolCall(
  value: unknown
): { requestId?: RequestId; name: string; arguments?: unknown } | undefined {
  const request = asRecord(value)
  if (!request) return undefined
  if (request.method !== "tools/call") return undefined
  const params = asRecord(request.params)
  const name = params?.name
  if (typeof name !== "string" || !name) return undefined
  const id = request.id
  return {
    ...(typeof id === "string" || typeof id === "number" ? { requestId: id } : {}),
    name,
    arguments: params.arguments,
  }
}

function isToolListRequest(value: unknown): boolean {
  return asRecord(value)?.method === "tools/list"
}
