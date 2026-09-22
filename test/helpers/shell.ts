import process from "node:process"
import { MCP_CONFIG } from "../../src/config.js"
import type { ShellSession, ShellSnapshot } from "../../src/tools/shell/session.js"

export async function runToCompletion(
  shell: ShellSession,
  requestId: string,
  command: string | Array<{ command: string; cwd?: string }>,
  options: { cwd?: string; maxOutputTokens?: number } = {}
): Promise<{ output: string; snapshot: ShellSnapshot }> {
  const maxOutputTokens = options.maxOutputTokens ?? MCP_CONFIG.shell.defaultOutputTokens
  const first = await shell.runCommand({
    request_id: requestId,
    ...(typeof command === "string" ? { command } : { commands: command }),
    cwd: options.cwd,
    yield_time_ms: 1_000,
    max_output_tokens: maxOutputTokens,
  })
  let output = first.output
  let snapshot = first

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (snapshot.status !== "running" && !snapshot.output_truncated) {
      return { output, snapshot }
    }
    snapshot = await shell.pollCommand({
      request_id: requestId,
      cursor: snapshot.next_cursor,
      yield_time_ms: 100,
      max_output_tokens: maxOutputTokens,
    })
    output += snapshot.output
  }

  throw new Error(`Command ${requestId} did not complete.`)
}

export async function pollToCompletion(
  shell: ShellSession,
  first: ShellSnapshot,
  maxOutputTokens = MCP_CONFIG.shell.defaultOutputTokens
): Promise<{ output: string; snapshot: ShellSnapshot }> {
  let output = first.output
  let snapshot = first

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (snapshot.status !== "running" && !snapshot.output_truncated) {
      return { output, snapshot }
    }
    snapshot = await shell.pollCommand({
      request_id: first.request_id,
      cursor: snapshot.next_cursor,
      yield_time_ms: 100,
      max_output_tokens: maxOutputTokens,
    })
    output += snapshot.output
  }

  throw new Error(`Command ${first.request_id} did not complete.`)
}

export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    )
      return false
    throw error
  }
}

export async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}
