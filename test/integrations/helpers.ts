import { request as httpRequest } from "node:http"

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { AgentObserver } from "../../src/agent/observer.js"
import type { OpenChatXAuthStore } from "../../src/auth/store.js"
import { MCP_CONFIG } from "../../src/config.js"
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
import { InteractiveShellManager } from "../../src/tools/shell/interactive-shell.js"
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
  const interactiveShellManager = tools.shell
    ? (services.interactiveShellManager ??
      new InteractiveShellManager(MCP_CONFIG.defaultCwd, MCP_CONFIG.shell.path))
    : undefined
  const capabilityServices: McpCapabilityServices = {
    ...services,
    interactiveShellManager,
    webPageOpener: tools.web ? (services.webPageOpener ?? new WebPageOpener()) : undefined,
  }
  const closeRuntime = () =>
    Promise.allSettled([
      interactiveShellManager?.close() ?? Promise.resolve(),
      services.externalMcp?.close() ?? Promise.resolve(),
    ])

  try {
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

function decodeCompactScalar(value: string): string {
  if (!value.startsWith('"')) return value
  return JSON.parse(value) as string
}
