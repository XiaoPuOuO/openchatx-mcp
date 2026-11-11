import { AsyncLocalStorage } from "node:async_hooks"
import { createHmac, randomBytes } from "node:crypto"
import { createServer, type Server as HttpServer } from "node:http"
import process from "node:process"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler } from "@modelcontextprotocol/server"
import type { Request, Response } from "express"
import { runWithAgent } from "../agent/context.js"
import { createDashboardRouter } from "../agent/dashboard-routes.js"
import type { AgentObserver } from "../agent/observer.js"
import { OpenChatXAuthError, type OpenChatXAuthStore } from "../auth/store.js"
import type { CapabilityRegistry } from "../capabilities/catalog.js"
import type { CapabilityHealthService } from "../capabilities/health.js"
import { MCP_CONFIG } from "../config.js"
import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import type { JobManager } from "../jobs/job-manager.js"
import type { ContextBudgetGuard } from "../mcp/context-budget.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import type { PlatformOverviewService } from "../platform/overview.js"
import type { ProjectRegistry } from "../projects/project-registry.js"
import type { ProjectWorkspaceService } from "../projects/workspace-snapshot.js"
import { loadPublicConfig } from "../public-config.cjs"
import type { SystemRecoveryService } from "../recovery/system-recovery.js"
import type { RuntimeProcessService } from "../runtime/process-service.js"
import type { RuntimeControlService } from "../runtime/runtime-control.js"
import type { RecentWorkService } from "../sessions/recent-work.js"
import type { CapabilityStoreService } from "../store/store-service.js"
import type { ChatGPTAuth } from "../subagents/chatgpt-auth.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { SummaryRegistry } from "../summaries/summary-registry.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"
import { asRecord } from "../utils.js"
import type { McpAuditLogger, McpAuditRequest } from "./audit/audit-log.js"
import { TailnetUiManager } from "./tailnet-ui.js"

const MCP_ROUTE = /^\/mcp$/u
const SESSION_DIAGNOSTICS_ENABLED = process.env.OPENCHATX_SESSION_DIAGNOSTICS === "1"
const SESSION_DIAGNOSTIC_SALT = randomBytes(32)
const SESSION_DIAGNOSTIC_LIMIT = 1_000
const sessionDiagnosticEntries = new Set<string>()
const JSON_RPC_ID_PATH_PATTERN = /^body(?:\[\d+\])?\.id$/u
const SESSION_IDENTITY_HEADER_PATTERN =
  /session|conversation|subagent|agent|turn|thread|task|client|request|command|workflow|actor|run|worker|job|invocation|parent|caller|context/iu
const SESSION_IDENTITY_FIELD_NAMES = new Set([
  "id",
  "session_id",
  "conversation_id",
  "agent_id",
  "subagent_id",
  "agent_run_id",
  "subagent_run_id",
  "turn_id",
  "thread_id",
  "task_id",
  "client_id",
  "request_id",
  "command_id",
  "cmd_request_id",
  "workflow_id",
  "run_id",
  "job_id",
  "worker_id",
  "parent_id",
  "parent_agent_id",
  "owner_agent_id",
  "root_owner_id",
  "actor_id",
  "caller_id",
  "invocation_id",
  "execution_id",
  "tool_call_id",
  "context_id",
])
const REQUEST_DIAGNOSTIC_MAX_FIELDS = 256
const REQUEST_DIAGNOSTIC_MAX_DEPTH = 8
const SENSITIVE_HEADER_PATTERN =
  /authorization|cookie|token|secret|api[-_]?key|password|credential|signature/iu
