import { type FSWatcher, watch } from "node:fs"
import { basename, dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import {
  Client,
  fromJsonSchema,
  type Resource,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import type { McpServer, ServerContext } from "@modelcontextprotocol/server"

import { childStringEnvironment } from "../child-environment.js"
import { runtimeProcessRegistry } from "../runtime/process-registry.js"
import { type ExternalMcpServerConfig, loadExternalMcpConfig } from "./config.js"

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000
const SUPERVISOR_INTERVAL_MS = 2_000
const MAX_RESTART_BACKOFF_MS = 30_000
const EXTERNAL_TOOL_ID_RE = /^mcp:([^:]+):(.+)$/u

interface ExternalConnection {
  id: string
  config: ExternalMcpServerConfig
  client: Client
  tools: Tool[]
  resources: Resource[]
}

export interface ExternalMcpResourceOptions {
  allowServers?: readonly string[]
  transformText?: (value: string) => string
}

export interface ExternalMcpCatalogTool {
  id: string
  server: string
  name: string
  originalName: string
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
  registerResources(server: McpServer, options?: ExternalMcpResourceOptions): void
  catalog(): ExternalMcpCatalogTool[]
  call(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  reload(force?: boolean): Promise<void>
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
  const reloadRegistry = (force = false): Promise<void> => {
    const reload = reloadQueue.then(async () => {
      const nextConfig = loadExternalMcpConfig(configPath)
      if (!force && JSON.stringify(nextConfig) === JSON.stringify(config)) return
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
      supervisor.sync()
    })
    reloadQueue = reload.catch(() => undefined)
    return reload
  }

  const supervisor = createExternalMcpSupervisor({
    getConfig: () => config,
    getConnections: () => connections,
    replaceConnections(next) {
      connections = next
      registrations = buildRegistrations(connections)
    },
  })
  supervisor.sync()
  supervisor.start()

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

        const toolConfig = {
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
        }
        const callback = async (args: unknown, context: ServerContext) =>
          supervisor.call(
            connection.id,
            tool.name,
            isRecord(args) ? args : {},
            context.mcpReq.signal
          )
        Reflect.apply(server.registerTool, server, [publicName, toolConfig, callback])
      }
    },
    registerResources(server, options = {}) {
      const allow = options.allowServers?.length ? new Set(options.allowServers) : undefined
      for (const connection of connections) {
        if (allow && !allow.has(connection.id)) continue
        for (const resource of connection.resources)
          registerExternalResource(server, connection, resource, options.transformText)
      }
    },
    catalog() {
      return registrations.map(({ connection, tool, publicName }) => ({
        id: `mcp:${connection.id}:${tool.name}`,
        server: connection.id,
        name: publicName,
        originalName: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      }))
    },
    async call(id, args, signal) {
      const parsed = parseExternalToolId(id)
      const registration = registrations.find(
        ({ connection, tool }) => connection.id === parsed.server && tool.name === parsed.tool
      )
      if (!registration) throw new Error(`Unknown external MCP tool ${JSON.stringify(id)}.`)
      return supervisor.call(
        parsed.server,
        registration.tool.name,
        normalizeExternalToolArguments(parsed.tool, args),
        signal
      )
    },
    reload: reloadRegistry,
    async close() {
      watcher?.close()
      if (reloadTimer) clearTimeout(reloadTimer)
      await supervisor.close()
      await reloadQueue
      await closeConnections(connections)
    },
  }
}

interface SupervisorAccess {
  getConfig: () => ReturnType<typeof loadExternalMcpConfig>
  getConnections: () => ExternalConnection[]
  replaceConnections: (connections: ExternalConnection[]) => void
}

