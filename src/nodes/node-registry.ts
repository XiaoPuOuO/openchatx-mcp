import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client"
import { z } from "zod"

import { MCP_CONFIG } from "../config.js"

const nodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  name: z.string().min(1),
  url: z.url(),
  enabled: z.boolean().default(true),
  token: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const stateSchema = z.object({ nodes: z.array(nodeSchema) })

export type OpenChatXNode = z.infer<typeof nodeSchema>

export interface NodeSummary {
  id: string
  name: string
  url: string
  enabled: boolean
  description?: string
  hasToken: boolean
}

export interface NodeProbe {
  id: string
  ok: boolean
  status?: number
  error?: string
}

const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 120_000
const WHITESPACE_RE = /\s+/u

export class NodeRegistry {
  private readonly nodes = new Map<string, OpenChatXNode>()
  private loadPromise?: Promise<void>

  constructor(private readonly statePath = resolve(MCP_CONFIG.stateDir, "nodes.json")) {}

  async list(): Promise<NodeSummary[]> {
    await this.ensureLoaded()
    return [...this.nodes.values()]
      .map((node) => ({
        id: node.id,
        name: node.name,
        url: node.url,
        enabled: node.enabled,
        ...(node.description ? { description: node.description } : {}),
        hasToken: Boolean(node.token),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async upsert(input: {
    id: string
    name: string
    url: string
    enabled?: boolean
    token?: string
    description?: string
  }): Promise<NodeSummary> {
    await this.ensureLoaded()
    const now = new Date().toISOString()
    const previous = this.nodes.get(input.id)
    const node = nodeSchema.parse({
      ...input,
      enabled: input.enabled ?? previous?.enabled ?? true,
      token: input.token ?? previous?.token,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    })
    this.nodes.set(node.id, node)
    await this.persist()
    return this.summary(node)
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.nodes.delete(id)) throw new Error(`Unknown OpenChatX node ${JSON.stringify(id)}.`)
    await this.persist()
  }

  async probe(id: string): Promise<NodeProbe> {
    const node = await this.requireEnabled(id)
    const healthUrl = healthUrlFor(node.url)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    try {
      const response = await fetch(healthUrl, {
        headers: nodeHeaders(node),
        signal: controller.signal,
      })
      return { id, ok: response.ok, status: response.status }
    } catch (error) {
      return {
        id,
        ok: false,
        error: error instanceof Error ? error.message : "Node health probe failed.",
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async tools(
    id: string,
    query?: string
  ): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    const node = await this.requireEnabled(id)
    return this.withClient(node, async (client) => {
      const { tools } = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS })
      const terms = query?.toLowerCase().split(WHITESPACE_RE).filter(Boolean) ?? []
      return tools
        .filter((tool) => terms.length === 0 || matchesTool(tool, terms))
        .map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        }))
    })
  }

  async call(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const node = await this.requireEnabled(id)
    return this.withClient(node, (client) =>
      client.callTool({ name: tool, arguments: args }, { timeout: CALL_TIMEOUT_MS })
    )
  }

  private async withClient<T>(
    node: OpenChatXNode,
    run: (client: Client) => Promise<T>
  ): Promise<T> {
    const client = new Client({ name: "openchatx-node-client", version: MCP_CONFIG.server.version })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(node.url), {
          requestInit: { headers: nodeHeaders(node) },
        }),
        { timeout: CONNECT_TIMEOUT_MS }
      )
      return await run(client)
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  private async requireEnabled(id: string): Promise<OpenChatXNode> {
    await this.ensureLoaded()
    const node = this.nodes.get(id)
    if (!node?.enabled) throw new Error(`Unknown or disabled OpenChatX node ${JSON.stringify(id)}.`)
    return node
  }

  private summary(node: OpenChatXNode): NodeSummary {
    return {
      id: node.id,
      name: node.name,
      url: node.url,
      enabled: node.enabled,
      ...(node.description ? { description: node.description } : {}),
      hasToken: Boolean(node.token),
    }
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8")))
      for (const node of state.nodes) this.nodes.set(node.id, node)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(
      this.statePath,
      `${JSON.stringify({ nodes: [...this.nodes.values()] }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    )
  }
}

function nodeHeaders(node: OpenChatXNode): Record<string, string> {
  return node.token ? { Authorization: `Bearer ${node.token}` } : {}
}

function healthUrlFor(mcpUrl: string): string {
  const url = new URL(mcpUrl)
  url.pathname = "/healthz"
  url.search = ""
  url.hash = ""
  return url.toString()
}

function matchesTool(tool: Tool, terms: string[]): boolean {
  const haystack = [tool.name, tool.title, tool.description].filter(Boolean).join(" ").toLowerCase()
  return terms.every((term) => haystack.includes(term))
}