const SAFE_HEADER_VALUE_PATTERN =
  /^(accept|accept-encoding|content-length|content-type|host|origin|referer|user-agent|mcp-method|mcp-name|mcp-protocol-version|x-origin-ingress-name|x-request-id|traceparent|x-datadog-trace-id)$/iu

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
  authStore?: OpenChatXAuthStore
  agentObserver?: AgentObserver
  toolboxRegistry?: ToolboxRegistry
  subagentRuntime?: SubagentRuntime
  chatgptAuth?: ChatGPTAuth
  externalMcp?: ExternalMcpRegistry
  capabilityHealth?: CapabilityHealthService
  capabilityRegistry?: CapabilityRegistry
  capabilityStore?: CapabilityStoreService
  platformOverview?: PlatformOverviewService
  projectRegistry?: ProjectRegistry
  summaryRegistry?: SummaryRegistry
  contextBudget?: ContextBudgetGuard
  systemRecovery?: SystemRecoveryService
  runtimeControl?: RuntimeControlService
  runtimeProcesses?: RuntimeProcessService
  projectWorkspaces?: ProjectWorkspaceService
  recentWork?: RecentWorkService
  jobManager?: JobManager
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
  const {
    createMcpServer,
    auditLogger,
    authStore,
    agentObserver,
    toolboxRegistry,
    subagentRuntime,
    chatgptAuth,
    externalMcp,
    capabilityHealth,
    capabilityRegistry,
    capabilityStore,
    platformOverview,
    projectRegistry,
    summaryRegistry,
    contextBudget,
    systemRecovery,
    runtimeControl,
    runtimeProcesses,
    projectWorkspaces,
    recentWork,
    jobManager,
  } = services
  const requestRuntime = new AsyncLocalStorage<RequestRuntimeContext>()
  const tailnetUi = new TailnetUiManager(port, MCP_CONFIG.stateDir)

  const app = createMcpExpressApp({ host, jsonLimit: "10mb" })
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
    res.setHeader("x-openchatx-instance", instanceId)
    res.json({ ok: true })
  })

  if (agentObserver)
    app.use(
      "/ui",
      createDashboardRouter(agentObserver, {
        toolboxRegistry,
        subagentRuntime,
        chatgptAuth,
        externalMcp,
        capabilityHealth,
        capabilityRegistry,
        capabilityStore,
        platformOverview,
        projectRegistry,
        summaryRegistry,
        contextBudget,
        systemRecovery,
        runtimeControl,
        runtimeProcesses,
        projectWorkspaces,
        recentWork,
        jobManager,
        tailnetUi,
      })
    )

  const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = requestSessionId(req)
    if (SESSION_DIAGNOSTICS_ENABLED) logSessionRoutingDiagnostics(req, sessionId)
    await runWithAgent(
      sessionId,
      async () => {
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
      },
      requestHasDotWindow(req.body)
    )
  }

  app.all(MCP_ROUTE, async (req: Request, res: Response) => {
    await normalizeMcpPostHeaders(req)
    if (
      req.method === "POST" &&
      authStore &&
      (req.get("x-openai-subject") || req.get("x-openchatx-remote") === "1") &&
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
  let tailnetReconcileTimer: ReturnType<typeof setInterval> | undefined
  try {
    await listen(httpServer, port, host)

    const address = httpServer.address()
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP address.")
    }
    boundPort = address.port
    try {
      await tailnetUi.apply(loadPublicConfig(MCP_CONFIG.publicConfigFile).tailnet_ui)
    } catch (error) {
      // An optional Tailnet UI must not prevent the local MCP runtime from starting.
      console.error("Optional Tailnet UI is unavailable:", error)
    }
    // Tailscale may start after OpenChatX or lose its Serve state on reconnect.
    // Reconcile the configured, app-owned forward without exposing /mcp.
    tailnetReconcileTimer = setInterval(() => {
      try {
        const settings = loadPublicConfig(MCP_CONFIG.publicConfigFile).tailnet_ui
        void tailnetUi.apply(settings).catch((error: unknown) => {
          console.error("Could not reconcile Tailnet UI:", error)
        })
      } catch (error) {
        console.error("Could not read Tailnet UI settings:", error)
      }
    }, 30_000)
    tailnetReconcileTimer.unref()
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
      if (tailnetReconcileTimer) clearInterval(tailnetReconcileTimer)
      await Promise.allSettled([
        tailnetUi.close(),
        mcpHandler.close(),
        closeHttpServerIfListening(httpServer),
      ])
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

export function requestSessionId(req: Request): string | undefined {
  const value =
    req.get("x-openai-session")?.trim() ||
    req.get("mcp-session-id")?.trim() ||
    req.get("x-openai-conversation-id")?.trim() ||
    req.get("x-openai-session-id")?.trim()
  return value || undefined
}

export function requestHasDotWindow(payload: unknown): boolean {
  const requests = Array.isArray(payload) ? payload : [payload]
  return requests.some((request) => {
    const params = asRecord(asRecord(request)?.params)
    const metadata = asRecord(params?._meta)
    return typeof metadata?.windowId === "string" && metadata.windowId.trim().length > 0
  })
}

function logSessionRoutingDiagnostics(req: Request, sessionId: string | undefined): void {
  const selectedHeader = [
    "x-openai-session",
    "mcp-session-id",
    "x-openai-conversation-id",
    "x-openai-session-id",
  ].find((name) => req.get(name)?.trim())
  const identityHeaders = Object.entries(req.headers)
    .filter(
      (entry): entry is [string, string] =>
        SESSION_IDENTITY_HEADER_PATTERN.test(entry[0]) && typeof entry[1] === "string"
    )
    .map(([name, value]) => ({ name, fingerprint: sessionDiagnosticFingerprint(value) }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const identityBodyFields: Array<{ field: string; fingerprint: string }> = []
  collectSessionIdentityFields(req.body, "body", identityBodyFields)
  const bodyShape: RequestBodyField[] = []
  collectRequestBodyShape(req.body, "body", bodyShape)
  const requests = Array.isArray(req.body) ? req.body : [req.body]
  const rpcMethods = [
    ...new Set(
      requests.flatMap((item) => {
        const record = asRecord(item)
        return typeof record?.method === "string" ? [record.method] : []
      })
    ),
  ].sort()
  const toolNames = [
    ...new Set(
      requests.flatMap((item) => {
        const record = asRecord(item)
        const params = asRecord(record?.params)
        return record?.method === "tools/call" && typeof params?.name === "string"
          ? [params.name]
          : []
      })
    ),
  ].sort()
  const referer = req.get("referer")
  let refererOrigin: string | null = null
  if (referer) {
    try {
      refererOrigin = new URL(referer).origin
    } catch {
      // Ignore malformed Referer values; never persist their arbitrary path/query.
    }
  }
  const diagnostic = {
    request: {
      method: req.method,
      path: req.path,
      contentLength: req.get("content-length") ?? null,
      bodyType: describeValueType(req.body),
    },
    headers: describeRequestHeaders(req),
    headerNames: Object.keys(req.headers).sort(),
    source: {
      origin: req.get("origin") ?? null,
      refererOrigin,
      originIngressName: req.get("x-origin-ingress-name") ?? null,
      openaiPodUid: fingerprintRequestHeader(req, "x-openai-pod-uid"),
      openaiSubject: fingerprintRequestHeader(req, "x-openai-subject"),
      requestId: req.get("x-request-id") ?? null,
      traceparent: req.get("traceparent") ?? null,
      datadogTraceId: fingerprintRequestHeader(req, "x-datadog-trace-id"),
    },
    selectedHeader: selectedHeader ?? null,
    selectedSession: sessionId ? sessionDiagnosticFingerprint(sessionId) : null,
    identityHeaders,
    identityBodyFields,
    bodyShape,
    bodyShapeTruncated: bodyShape.length >= REQUEST_DIAGNOSTIC_MAX_FIELDS,
    rpcMethods,
    toolNames,
  }
  const key = JSON.stringify(diagnostic)
  if (
    sessionDiagnosticEntries.has(key) ||
    sessionDiagnosticEntries.size >= SESSION_DIAGNOSTIC_LIMIT
  )
    return
  sessionDiagnosticEntries.add(key)
  console.info("MCP session routing diagnostic:", key)
}

interface RequestBodyField {
  field: string
  type: string
  value?: string | number | boolean | null
  fingerprint?: string
  length?: number
  itemCount?: number
  keys?: string[]
}

function describeRequestHeaders(req: Request): Array<{
  name: string
  value?: string | string[]
  fingerprint?: string | string[]
  redacted?: boolean
}> {
  return Object.entries(req.headers)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, rawValue]) => {
      if (SENSITIVE_HEADER_PATTERN.test(name)) return { name, redacted: true }
      const values = Array.isArray(rawValue) ? rawValue : [rawValue]
      if (SAFE_HEADER_VALUE_PATTERN.test(name)) {
        const safeValues = values.map((value) =>
          name === "referer" ? safeRefererOrigin(value) : value
        )
        return {
          name,
          value: Array.isArray(rawValue) ? safeValues : safeValues[0],
        }
      }
      const fingerprints = values.map((value) => sessionDiagnosticFingerprint(value))
      return {
        name,
        fingerprint: Array.isArray(rawValue) ? fingerprints : fingerprints[0],
      }
    })
}

function safeRefererOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return "[INVALID_REFERER]"
  }
}

