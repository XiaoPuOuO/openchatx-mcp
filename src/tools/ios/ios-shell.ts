import { readFile } from "node:fs/promises"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"

const MAX_RESPONSE_BYTES = 1024 * 1024

const iosShellResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.int().min(0).max(255).nullable(),
})

export interface IosShellClientOptions {
  host?: string
  port?: number
  tokenFile?: string
  timeoutMs?: number
}

export type IosShellResult = z.infer<typeof iosShellResultSchema>

export class IosShellClient {
  readonly host?: string
  readonly port: number
  readonly tokenFile?: string
  readonly timeoutMs: number

  constructor(options: IosShellClientOptions = {}) {
    this.host = options.host ?? MCP_CONFIG.ios.host
    this.port = options.port ?? MCP_CONFIG.ios.port
    this.tokenFile = options.tokenFile ?? MCP_CONFIG.ios.tokenFile
    this.timeoutMs = options.timeoutMs ?? MCP_CONFIG.ios.timeoutMs
  }

  async execute(command: string, signal?: AbortSignal): Promise<IosShellResult> {
    if (!this.host || !this.tokenFile) {
      throw new Error("shell_iOS is not configured. Set MCP_IOS_HOST and MCP_IOS_TOKEN_FILE, then restart the MCP server.")
    }

    const token = (await readFile(this.tokenFile, "utf8")).trim()
    if (!token) throw new Error(`shell_iOS token file is empty: ${this.tokenFile}`)

    const response = await sendRequest(this.host, this.port, { token, command }, this.timeoutMs, signal)
    const parsed = JSON.parse(response) as unknown
    if (isBridgeError(parsed)) throw new Error(`iPhone bridge: ${parsed.error}`)

    const result = iosShellResultSchema.safeParse(parsed)
    if (!result.success) throw new Error("iPhone bridge returned an invalid response.")
    return result.data
  }
}

export function registerIosShellTool(server: McpServer, client = new IosShellClient()): void {
  server.registerTool(
    "shell_iOS",
    {
      description:
        "Execute a command on the user's iPhone through the configured a-Shell bridge and return stdout, stderr, and exit code. Use for iPhone work when a-Shell is reachable; the app may need to be open or recently active.",
      inputSchema: z.object({
        command: z.string().min(1).describe("Command to execute in a-Shell on the iPhone."),
      }),
      outputSchema: iosShellResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command }, ctx) => {
      try {
        const result = await client.execute(command, ctx.mcpReq.signal)
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: summarizeResult(result) }],
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `shell_iOS_error: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )
}

function sendRequest(host: string, port: number, request: { token: string; command: string }, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line prefer-const
    let child: ChildProcessWithoutNullStreams | undefined
    let response = Buffer.alloc(0)
    let settled = false

    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      child?.kill()
      if (error) reject(error)
      else resolve(value ?? "")
    }

    const abort = () => finish(new Error("shell_iOS request aborted."))
    const timer = setTimeout(() => finish(new Error(`iPhone bridge timed out after ${timeoutMs}ms.`)), timeoutMs)

    if (signal?.aborted) {
      finish(new Error("shell_iOS request aborted."))
      return
    }
    signal?.addEventListener("abort", abort, { once: true })

    child = spawn("/usr/bin/nc", [host, String(port)], { stdio: ["pipe", "pipe", "pipe"] })
    child.stdout.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk])
      if (response.byteLength > MAX_RESPONSE_BYTES) {
        finish(new Error(`iPhone bridge response exceeded ${MAX_RESPONSE_BYTES} bytes.`))
        return
      }
      const newline = response.indexOf(0x0a)
      if (newline !== -1) finish(undefined, response.subarray(0, newline).toString("utf8"))
    })
    let transportError = ""
    child.stderr.on("data", (chunk: Buffer) => {
      transportError += chunk.toString("utf8")
    })
    child.once("error", (error) => finish(error))
    child.once("close", (code) => {
      if (settled) return
      const detail = transportError.trim()
      if (code !== 0) {
        finish(new Error(detail || `iPhone bridge connection failed with exit code ${code ?? "unknown"}.`))
        return
      }
      finish(new Error("iPhone bridge closed the connection without a response."))
    })
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}

function isBridgeError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value && typeof (value as { error?: unknown }).error === "string"
}

function summarizeResult(result: IosShellResult): string {
  const sections = []
  if (result.stdout) sections.push(result.stdout)
  if (result.stderr) sections.push(`stderr:\n${result.stderr}`)
  sections.push(`exit_code: ${result.exit_code ?? "unknown"}`)
  return sections.join("\n")
}
