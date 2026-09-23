import type { ChildProcess } from "node:child_process"
import process from "node:process"

export type ProcessGroupTerminationResult = "child_exited" | "grace_elapsed" | "cancelled"

export interface ProcessGroupTermination {
  readonly completion: Promise<ProcessGroupTerminationResult>
  cancel(): void
}

export interface ProcessGroupTerminationOptions {
  graceMs: number
  waitForExit?: boolean
  unrefGraceTimer?: boolean
}

/**
 * Signal a child process and, on POSIX, its detached process group.
 *
 * Cleanup is deliberately best effort. Callers own any domain-level recovery or forced settlement
 * when the operating system refuses the signal.
 */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // Best effort: callers decide how failed cleanup affects their own lifecycle.
  }
}

/**
 * Start SIGTERM -> grace -> SIGKILL escalation for a detached child process group.
 *
 * With waitForExit, SIGKILL happens as soon as the child exits or the grace elapses, whichever
 * comes first. Without it, the full grace always elapses before SIGKILL. Cancellation stops pending
 * escalation but does not undo the initial SIGTERM.
 */
export function startProcessGroupTermination(
  child: ChildProcess,
  options: ProcessGroupTerminationOptions
): ProcessGroupTermination {
  let settled = false
  let timer: NodeJS.Timeout | null = null
  let resolveCompletion!: (result: ProcessGroupTerminationResult) => void

  const completion = new Promise<ProcessGroupTerminationResult>((resolve) => {
    resolveCompletion = resolve
  })

  const onExit = () => forceKill("child_exited")

  function cleanup(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    child.off("exit", onExit)
  }

  function settle(result: ProcessGroupTerminationResult): void {
    if (settled) return
    settled = true
    cleanup()
    resolveCompletion(result)
  }

  function forceKill(result: Exclude<ProcessGroupTerminationResult, "cancelled">): void {
    if (settled) return
    signalProcessGroup(child, "SIGKILL")
    settle(result)
  }

  function cancel(): void {
    settle("cancelled")
  }

  signalProcessGroup(child, "SIGTERM")
  timer = setTimeout(() => forceKill("grace_elapsed"), options.graceMs)
  if (options.unrefGraceTimer) timer.unref()

  if (options.waitForExit) {
    if (child.exitCode !== null || child.signalCode !== null) forceKill("child_exited")
    else child.once("exit", onExit)
  }

  return { completion, cancel }
}
