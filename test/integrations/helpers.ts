import assert from "node:assert/strict"
import { request as httpRequest } from "node:http"

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { AgentObserver } from "../../src/agent/observer.js"
import type { OpenChatXAuthStore } from "../../src/auth/store.js"
import {
  createMcpServerFactory,
  type McpCapabilityServices,
  type McpRuntimeProfileOverrides,
} from "../../src/mcp/server-factory.js"
import type { McpAuditLogger } from "../../src/server/audit/audit-log.js"
import {
  type McpHttpProfileOverrides,
  startMcpHttpServer as startMcpHttpServerRaw,
} from "../../src/server/http-server.js"
import { createShellSessionManager } from "../../src/tools/shell/session-manager.js"
import { WebPageOpener } from "../../src/tools/web/web-open.js"

type TestMcpServerOptions = Partial<McpCapabilityServices> & {
  port?: number
  http?: McpHttpProfileOverrides
  profile?: McpRuntimeProfileOverrides
  auditLogger?: McpAuditLogger
  authStore?: OpenChatXAuthStore
  agentObserver?: AgentObserver
}

const TEST_TOOLS = {
  shell: true,
  applyPatch: true,
  fileRead: true,
  fileWrite: true,
  web: true,
  skills: true,
  image: true,
} satisfies McpRuntimeProfileOverrides["tools"]

export async function startMcpHttpServer(options: TestMcpServerOptions = {}) {
  const { port = 0, http, profile, auditLogger, authStore, agentObserver, ...services } = options
  const tools = { ...TEST_TOOLS, ...profile?.tools }
  const shellManager = tools.shell
    ? (services.shellManager ?? createShellSessionManager())
    : undefined
  const capabilityServices = {
    shellManager,
    externalMcp: services.externalMcp,
    webPageOpener: tools.web ? (services.webPageOpener ?? new WebPageOpener()) : undefined,
  }
  const closeRuntime = () =>
    Promise.allSettled([
      shellManager?.close() ?? Promise.resolve(),
      services.externalMcp?.close() ?? Promise.resolve(),
    ])

  try {
    await shellManager?.startDefault()
    const running = await startMcpHttpServerRaw(
      {
        createMcpServer: createMcpServerFactory(capabilityServices, {
          ...profile,
          tools,
        }),
        auditLogger,
        authStore,
        agentObserver,
      },
      { ...http, port }
    )
    return {
      ...running,
      close: async () => {
        await running.close()
        await closeRuntime()
      },
    }
  } catch (error) {
    await closeRuntime()
    throw error
  }
}

export async function connectClient(
  url: string,
  name: string,
  openAiSubject?: string,
  trustedRemote = false,
  openAiSession?: string
) {
  return connectClientWithMode(url, name, "auto", openAiSubject, trustedRemote, openAiSession)
}

export async function connectLegacyClient(url: string, name: string) {
  return connectClientWithMode(url, name, "legacy")
}

async function connectClientWithMode(
  url: string,
  name: string,
  mode: "auto" | "legacy",
  openAiSubject?: string,
  trustedRemote = false,
  openAiSession?: string
) {
  const client = new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode } })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit:
      openAiSubject || trustedRemote || openAiSession
        ? {
            headers: {
              ...(openAiSubject ? { "x-openai-subject": openAiSubject } : {}),
              ...(trustedRemote ? { "x-openchatx-remote": "1" } : {}),
              ...(openAiSession ? { "x-openai-session": openAiSession } : {}),
            },
          }
        : undefined,
  })
  await client.connect(transport)
  return { client, transport }
}

export function postWithHost(url: string, host: string, value: unknown): Promise<number> {
  const target = new URL(url)
  const body = JSON.stringify(value)

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          host,
        },
      },
      (response) => {
        response.resume()
        response.once("end", () => resolve(response.statusCode ?? 0))
      }
    )
    request.once("error", reject)
    request.end(body)
  })
}

