import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import {
  type ExternalMcpConfig,
  type ExternalMcpServerConfig,
  loadExternalMcpConfig,
  saveExternalMcpConfig,
} from "../../external-mcp/config.js"
import { toToolError } from "../../mcp/tool-error.js"

const actionSchema = z.enum(["create", "update", "delete", "enable", "disable"])

const manageInputSchema = z.object({
  action: actionSchema,
  server_id: z.string().min(1),
  type: z.enum(["local", "remote"]).optional(),
  url: z.string().url().nullable().optional(),
  command: z.array(z.string().min(1)).min(1).nullable().optional(),
  cwd: z.string().min(1).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  environment: z.record(z.string(), z.string()).nullable().optional(),
  timeout: z.number().int().positive().nullable().optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
})

export function registerMcpServerManagementTools(
  server: McpServer,
  configPath = MCP_CONFIG.externalMcp.configFile
): void {
  server.registerTool(
    "mcp_server_list",
    {
      description:
        "List configured local and remote MCP servers. Secret-bearing header and environment values are redacted.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const config = loadExternalMcpConfig(configPath)
        return {
          structuredContent: { servers: redactConfig(config) },
          content: [],
        }
      } catch (error) {
        throw toToolError(error, "MCP_SERVER_MANAGE_FAILED")
      }
    }
  )

  server.registerTool(
    "mcp_server_manage",
    {
      description:
        "Create, update, delete, enable, or disable an external MCP server in mcp-servers.json. Changes are validated before writing and require restarting openchatx-mcp to reconnect servers.",
      inputSchema: manageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const current = loadExternalMcpConfig(configPath)
        const next = applyAction(current, input)
        const saved = saveExternalMcpConfig(configPath, next)
        return {
          structuredContent: {
            ok: true,
            restart_required: true,
            servers: redactConfig(saved),
          },
          content: [
            {
              type: "text" as const,
              text: "Saved MCP server configuration. Restart openchatx-mcp to apply connection changes.",
            },
          ],
        }
      } catch (error) {
        throw toToolError(error, "MCP_SERVER_MANAGE_FAILED")
      }
    }
  )
}

type ManageInput = z.infer<typeof manageInputSchema>

function applyAction(current: ExternalMcpConfig, input: ManageInput): ExternalMcpConfig {
  const next = { ...current }
  const existing = current[input.server_id]

  if (input.action === "delete") {
    if (!existing) throw new Error(`Unknown MCP server ${JSON.stringify(input.server_id)}.`)
    delete next[input.server_id]
    return next
  }

  if (input.action === "enable" || input.action === "disable") {
    if (!existing) throw new Error(`Unknown MCP server ${JSON.stringify(input.server_id)}.`)
    next[input.server_id] = { ...existing, enabled: input.action === "enable" }
    return next
  }

  if (input.action === "create" && existing) {
    throw new Error(`MCP server ${JSON.stringify(input.server_id)} already exists.`)
  }
  if (input.action === "update" && !existing) {
    throw new Error(`Unknown MCP server ${JSON.stringify(input.server_id)}.`)
  }

  next[input.server_id] = buildServerConfig(existing, input)
  return next
}

function buildServerConfig(
  existing: ExternalMcpServerConfig | undefined,
  input: ManageInput
): ExternalMcpServerConfig {
  const type = input.type ?? existing?.type
  if (!type) throw new Error("type is required when creating an MCP server.")

  const description = nullableValue(input.description, existing?.description)
  const timeout = nullableValue(input.timeout, existing?.timeout)
  const common = {
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(description === undefined ? {} : { description }),
    ...(timeout === undefined ? {} : { timeout }),
  }

  if (type === "remote") {
    const previous = existing?.type === "remote" ? existing : undefined
    const url = input.url ?? previous?.url
    if (!url) throw new Error("url is required for a remote MCP server.")
    const headers = nullableValue(input.headers, previous?.headers)
    return {
      type: "remote",
      url,
      ...common,
      ...(headers === undefined ? {} : { headers }),
    }
  }

  const previous = existing?.type === "local" ? existing : undefined
  const command = input.command ?? previous?.command
  if (!command) throw new Error("command is required for a local MCP server.")
  const cwd = nullableValue(input.cwd, previous?.cwd)
  const environment = nullableValue(input.environment, previous?.environment)
  return {
    type: "local",
    command,
    ...common,
    ...(cwd === undefined ? {} : { cwd }),
    ...(environment === undefined ? {} : { environment }),
  }
}

function nullableValue<Value>(
  supplied: Value | null | undefined,
  previous: Value | undefined
): Value | undefined {
  return supplied === null ? undefined : (supplied ?? previous)
}

function redactConfig(config: ExternalMcpConfig) {
  return Object.fromEntries(
    Object.entries(config).map(([id, server]) => [
      id,
      server.type === "remote"
        ? {
            ...server,
            ...(server.headers ? { headers: redactRecord(server.headers) } : {}),
          }
        : {
            ...server,
            ...(server.environment ? { environment: redactRecord(server.environment) } : {}),
          },
    ])
  )
}

function redactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map((key) => [key, "<redacted>"]))
}
