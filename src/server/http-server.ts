import { createServer, type Server as HttpServer } from "node:http"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node"
import type { Request, Response } from "express"

import { ShellbyAuthError, type ShellbyAuthStore } from "../auth/auth.js"
import { MCP_CONFIG, type ToolOutputStructuredMode } from "../config.js"
import { createChatGptSubagentService } from "../tools/subagent/chatgpt-subagent.js"
import type { ChatGptSubagentService } from "../tools/subagent/chatgpt-subagent-contracts.js"
import { createMcpServer } from "./mcp-server.js"
import { McpAuditLogger } from "./audit-log.js"
import { PeekabooClient } from "../tools/computer/peekaboo.js"
import { createShellSessionManager, type ShellSessionManager } from "../tools/shell/session-manager.js"
import { WebPageOpener } from "../tools/web/web-open.js"

const MAX_AUDIT_RESPONSE_BODY_BYTES = 8 * 1024

interface InFlightMcpRequest {
  server: ReturnType<typeof createMcpServer>
  transport: NodeStreamableHTTPServerTransport
  close: () => Promise<void>
}

export interface RunningMcpServer {
  host: string
  port: number
  url: string
  close: () => Promise<void>
}

export interface StartMcpServerOptions {
  host?: string
  port?: number
  shellManager?: ShellSessionManager
  peekaboo?: PeekabooClient
  chatGptSubagents?: ChatGptSubagentService
  auditLogger?: McpAuditLogger
  authStore?: ShellbyAuthStore
  applyPatchExecutable?: string
  webPageOpener?: WebPageOpener
  toolOutputStructured?: ToolOutputStructuredMode
}

