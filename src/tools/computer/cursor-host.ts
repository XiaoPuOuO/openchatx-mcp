/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Biome fails to track stopping across async lifecycle callbacks */
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import process from "node:process"

export interface CursorHostOptions {
  executable: string
  restartDelayMs?: number
}

export class CursorHostManager {
  private child: ChildProcess | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private stopping = false

  constructor(private readonly options: CursorHostOptions) {}

  get enabled(): boolean {
    return existsSync(this.options.executable)
  }

  start(): boolean {
    if (!this.enabled || this.child || this.stopping) return false
    this.spawn()
    return true
  }

  async close(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined

    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null || child.signalCode !== null) return

    child.kill("SIGTERM")
    if (await waitForExit(child, 1_000)) return
    child.kill("SIGKILL")
    await waitForExit(child, 1_000)
  }

  private spawn(): void {
    const child = spawn(this.options.executable, [], {
      stdio: "ignore",
      env: {
        ...process.env,
        SHELLBY_CURSOR_PARENT_PID: String(process.pid),
      },
    })
    this.child = child

    child.once("error", (error) => {
      if (!this.stopping) console.warn(`Cursor host failed: ${error.message}`)
    })
    child.once("exit", () => {
      if (this.child === child) this.child = undefined
      if (this.stopping) return
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined
        if (!this.stopping) this.spawn()
      }, this.options.restartDelayMs ?? 500)
      this.restartTimer.unref()
    })
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once("exit", onExit)
  })
}
