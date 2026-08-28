import assert from "node:assert/strict"
import { request as httpRequest } from "node:http"

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

import { startMcpHttpServer as startMcpHttpServerRaw, type StartMcpServerOptions } from "../../src/server/http-server.js"

export function startMcpHttpServer(options: StartMcpServerOptions = {}) {
  return startMcpHttpServerRaw({ toolOutputStructured: "always", ...options })
}

export async function connectClient(url: string, name: string, openAiSubject?: string, trustedRemote = false, openAiSession?: string) {
  const client = new Client({ name, version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit:
      openAiSubject || trustedRemote || openAiSession
        ? {
            headers: {
              ...(openAiSubject ? { "x-openai-subject": openAiSubject } : {}),
              ...(trustedRemote ? { "x-shellby-remote": "1" } : {}),
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
        wait_ms: 1_000,
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
          wait_ms: 100,
        },
      })
    )
    output += snapshot.output
  }

  throw new Error(`MCP command ${requestId} did not complete.`)
}

export function snapshotFromResult(result: Awaited<ReturnType<Client["callTool"]>>): ToolSnapshot {
  assert.equal(result.isError, undefined)
  assert.ok(result.structuredContent)
  return result.structuredContent as unknown as ToolSnapshot
}