export async function startMcpHttpServer(options: StartMcpServerOptions = {}): Promise<RunningMcpServer> {
  const host = options.host ?? MCP_CONFIG.host
  const port = options.port ?? MCP_CONFIG.port
  const shells = options.shellManager ?? createShellSessionManager()
  const peekaboo = options.peekaboo ?? new PeekabooClient({ localOnly: true })
  const auditLogger = options.auditLogger
  const chatGptSubagents = options.chatGptSubagents ?? createChatGptSubagentService()
  const authStore = options.authStore
  const webPageOpener = options.webPageOpener ?? new WebPageOpener()
  const inFlightRequests = new Set<InFlightMcpRequest>()

  const app = createMcpExpressApp({ host, jsonLimit: "1mb" })
  const mcpRoute = /^\/mcp$/

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true })
  })

  const handleMcpPost = async (req: Request, res: Response): Promise<void> => {
    const sessionId = requestSessionId(req)
    const toolName = firstToolCallName(req.body)
    const parentSessionId = sessionId
      ? toolName
        ? chatGptSubagents.observeSessionToolCall?.(sessionId, toolName)
        : chatGptSubagents.parentSessionForSession?.(sessionId)
      : undefined
    const auditCalls = auditLogger?.startToolCalls(req.body, { sessionId, parentSessionId }) ?? []
    let responseBody = Buffer.alloc(0)
    let responseBytes = 0
    let responseBodyTruncated = false
    if (auditCalls.length > 0) {
      trackResponse(res, (chunk) => {
        responseBytes += chunk.byteLength
        if (responseBodyTruncated) return
        const remaining = MAX_AUDIT_RESPONSE_BODY_BYTES - responseBody.byteLength
        if (chunk.byteLength > remaining) {
          if (remaining > 0) responseBody = Buffer.concat([responseBody, chunk.subarray(0, remaining)])
          responseBodyTruncated = true
          return
        }
        responseBody = Buffer.concat([responseBody, chunk])
      })
    }
    let auditFinished = false
    const finishAudit = (state: "finished" | "closed") => {
      if (auditFinished) return
      auditFinished = true
      for (const auditCall of auditCalls) {
        auditCall.finish({
          httpStatus: res.statusCode,
          state,
          responseBytes,
          responseBodyTruncated,
          ...(responseBody.length > 0 ? { responseBody: responseBody.toString("utf8") } : {}),
        })
      }
    }
    res.once("finish", () => finishAudit("finished"))
    res.once("close", () => finishAudit("closed"))

    const mcpServer = createMcpServer(shells, {
      chatGptSubagents,
      applyPatchExecutable: options.applyPatchExecutable,
      peekaboo,
      webPageOpener,
      toolOutputStructured: options.toolOutputStructured,
      sessionId,
    })
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    let connected = false
    let closePromise: Promise<void> | undefined
    const request: InFlightMcpRequest = {
      server: mcpServer,
      transport,
      close: () => {
        closePromise ??= (async () => {
          try {
            if (connected) await mcpServer.close()
            else await transport.close()
          } finally {
            inFlightRequests.delete(request)
          }
        })()
        return closePromise
      },
    }
    inFlightRequests.add(request)

    const closeRequest = () => {
      void request.close().catch((error: unknown) => {
        console.error("Could not close MCP request:", error)
      })
    }
    res.once("finish", closeRequest)
    res.once("close", closeRequest)

    try {
      await mcpServer.connect(transport)
      connected = true
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error("MCP request failed:", error)
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal MCP server error.")
      } else if (!res.writableEnded) {
        res.end()
      }
    } finally {
      if (res.writableEnded || res.destroyed) {
        await request.close().catch((error: unknown) => {
          console.error("Could not close MCP request:", error)
        })
      }
    }
  }

  app.post(mcpRoute, async (req: Request, res: Response) => {
    if (authStore && isTrustedRemoteRequest(req) && containsToolCall(req.body)) {
      try {
        await authStore.authorizeToolCall(req.get("x-openai-subject"))
      } catch (error) {
        remoteAuthError(res, error)
        return
      }
    }
    await handleMcpPost(req, res)
  })

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST")
    jsonRpcError(res, 405, -32000, "Method not allowed.")
  }
  app.get(mcpRoute, methodNotAllowed)
  app.delete(mcpRoute, methodNotAllowed)

  const httpServer = createServer(app)
  let boundPort: number
  try {
    await shells.startDefault()
    await listen(httpServer, port, host)

    const address = httpServer.address()
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP address.")
    }
    boundPort = address.port
  } catch (error) {
    const httpClose = closeHttpServerIfListening(httpServer)
    await Promise.allSettled([...inFlightRequests].map((request) => request.close()))
    await Promise.allSettled([httpClose, shells.close(), peekaboo.close(), chatGptSubagents.dispose()])
    throw error
  }

  let closed = false
  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}/mcp`,
    close: async () => {
      if (closed) return
      closed = true

      const httpClose = closeHttpServerIfListening(httpServer)
      try {
        await Promise.allSettled([...inFlightRequests].map((request) => request.close()))
        await httpClose
      } finally {
        await Promise.allSettled([shells.close(), peekaboo.close(), chatGptSubagents.dispose()])
      }
    },
  }
}

function trackResponse(res: Response, addChunk: (chunk: Buffer) => void): void {
  const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response

  res.write = ((...args: unknown[]) => {
    const chunk = responseChunk(args[0], args[1])
    if (chunk) addChunk(chunk)
    return originalWrite(...args)
  }) as typeof res.write

  res.end = ((...args: unknown[]) => {
    const chunk = responseChunk(args[0], args[1])
    if (chunk) addChunk(chunk)
    return originalEnd(...args)
  }) as typeof res.end
}

function responseChunk(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (typeof chunk === "string") {
    const normalizedEncoding = typeof encoding === "string" && Buffer.isEncoding(encoding) ? (encoding as BufferEncoding) : "utf8"
    return Buffer.from(chunk, normalizedEncoding)
  }
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return undefined
}

function containsToolCall(payload: unknown): boolean {
  const requests = Array.isArray(payload) ? payload : [payload]
  return requests.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const request = value as { method?: unknown; params?: { name?: unknown } }
    return request.method === "tools/call" && typeof request.params?.name === "string" && request.params.name.length > 0
  })
}

function firstToolCallName(payload: unknown): string | undefined {
  const requests = Array.isArray(payload) ? payload : [payload]
  for (const value of requests) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const request = value as { method?: unknown; params?: { name?: unknown } }
    if (request.method === "tools/call" && typeof request.params?.name === "string" && request.params.name.length > 0) return request.params.name
  }
  return undefined
}

function isTrustedRemoteRequest(req: Request): boolean {
  return req.get("x-shellby-remote") === "1"
}

function requestSessionId(req: Request): string | undefined {
  const value = req.get("x-openai-session")?.trim()
  return value || undefined
}

function remoteAuthError(res: Response, error: unknown): void {
  if (error instanceof ShellbyAuthError) {
    if (error.code === "subject_missing" || error.code === "subject_mismatch") {
      jsonRpcError(res, 403, -32002, "Remote MCP access denied.")
      return
    }
    jsonRpcError(res, 503, -32003, "Remote MCP authentication is unavailable.")
    return
  }

  console.error("Remote MCP authentication failed:", error)
  jsonRpcError(res, 503, -32003, "Remote MCP authentication is unavailable.")
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  })
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

function closeHttpServerIfListening(server: HttpServer): Promise<void> {
  return server.listening ? closeHttpServer(server) : Promise.resolve()
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
