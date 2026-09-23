import { AsyncLocalStorage } from "node:async_hooks"
import { createServer, type Server as HttpServer } from "node:http"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler } from "@modelcontextprotocol/server"
import type { Request, Response } from "express"
import { runWithAgent } from "../agent/context.js"
import { createDashboardRouter } from "../agent/dashboard-routes.js"
import type { AgentObserver } from "../agent/observer.js"
import { ShellbyAuthError, type ShellbyAuthStore } from "../auth/store.js"
import { MCP_CONFIG } from "../config.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import { asRecord } from "../utils.js"
import type { McpAuditLogger, McpAuditRequest } from "./audit/audit-log.js"

const MCP_ROUTE = /^\/mcp$/u

interface RequestRuntimeContext {
  auditRequest?: McpAuditRequest
}

export interface RunningMcpServer {
  host: string
  port: number
  url: string
  close: () => Promise<void>
}

export interface McpHttpServices {
  createMcpServer: McpServerFactory
  auditLogger?: McpAuditLogger
  authStore?: ShellbyAuthStore
  agentObserver?: AgentObserver
}

export interface McpHttpProfileOverrides {
  host?: string
  port?: number
  instanceId?: string
}

export async function startMcpHttpServer(
  services: McpHttpServices,
  profileOverrides: McpHttpProfileOverrides = {}
): Promise<RunningMcpServer> {
  const host = profileOverrides.host ?? MCP_CONFIG.host
  const port = profileOverrides.port ?? MCP_CONFIG.port
  const instanceId = profileOverrides.instanceId ?? MCP_CONFIG.instanceId
  const { createMcpServer, auditLogger, authStore, agentObserver } = services
  const requestRuntime = new AsyncLocalStorage<RequestRuntimeContext>()

  const app = createMcpExpressApp({ host, jsonLimit: "1mb" })
  const mcpHandler = createMcpHandler(
    () => {
      const requestContext = requestRuntime.getStore()
      return createMcpServer({
        auditRequest: requestContext?.auditRequest,
        agentObserver,
      })
    },
    {
      legacy: "stateless",
      onerror: reportMcpError,
    }
  )
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: reportMcpError })

  app.get("/healthz", (_req, res) => {
    res.setHeader("x-shellby-instance", instanceId)
    res.json({ ok: true })
  })

  if (agentObserver) app.use("/ui", createDashboardRouter(agentObserver))

  const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = requestSessionId(req)
    await runWithAgent(sessionId, async () => {
      const auditRequest = auditLogger?.startRequest(req.body)
      let auditFinished = false
      const finishAudit = (state: "finished" | "closed") => {
        if (auditFinished) return
        auditFinished = true
        auditRequest?.finishTransport({ httpStatus: res.statusCode, state })
      }
      res.once("finish", () => finishAudit("finished"))
      res.once("close", () => finishAudit("closed"))

      await requestRuntime.run({ auditRequest }, () => nodeMcpHandler(req, res, req.body))
    })
  }

  app.all(MCP_ROUTE, async (req: Request, res: Response) => {
    if (
      req.method === "POST" &&
      authStore &&
      isTrustedRemoteRequest(req) &&
      containsToolCall(req.body)
    ) {
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
    await listen(httpServer, port, host)

    const address = httpServer.address()
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP address.")
    }
    boundPort = address.port
  } catch (error) {
    const httpClose = closeHttpServerIfListening(httpServer)
    await Promise.allSettled([mcpHandler.close(), httpClose])
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
      await Promise.allSettled([mcpHandler.close(), closeHttpServerIfListening(httpServer)])
    },
  }
}

function containsToolCall(payload: unknown): boolean {
  const requests = Array.isArray(payload) ? payload : [payload]
  return requests.some((value) => {
    const request = asRecord(value)
    if (request?.method !== "tools/call") return false
    const params = asRecord(request.params)
    return typeof params?.name === "string" && params.name.length > 0
  })
}

function isTrustedRemoteRequest(req: Request): boolean {
  return req.get("x-shellby-remote") === "1"
}

function requestSessionId(req: Request): string | undefined {
  const value = req.get("x-openai-session")?.trim()
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