function describeValueType(
  value: unknown
):
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean"
  | "undefined"
  | "function"
  | "symbol"
  | "bigint" {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function collectRequestBodyShape(
  value: unknown,
  path: string,
  fields: RequestBodyField[],
  depth = 0
): void {
  if (fields.length >= REQUEST_DIAGNOSTIC_MAX_FIELDS) return
  if (depth > REQUEST_DIAGNOSTIC_MAX_DEPTH) {
    fields.push({ field: path, type: "max-depth" })
    return
  }
  if (Array.isArray(value)) {
    fields.push({ field: path, type: "array", itemCount: value.length })
    value.forEach((item, index) => {
      collectRequestBodyShape(item, `${path}[${index}]`, fields, depth + 1)
    })
    return
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
    fields.push({
      field: path,
      type: "object",
      keys: entries.map(([name]) => name).sort(),
    })
    for (const [name, nested] of entries) {
      if (fields.length >= REQUEST_DIAGNOSTIC_MAX_FIELDS) break
      collectRequestBodyShape(nested, `${path}.${name}`, fields, depth + 1)
    }
    return
  }
  if (typeof value === "string") {
    const normalizedName = path.split(".").at(-1)?.toLowerCase() ?? ""
    const isProtocolValue =
      normalizedName === "jsonrpc" ||
      normalizedName === "method" ||
      (normalizedName === "name" && path.endsWith(".params.name")) ||
      JSON_RPC_ID_PATH_PATTERN.test(path)
    fields.push(
      isProtocolValue
        ? { field: path, type: "string", value, length: value.length }
        : {
            field: path,
            type: "string",
            fingerprint: sessionDiagnosticFingerprint(value),
            length: value.length,
          }
    )
    return
  }
  fields.push({
    field: path,
    type: describeValueType(value),
    ...(typeof value === "number" || typeof value === "boolean" || value === null ? { value } : {}),
  })
}

function fingerprintRequestHeader(req: Request, name: string): string | null {
  const value = req.get(name)
  return value ? sessionDiagnosticFingerprint(value) : null
}

function collectSessionIdentityFields(
  value: unknown,
  path: string,
  fields: Array<{ field: string; fingerprint: string }>,
  depth = 0
): void {
  if (depth > 4 || typeof value !== "object" || value === null) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectSessionIdentityFields(item, `${path}[${index}]`, fields, depth + 1)
    })
    return
  }
  for (const [name, nested] of Object.entries(value)) {
    const normalized = name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase()
    const field = `${path}.${name}`
    if (
      SESSION_IDENTITY_FIELD_NAMES.has(normalized) &&
      (typeof nested === "string" || typeof nested === "number")
    ) {
      fields.push({ field, fingerprint: sessionDiagnosticFingerprint(String(nested)) })
    } else if (typeof nested === "object" && nested !== null) {
      collectSessionIdentityFields(nested, field, fields, depth + 1)
    }
  }
}

function sessionDiagnosticFingerprint(value: string): string {
  return createHmac("sha256", SESSION_DIAGNOSTIC_SALT).update(value).digest("hex").slice(0, 12)
}

const MCP_BODY_LIMIT_BYTES = 10 * 1024 * 1024

async function normalizeMcpPostHeaders(req: Request): Promise<void> {
  if (req.method !== "POST") return

  const contentType = req.headers["content-type"] ?? ""
  if (!contentType.toLowerCase().includes("application/json")) {
    req.headers["content-type"] = "application/json"
    if (!isParsedJsonBody(req.body)) req.body = await readJsonBody(req)
  }

  const accept = (req.headers.accept ?? "").toLowerCase()
  if (!accept.includes("application/json") && !accept.includes("text/event-stream"))
    req.headers.accept = "application/json, text/event-stream"
}

function isParsedJsonBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && Object.keys(body).length > 0
}

async function readJsonBody(req: Request): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += piece.length
    if (size > MCP_BODY_LIMIT_BYTES) break
    chunks.push(piece)
  }
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function reportMcpError(error: Error): void {
  console.error("MCP handler error:", error)
}

function remoteAuthError(res: Response, error: unknown): void {
  if (error instanceof OpenChatXAuthError) {
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
