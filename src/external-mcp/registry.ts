import { type FSWatcher, watch } from "node:fs"
import { basename, dirname } from "node:path"

import {
  Client,
  fromJsonSchema,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import type { McpServer } from "@modelcontextprotocol/server"

import { childStringEnvironment } from "../child-environment.js"
import { type ExternalMcpServerConfig, loadExternalMcpConfig } from "./config.js"

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000
const EXTERNAL_TOOL_ID_RE = /^mcp:([^:]+):(.+)$/u

interface ExternalConnection {
  id: string
  config: ExternalMcpServerConfig
  client: Client
  tools: Tool[]
}

export interface ExternalMcpCatalogTool {
  id: string
  server: string
  name: string
  description?: string
  inputSchema: unknown
}

export interface ExternalMcpCapability {
  id: string
  name: string
  description?: string
  available: boolean
  toolCount: number
}

export interface ExternalMcpRegistry {
  readonly connectedServers: readonly string[]
  readonly toolCount: number
  capabilities(): ExternalMcpCapability[]
  registerTools(server: McpServer): void
  catalog(): ExternalMcpCatalogTool[]
  call(id: string, args: Record<string, unknown>): Promise<unknown>
  reload(): Promise<void>
  close(): Promise<void>
}

export async function createExternalMcpRegistry(configPath: string): Promise<ExternalMcpRegistry> {
  let config = loadExternalMcpConfig(configPath)
  let connections = (
    await Promise.all(
      Object.entries(config)
        .filter(([, server]) => server.enabled)
        .map(async ([id, server]) => connectServer(id, server))
    )
  ).filter((connection): connection is ExternalConnection => connection !== undefined)

  let registrations = buildRegistrations(connections)
  let watcher: FSWatcher | undefined
  let reloadTimer: NodeJS.Timeout | undefined
  let reloadQueue: Promise<void> = Promise.resolve()

  const reloadRegistry = (): Promise<void> => {
    const reload = reloadQueue.then(async () => {
      const nextConfig = loadExternalMcpConfig(configPath)
      if (JSON.stringify(nextConfig) === JSON.stringify(config)) return
      const nextConnections = (
        await Promise.all(
          Object.entries(nextConfig)
            .filter(([, server]) => server.enabled)
            .map(async ([id, server]) => connectServer(id, server))
        )
      ).filter((connection): connection is ExternalConnection => connection !== undefined)
      let nextRegistrations: ReturnType<typeof buildRegistrations>
      try {
        nextRegistrations = buildRegistrations(nextConnections)
      } catch (error) {
        await closeConnections(nextConnections)
        throw error
      }
      const previousConnections = connections
      config = nextConfig
      connections = nextConnections
      registrations = nextRegistrations
      await closeConnections(previousConnections)
    })
    reloadQueue = reload.catch(() => undefined)
    return reload
  }

  watcher = watch(dirname(configPath), (_event, filename) => {
    if (filename && filename.toString() !== basename(configPath)) return
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      void reloadRegistry().catch((error) => {
        console.warn(
          `External MCP config reload failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }, 150)
    reloadTimer.unref()
  })

  return {
    get connectedServers() {
      return connections.map(({ id }) => id)
    },
    get toolCount() {
      return registrations.length
    },
    capabilities() {
      return Object.entries(config)
        .filter(([, server]) => server.enabled)
        .map(([id, server]) => {
          const connection = connections.find((candidate) => candidate.id === id)
          const description =
            server.description ?? summarizeCapabilityFromTools(connection?.tools ?? [])
          return {
            id,
            name: server.name ?? id,
            ...(description ? { description } : {}),
            available: connection !== undefined,
            toolCount: connection?.tools.length ?? 0,
          }
        })
        .sort((a, b) => a.id.localeCompare(b.id))
    },
    registerTools(server) {
      for (const { connection, tool, publicName } of registrations) {
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: MCP Tool.inputSchema is JSON Schema from the same SDK, but the SDK exposes slightly different structural types on client and converter APIs.
        const inputSchema = fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0])
        const outputSchema = tool.outputSchema
          ? fromJsonSchema(
              // biome-ignore lint/nursery/noUnsafeTypeAssertion: Same SDK JSON Schema boundary as inputSchema above.
              tool.outputSchema as Parameters<typeof fromJsonSchema>[0]
            )
          : undefined
        const description = [
          connection.config.description
            ? `[${connection.id}] ${connection.config.description}`
            : `[${connection.id}]`,
          tool.description,
        ]
          .filter(Boolean)
          .join("\n\n")

        server.registerTool(
          publicName,
          {
            title: tool.title,
            description,
            inputSchema,
            outputSchema,
            annotations: tool.annotations,
            icons: tool.icons,
            _meta: {
              ...(tool._meta ?? {}),
              "shellby/externalMcp": true,
              "shellby/externalServer": connection.id,
              "shellby/originalTool": tool.name,
            },
          },
          async (args) =>
            connection.client.callTool(
              {
                name: tool.name,
                arguments: isRecord(args) ? args : {},
              },
              { timeout: connection.config.timeout ?? DEFAULT_CALL_TIMEOUT_MS }
            )
        )
      }
    },
    catalog() {
      return registrations.map(({ connection, tool, publicName }) => ({
        id: `mcp:${connection.id}:${tool.name}`,
        server: connection.id,
        name: publicName,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      }))
    },
    async call(id, args) {
      const parsed = parseExternalToolId(id)
      const registration = registrations.find(
        ({ connection, tool }) => connection.id === parsed.server && tool.name === parsed.tool
      )
      if (!registration) throw new Error(`Unknown external MCP tool ${JSON.stringify(id)}.`)
      return registration.connection.client.callTool(
        { name: registration.tool.name, arguments: args },
        { timeout: registration.connection.config.timeout ?? DEFAULT_CALL_TIMEOUT_MS }
      )
    },
    reload: reloadRegistry,
    async close() {
      watcher?.close()
      if (reloadTimer) clearTimeout(reloadTimer)
      await reloadQueue
      await closeConnections(connections)
    },
  }
}

function buildRegistrations(connections: readonly ExternalConnection[]) {
  const publicNames = new Set<string>()
  return connections.flatMap((connection) =>
    connection.tools.map((tool) => {
      const publicName = `${sanitizeToolName(connection.id)}__${sanitizeToolName(tool.name)}`
      if (publicNames.has(publicName)) {
        throw new Error(`External MCP tool name collision: ${publicName}`)
      }
      publicNames.add(publicName)
      return { connection, tool, publicName }
    })
  )
}

async function closeConnections(connections: readonly ExternalConnection[]): Promise<void> {
  await Promise.allSettled(connections.map(({ client }) => client.close()))
}

function parseExternalToolId(id: string): { server: string; tool: string } {
  if (!EXTERNAL_TOOL_ID_RE.test(id))
    throw new Error(`Invalid external MCP tool id ${JSON.stringify(id)}.`)
  const separator = id.indexOf(":", 4)
  return { server: id.slice(4, separator), tool: id.slice(separator + 1) }
}

async function connectServer(
  id: string,
  config: ExternalMcpServerConfig
): Promise<ExternalConnection | undefined> {
  const client = new Client({ name: `openchatx-${sanitizeToolName(id)}`, version: "1.0.0" })
  try {
    if (config.type === "local") {
      const [command, ...args] = config.command
      if (!command) throw new Error(`External MCP ${id}: local command is empty.`)
      await client.connect(
        new StdioClientTransport({
          command,
          args,
          cwd: config.cwd,
          env: {
            ...childStringEnvironment(getDefaultEnvironment()),
            ...config.environment,
          },
          stderr: "inherit",
        }),
        { timeout: DEFAULT_CONNECT_TIMEOUT_MS }
      )
    } else {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        }),
        { timeout: DEFAULT_CONNECT_TIMEOUT_MS }
      )
    }

    const { tools } = await client.listTools(undefined, {
      timeout: DEFAULT_CONNECT_TIMEOUT_MS,
    })
    console.log(`External MCP ${id}: connected (${tools.length} tools)`)
    return { id, config, client, tools }
  } catch (error) {
    await client.close().catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`External MCP ${id}: unavailable (${message})`)
    return undefined
  }
}

function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/gu, "_").replace(/_+/gu, "_")
  return sanitized || "mcp"
}

function summarizeCapabilityFromTools(tools: Tool[]): string | undefined {
  if (tools.length === 0) return undefined
  const names = tools
    .slice(0, 6)
    .map((tool) => tool.title ?? tool.name)
    .filter(Boolean)
  if (names.length === 0) return undefined
  const suffix = tools.length > names.length ? ", …" : ""
  return `Provides MCP tools including ${names.join(", ")}${suffix}.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