export interface ToolSnapshot {
  shell_id?: string
  status: "running" | "completed" | "shell_exited" | "reset"
  exit_code?: number
  cwd: string
  output: string
  request_id?: string
  next_cursor?: number
  cursor_expired?: true
  output_truncated?: true
  dropped_output_bytes?: number
  commands?: Array<{
    run: number
    command?: string
    path?: string
    status: "queued" | "running" | "completed" | "timed_out" | "failed" | "reset"
    exit_code: number | null
    dropped_output_bytes?: number
  }>
}

export async function callUntilComplete(
  client: Client,
  requestId: string,
  command: string | Array<{ command: string; cwd?: string }>,
  shellId?: string
): Promise<ToolSnapshot> {
  let snapshot = snapshotFromResult(
    await client.callTool({
      name: "shell_run",
      arguments: {
        ...(shellId ? { shell_id: shellId } : {}),
        request_id: requestId,
        ...(typeof command === "string" ? { command } : { commands: command }),
        yield_time_ms: 1_000,
      },
    })
  )
  const cwd = snapshot.cwd
  let output = snapshot.output

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (snapshot.status !== "running" && snapshot.next_cursor === undefined) {
      return { ...snapshot, ...(shellId ? { shell_id: shellId } : {}), cwd, output }
    }
    assert.notEqual(snapshot.next_cursor, undefined)
    snapshot = snapshotFromResult(
      await client.callTool({
        name: "shell_poll",
        arguments: {
          ...(shellId ? { shell_id: shellId } : {}),
          request_id: requestId,
          cursor: snapshot.next_cursor,
          yield_time_ms: 100,
        },
      })
    )
    output += snapshot.output
  }

  throw new Error(`MCP command ${requestId} did not complete.`)
}

export function snapshotFromResult(result: Awaited<ReturnType<Client["callTool"]>>): ToolSnapshot {
  assert.equal(result.isError, undefined)
  const text = toolText(result)
  const status = compactField(text, "status")
  const cwd = compactField(text, "cwd")
  const output = compactField(text, "output")
  assert.ok(
    status === "running" ||
      status === "completed" ||
      status === "shell_exited" ||
      status === "reset"
  )
  assert.ok(cwd !== undefined)
  assert.ok(output !== undefined)

  const nextCursor = compactNumberField(text, "next_cursor")
  const exitCode = compactNumberField(text, "exit_code")
  const droppedOutputBytes = compactNumberField(text, "dropped_output_bytes")
  return {
    status,
    cwd,
    output,
    ...(compactField(text, "shell_id") ? { shell_id: compactField(text, "shell_id") } : {}),
    ...(compactField(text, "request_id") ? { request_id: compactField(text, "request_id") } : {}),
    ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(compactField(text, "cursor_expired") === "true" ? { cursor_expired: true } : {}),
    ...(compactField(text, "output_truncated") === "true" ? { output_truncated: true } : {}),
    ...(droppedOutputBytes !== undefined ? { dropped_output_bytes: droppedOutputBytes } : {}),
  }
}

export function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n")
}

export function compactField(text: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const inline = text.match(
    new RegExp(`(?:^|\\s)${escapedKey}=("(?:\\\\.|[^"\\\\])*"|[^\\s]+)`)
  )?.[1]
  if (inline !== undefined) return decodeCompactScalar(inline)

  const section = text.match(new RegExp(`(?:^|\\n\\n)${escapedKey}:\\n`))
  if (!section || section.index === undefined) return undefined
  let start = section.index + section[0].length
  if (text[start] === "\n") start += 1
  const rest = text.slice(start)
  const nextSection = rest.search(/\n\n[a-z][a-z0-9_]*:\n/u)
  return nextSection >= 0 ? rest.slice(0, nextSection) : rest
}

function compactNumberField(text: string, key: string): number | undefined {
  const value = compactField(text, key)
  if (value === undefined) return undefined
  const parsed = Number(value)
  assert.ok(Number.isFinite(parsed), `${key} must be numeric`)
  return parsed
}

function decodeCompactScalar(value: string): string {
  if (!value.startsWith('"')) return value
  return JSON.parse(value) as string
}