interface ExternalMcpSupervisorController {
  start: () => void
  sync: () => void
  call: (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<unknown>
  close: () => Promise<void>
}

function createExternalMcpSupervisor(access: SupervisorAccess): ExternalMcpSupervisorController {
  const restartCounts = new Map<string, number>()
  const retryAfter = new Map<string, number>()
  const processIds = new Map<string, string>()
  const reconnecting = new Map<string, Promise<ExternalConnection | undefined>>()
  const manuallyStopped = new Set<string>()
  let timer: NodeJS.Timeout | undefined

  const ensureProcessRecord = (id: string, server: ExternalMcpServerConfig): string => {
    const known = processIds.get(id)
    if (known) return known
    const connected = access.getConnections().some((connection) => connection.id === id)
    const processId = runtimeProcessRegistry.register({
      kind: "mcp",
      label: server.name ?? id,
      restartCount: restartCounts.get(id) ?? 0,
      detail: connected ? "Connected" : "Unavailable; supervisor will retry.",
      stop: () => stopServer(id),
      restart: () => restartServer(id),
    })
    if (!connected) runtimeProcessRegistry.update(processId, { status: "backoff" })
    processIds.set(id, processId)
    return processId
  }

  async function stopServer(id: string): Promise<void> {
    manuallyStopped.add(id)
    retryAfter.delete(id)
    const connections = access.getConnections()
    const connection = connections.find((candidate) => candidate.id === id)
    if (connection) {
      try {
        await connection.client.close()
      } catch {
        // Best effort while stopping a supervised MCP.
      }
    }
    access.replaceConnections(connections.filter((candidate) => candidate.id !== id))
    const processId = processIds.get(id)
    if (processId) {
      runtimeProcessRegistry.update(processId, {
        status: "stopped",
        detail: "Stopped by user.",
      })
    }
  }

  async function restartServer(id: string): Promise<void> {
    manuallyStopped.delete(id)
    const count = (restartCounts.get(id) ?? 0) + 1
    restartCounts.set(id, count)
    await stopActiveConnection(id)
    retryAfter.delete(id)
    await reconnect(id, true)
  }

  async function stopActiveConnection(id: string): Promise<void> {
    const connections = access.getConnections()
    const connection = connections.find((candidate) => candidate.id === id)
    if (connection) {
      try {
        await connection.client.close()
      } catch {
        // Best effort while replacing a supervised MCP.
      }
    }
    access.replaceConnections(connections.filter((candidate) => candidate.id !== id))
  }

  const recordFailure = async (id: string, error: unknown): Promise<void> => {
    await stopActiveConnection(id)

    const count = (restartCounts.get(id) ?? 0) + 1
    restartCounts.set(id, count)
    const backoff = Math.min(1_000 * 2 ** Math.max(0, count - 1), MAX_RESTART_BACKOFF_MS)
    retryAfter.set(id, Date.now() + backoff)
    const server = access.getConfig()[id]
    if (!server) return

    const processId = ensureProcessRecord(id, server)
    runtimeProcessRegistry.update(processId, {
      status: "backoff",
      restartCount: count,
      detail: `Reconnect in ${Math.ceil(backoff / 1000)}s: ${describeError(error)}`,
    })
  }

  const reconnect = async (id: string, force = false): Promise<ExternalConnection | undefined> => {
    const existing = access.getConnections().find((candidate) => candidate.id === id)
    if (existing) return existing
    const active = reconnecting.get(id)
    if (active) return active

    const server = access.getConfig()[id]
    if (!server?.enabled) return undefined
    if (!force && manuallyStopped.has(id)) return undefined
    if (!force && Date.now() < (retryAfter.get(id) ?? 0)) return undefined

    const processId = ensureProcessRecord(id, server)
    runtimeProcessRegistry.update(processId, {
      status: "starting",
      restartCount: restartCounts.get(id) ?? 0,
      detail: "Connecting…",
    })

    const attempt = connectServer(id, server)
      .then(async (connection) => {
        if (!connection) {
          await recordFailure(id, new Error("Connection attempt failed."))
          return
        }
        const current = access.getConnections()
        const previous = current.find((candidate) => candidate.id === id)
        if (previous) {
          try {
            await previous.client.close()
          } catch {
            // Best effort: the new connection replaces the previous one regardless.
          }
        }
        access.replaceConnections([
          ...current.filter((candidate) => candidate.id !== id),
          connection,
        ])
        retryAfter.delete(id)
        runtimeProcessRegistry.update(processId, {
          status: "running",
          restartCount: restartCounts.get(id) ?? 0,
          detail: `Connected (${connection.tools.length} tools)`,
        })
        return connection
      })
      .finally(() => reconnecting.delete(id))
    reconnecting.set(id, attempt)
    return attempt
  }

  const run = async (): Promise<void> => {
    const connections = access.getConnections()
    for (const [id, server] of Object.entries(access.getConfig())) {
      if (
        !server.enabled ||
        manuallyStopped.has(id) ||
        connections.some((connection) => connection.id === id)
      )
        continue
      await reconnect(id).catch(() => undefined)
    }
  }

  const callConnectionTool = (
    connection: ExternalConnection,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) =>
    connection.client.callTool(
      { name: toolName, arguments: args },
      {
        timeout: connection.config.timeout ?? DEFAULT_CALL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      }
    )

  const recoverToolCall = async (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    error: unknown,
    signal?: AbortSignal
  ): Promise<unknown> => {
    if (signal?.aborted) throw signal.reason ?? error
    await recordFailure(serverId, error)
    await delay(100)
    const connection = await reconnect(serverId, true)
    if (!connection) throw error
    if (signal?.aborted) throw signal.reason ?? error
    return callConnectionTool(connection, toolName, args, signal)
  }

  const callSupervisedTool = async (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> => {
    if (manuallyStopped.has(serverId)) {
      throw new Error(`External MCP ${serverId} is stopped by the user.`)
    }
    const connection =
      access.getConnections().find((candidate) => candidate.id === serverId) ??
      (await reconnect(serverId, true))
    if (!connection) throw new Error(`External MCP ${serverId} is unavailable.`)

    try {
      return await callConnectionTool(connection, toolName, args, signal)
    } catch (error) {
      return recoverToolCall(serverId, toolName, args, error, signal)
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void run(), SUPERVISOR_INTERVAL_MS)
      timer.unref()
    },
    sync() {
      const config = access.getConfig()
      for (const [id, server] of Object.entries(config)) {
        if (!server.enabled) continue
        if (!processIds.has(id)) manuallyStopped.delete(id)
        ensureProcessRecord(id, server)
      }
      for (const [id, processId] of processIds) {
        if (config[id]?.enabled) continue
        runtimeProcessRegistry.remove(processId)
        processIds.delete(id)
        restartCounts.delete(id)
        retryAfter.delete(id)
        manuallyStopped.delete(id)
      }
    },
    call: callSupervisedTool,
    async close() {
      if (timer) clearInterval(timer)
      timer = undefined
      await Promise.allSettled(reconnecting.values())
      for (const processId of processIds.values()) runtimeProcessRegistry.remove(processId)
      processIds.clear()
    },
  }
}

function registerExternalResource(
  server: McpServer,
  connection: ExternalConnection,
  resource: Resource,
  transform: ((value: string) => string) | undefined
): void {
  const publicName = `${sanitizeToolName(connection.id)}__res__${sanitizeToolName(resource.name)}`
  const read = async (uri: URL, context: ServerContext) => {
    const result = await connection.client.readResource(
      { uri: uri.href },
      { signal: context.mcpReq.signal }
    )
    return {
      contents: result.contents.map((item) =>
        transform && "text" in item && typeof item.text === "string"
          ? { ...item, text: transform(item.text) }
          : item
      ),
    }
  }
  try {
    server.registerResource(
      publicName,
      resource.uri,
      {
        ...(resource.title ? { title: applyText(transform, resource.title) } : {}),
        ...(resource.description
          ? { description: applyText(transform, resource.description) }
          : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        _meta: {
          ...(resource._meta ?? {}),
          "shellby/externalMcp": true,
          "shellby/externalServer": connection.id,
        },
      },
      read
    )
  } catch {
    // Duplicate resource name or uri: keep the first registration.
  }
}

function applyText(transform: ((value: string) => string) | undefined, value: string): string {
  return transform ? transform(value) : value
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

export function normalizeExternalToolArguments(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (toolName !== "call_tool") return args
  const toolset = typeof args.toolset_name === "string" ? args.toolset_name.trim() : ""
  const tool = typeof args.tool_name === "string" ? args.tool_name.trim() : ""
  if (!toolset || !tool.startsWith(`${toolset}.`)) return args
  return { ...args, tool_name: tool.slice(toolset.length + 1) }
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
    let resources: Resource[] = []
    try {
      resources = (await client.listResources(undefined, { timeout: DEFAULT_CONNECT_TIMEOUT_MS }))
        .resources
    } catch {
      resources = []
    }
    console.log(
      `External MCP ${id}: connected (${tools.length} tools, ${resources.length} resources)`
    )
    return { id, config, client, tools, resources }
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean")
    return String(error)
  try {
    return JSON.stringify(error)
  } catch {
    return "Unknown error"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
