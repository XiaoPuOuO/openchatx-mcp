import { stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import process from "node:process"

import type { McpServer } from "@modelcontextprotocol/server"
import type { IPty } from "node-pty"
import * as pty from "node-pty"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { toToolError } from "../../mcp/tool-error.js"
import { createTranscriptBuffer, type TranscriptBuffer } from "./transcript.js"

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u
const MAX_INTERACTIVE_SESSIONS = 4
const DEFAULT_WAIT_MS = 500
const MAX_WAIT_MS = 30_000
const READY_PROMPT = "__OPENCHATX_READY__ "
const ESC = String.fromCharCode(27)
const ANSI_ESCAPE_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu")
const OUTPUT_QUIET_MS = 60

interface InteractiveSession {
  id: string
  pty: IPty
  cwd: string
  transcript: TranscriptBuffer
  status: "running" | "exited"
  exitCode: number | null
  waiters: Set<() => void>
}

export class InteractiveShellManager {
  private readonly sessions = new Map<string, InteractiveSession>()

  constructor(
    readonly workspace: string,
    readonly shellPath: string
  ) {}

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)))
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      session_id: session.id,
      status: session.status,
      cwd: session.cwd,
      exit_code: session.exitCode,
    }))
  }

  async startSession(input: {
    sessionId: string
    cwd?: string
    command?: string
    waitMs: number
    maxOutputTokens: number
    signal: AbortSignal
  }) {
    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      throw new Error("session_id must be 3-128 characters using letters, numbers, ., _, or -.")
    }
    if (this.sessions.has(input.sessionId))
      throw new Error(`Session ${input.sessionId} already exists.`)
    if (this.sessions.size >= MAX_INTERACTIVE_SESSIONS) {
      throw new Error(`Interactive shell limit reached (${MAX_INTERACTIVE_SESSIONS}).`)
    }

    const cwd = resolveInteractiveCwd(this.workspace, input.cwd)
    const cwdInfo = await stat(cwd)
    if (!cwdInfo.isDirectory()) throw new Error(`Interactive shell cwd is not a directory: ${cwd}`)

    const terminal = pty.spawn(this.shellPath, ["-f"], {
      cwd,
      env: {
        ...stringEnvironment(process.env),
        PS1: READY_PROMPT,
        PROMPT: READY_PROMPT,
      },
      name: process.env.TERM || "xterm-256color",
      cols: 120,
      rows: 30,
    })
    const session: InteractiveSession = {
      id: input.sessionId,
      pty: terminal,
      cwd,
      transcript: createTranscriptBuffer(MCP_CONFIG.shell.transcriptChars),
      status: "running",
      exitCode: null,
      waiters: new Set(),
    }
    this.sessions.set(input.sessionId, session)
    wireSession(session)

    await waitForPrompt(session, input.signal)
    const cursor = input.command ? session.transcript.end : 0
    if (input.command) {
      terminal.write(`${input.command}\r`)
      await waitForQuiet(session, cursor, input.waitMs, input.signal)
    }
    return snapshot(session, cursor, input.maxOutputTokens)
  }

  async write(input: {
    sessionId: string
    text: string
    enter: boolean
    cursor?: number
    waitMs: number
    maxOutputTokens: number
    signal: AbortSignal
  }) {
    const session = this.requireSession(input.sessionId)
    if (session.status !== "running")
      throw new Error(`Interactive session ${input.sessionId} has exited.`)
    const cursor = input.cursor ?? session.transcript.end
    session.pty.write(input.enter ? `${input.text}\r` : input.text)
    await waitForQuiet(session, cursor, input.waitMs, input.signal)
    return snapshot(session, cursor, input.maxOutputTokens)
  }

  async poll(input: {
    sessionId: string
    cursor: number
    waitMs: number
    maxOutputTokens: number
    signal: AbortSignal
  }) {
    const session = this.requireSession(input.sessionId)
    await waitForSessionChange(session, input.cursor, input.waitMs, input.signal)
    return snapshot(session, input.cursor, input.maxOutputTokens)
  }

  async closeSession(id: string): Promise<void> {
    const session = this.requireSession(id)
    this.sessions.delete(id)
    if (session.status === "running") {
      session.pty.kill("SIGTERM")
      await waitForExit(session, MCP_CONFIG.shell.stopGraceMs)
      if (session.status === "running") session.pty.kill("SIGKILL")
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.requireSession(id)
    if (session.status !== "running") throw new Error(`Interactive session ${id} has exited.`)
    session.pty.resize(cols, rows)
  }

  private requireSession(id: string): InteractiveSession {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Unknown interactive session ${JSON.stringify(id)}.`)
    return session
  }
}

export function registerTerminalTool(server: McpServer, manager: InteractiveShellManager): void {
  const sessionId = z.string().min(3).max(128)
  const waitMs = z.int().min(0).max(MAX_WAIT_MS).default(DEFAULT_WAIT_MS)
  const maxOutputTokens = z
    .int()
    .min(1)
    .max(MCP_CONFIG.shell.maxOutputTokens)
    .default(MCP_CONFIG.shell.defaultOutputTokens)

  const inputSchema = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("create"),
      session_id: sessionId,
      cwd: z.string().min(1).optional(),
      command: z.string().min(1).optional(),
      wait_ms: waitMs,
      max_output_tokens: maxOutputTokens,
    }),
    z.object({
      action: z.literal("write"),
      session_id: sessionId,
      input: z.string(),
      enter: z.boolean().default(false),
      cursor: z.int().nonnegative().optional(),
      wait_ms: waitMs,
      max_output_tokens: maxOutputTokens,
    }),
    z.object({
      action: z.literal("read"),
      session_id: sessionId,
      cursor: z.int().nonnegative(),
      wait_ms: waitMs,
      max_output_tokens: maxOutputTokens,
    }),
    z.object({
      action: z.literal("resize"),
      session_id: sessionId,
      cols: z.int().min(20).max(500),
      rows: z.int().min(5).max(300),
    }),
    z.object({ action: z.literal("close"), session_id: sessionId }),
  ])

  server.registerTool(
    "terminal",
    {
      description:
        "Manage a real pseudo-terminal for interactive CLIs. Actions: create, write, read, resize, close. Use bash for ordinary non-interactive commands.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      if (input.action === "create") {
        return interactiveResult(() =>
          manager.startSession({
            sessionId: input.session_id,
            cwd: input.cwd,
            command: input.command,
            waitMs: input.wait_ms,
            maxOutputTokens: input.max_output_tokens,
            signal: context.mcpReq.signal,
          })
        )
      }
      if (input.action === "write") {
        return interactiveResult(() =>
          manager.write({
            sessionId: input.session_id,
            text: input.input,
            enter: input.enter,
            cursor: input.cursor,
            waitMs: input.wait_ms,
            maxOutputTokens: input.max_output_tokens,
            signal: context.mcpReq.signal,
          })
        )
      }
      if (input.action === "read") {
        return interactiveResult(() =>
          manager.poll({
            sessionId: input.session_id,
            cursor: input.cursor,
            waitMs: input.wait_ms,
            maxOutputTokens: input.max_output_tokens,
            signal: context.mcpReq.signal,
          })
        )
      }
      if (input.action === "resize") {
        return interactiveResult(async () => {
          manager.resize(input.session_id, input.cols, input.rows)
          return { session_id: input.session_id, cols: input.cols, rows: input.rows }
        })
      }
      return interactiveResult(async () => {
        await manager.closeSession(input.session_id)
        return { session_id: input.session_id, closed: true }
      })
    }
  )
}

function wireSession(session: InteractiveSession): void {
  session.pty.onData((data) => {
    session.transcript.append(data)
    notify(session)
  })
  session.pty.onExit(({ exitCode }) => {
    session.status = "exited"
    session.exitCode = exitCode
    notify(session)
  })
}

function notify(session: InteractiveSession): void {
  for (const waiter of session.waiters) waiter()
  session.waiters.clear()
}

async function waitForSessionChange(
  session: InteractiveSession,
  cursor: number,
  waitMs: number,
  signal: AbortSignal
): Promise<void> {
  if (session.transcript.end > cursor || session.status === "exited" || waitMs === 0) return
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      session.waiters.delete(finish)
      resolvePromise()
    }
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.waiters.delete(finish)
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Interactive shell wait aborted.")
      )
    }
    const timer = setTimeout(finish, waitMs)
    session.waiters.add(finish)
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function waitForQuiet(
  session: InteractiveSession,
  cursor: number,
  waitMs: number,
  signal: AbortSignal
): Promise<void> {
  if (waitMs === 0 || session.status === "exited") return
  const deadline = Date.now() + waitMs
  if (session.transcript.end <= cursor) {
    await waitForSessionChange(session, cursor, waitMs, signal)
  }
  while (session.status === "running" && Date.now() < deadline) {
    const before = session.transcript.end
    const quietWait = Math.min(OUTPUT_QUIET_MS, Math.max(0, deadline - Date.now()))
    if (quietWait === 0) return
    await waitForSessionChange(session, before, quietWait, signal)
    if (session.transcript.end === before) return
  }
}

function snapshot(session: InteractiveSession, cursor: number, maxOutputTokens: number) {
  const read = session.transcript.read(cursor, maxOutputTokens)
  return {
    session_id: session.id,
    status: session.status,
    ...(session.exitCode === null ? {} : { exit_code: session.exitCode }),
    output: cleanTerminalOutput(read.output),
    next_cursor: read.nextCursor,
    ...(read.hasMore ? { output_truncated: true as const } : {}),
    ...(read.cursorExpired ? { cursor_expired: true as const } : {}),
  }
}

async function waitForPrompt(session: InteractiveSession, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now()
  let cursor = 0
  while (Date.now() - startedAt < MCP_CONFIG.shell.readyTimeoutMs) {
    const read = session.transcript.read(cursor, MCP_CONFIG.shell.maxOutputTokens)
    if (read.output.includes(READY_PROMPT)) return
    cursor = read.nextCursor
    if (session.status === "exited")
      throw new Error("Interactive shell exited before becoming ready.")
    await waitForSessionChange(session, cursor, 50, signal)
  }
  throw new Error(
    `Interactive shell did not become ready within ${MCP_CONFIG.shell.readyTimeoutMs}ms.`
  )
}

function cleanTerminalOutput(output: string): string {
  return output.replace(ANSI_ESCAPE_RE, "").replaceAll("\r", "")
}

async function interactiveResult(operation: () => Promise<Record<string, unknown>>) {
  try {
    const structuredContent = await operation()
    return { structuredContent, content: [] }
  } catch (error) {
    throw toToolError(error, "INTERACTIVE_SHELL_FAILED")
  }
}

function resolveInteractiveCwd(workspace: string, cwd?: string): string {
  if (!cwd) return workspace
  return isAbsolute(cwd) ? cwd : resolve(workspace, cwd)
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )
}

async function waitForExit(session: InteractiveSession, waitMs: number): Promise<void> {
  if (session.status === "exited") return
  await new Promise<void>((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer)
      session.waiters.delete(finish)
      resolvePromise()
    }
    const timer = setTimeout(finish, waitMs)
    session.waiters.add(finish)
  })
}
