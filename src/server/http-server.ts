import { AsyncLocalStorage } from "node:async_hooks"
import { createServer, type Server as HttpServer } from "node:http"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler } from "@modelcontextprotocol/server"
import type { Request, Response } from "express"

import { ShellbyAuthError, type ShellbyAuthStore } from "../auth/auth.js"
import { MCP_CONFIG, type ToolOutputStructuredMode } from "../config.js"
import { createReviewPromptTracker } from "../tools/review/review-tool.js"
import { createChatGptSubagentService } from "../tools/subagent/chatgpt-subagent.js"
import type { ChatGptSubagentService } from "../tools/subagent/chatgpt-subagent-contracts.js"
import { createMcpServer } from "./mcp-server.js"
import { McpAuditLogger, type McpAuditRequest } from "./audit-log.js"
import { PeekabooClient } from "../tools/computer/peekaboo.js"
import { createShellSessionManager, type ShellSessionManager } from "../tools/shell/session-manager.js"
import { WebPageOpener } from "../tools/web/web-open.js"

interface RequestRuntimeContext {
  auditRequest?: McpAuditRequest
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
  reviewPromptThreshold?: number
  reviewFilePath?: string
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
  const startedSessions = new Set<string>()
  const reviewPromptTracker = createReviewPromptTracker(options.reviewPromptThreshold)
  const requestRuntime = new AsyncLocalStorage<RequestRuntimeContext>()

  const app = createMcpExpressApp({ host, jsonLimit: "1mb" })
  const mcpRoute = /^\/mcp$/

  const mcpHandler = createMcpHandler(
    ({ requestInfo }) => {
      const requestContext = requestRuntime.getStore()
      const sessionId = webRequestSessionId(requestInfo)
      return createMcpServer(shells, {
        chatGptSubagents,
        applyPatchExecutable: options.applyPatchExecutable,
        peekaboo,
        webPageOpener,
        toolOutputStructured: options.toolOutputStructured,
        sessionId,
        startedSessions,
        reviewPromptTracker,
        reviewFilePath: options.reviewFilePath,
        auditRequest: requestContext?.auditRequest,
      })
    },
    {
      legacy: "stateless",
      onerror: reportMcpError,
    }
  )
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: reportMcpError })

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true })
  })

  const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = requestSessionId(req)
    const auditRequest = auditLogger?.startRequest(req.body, { sessionId })
    let auditFinished = false
    const finishAudit = (state: "finished" | "closed") => {
      if (auditFinished) return
      auditFinished = true
      auditRequest?.finishTransport({ httpStatus: res.statusCode, state })
    }
    res.once("finish", () => finishAudit("finished"))
    res.once("close", () => finishAudit("closed"))

    await requestRuntime.run({ auditRequest }, () => nodeMcpHandler(req, res, req.body))
  }

  app.all(mcpRoute, async (req: Request, res: Response) => {
    if (req.method === "POST" && authStore && isTrustedRemoteRequest(req) && containsToolCall(req.body)) {
      try {
        await authStore.authorizeToolCall(req.get("x-openai-subject"))
      } catch (error) {
        remoteAuthError(res, error)
        return
      }
    }
    await handleMcpRequest(req, res)
  })

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
    await Promise.allSettled([mcpHandler.close(), httpClose, shells.close(), peekaboo.close(), chatGptSubagents.dispose()])
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
        await Promise.allSettled([mcpHandler.close(), httpClose])
      } finally {
        await Promise.allSettled([shells.close(), peekaboo.close(), chatGptSubagents.dispose()])
      }
    },
  }
}

function containsToolCall(payload: unknown): boolean {
  const requests = Array.isArray(payload) ? payload : [payload]
  return requests.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const request = value as { method?: unknown; params?: { name?: unknown } }
    return request.method === "tools/call" && typeof request.params?.name === "string" && request.params.name.length > 0
  })
}

function isTrustedRemoteRequest(req: Request): boolean {
  return req.get("x-shellby-remote") === "1"
}

function requestSessionId(req: Request): string | undefined {
  const value = req.get("x-openai-session")?.trim()
  return value || undefined
}

function webRequestSessionId(req: globalThis.Request | undefined): string | undefined {
  const value = req?.headers.get("x-openai-session")?.trim()
  return value || undefined
}

function reportMcpError(error: Error): void {
  console.error("MCP handler error:", error)
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
