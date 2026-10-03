import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { runtimeProcessRegistry } from "../runtime/process-registry.js"
import {
  type CapabilityPermission,
  currentRuntimeExecutionGrant,
} from "../runtime/runtime-control.js"

const SENSITIVE_ENV_RE = /(?:key|token|secret|password|credential|authorization|cookie)/iu
const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000
const SOURCE_RUNTIME = import.meta.url.endsWith(".ts")
const WORKER_ARG_WITH_VALUE = new Set(["--import", "--loader", "--require", "--conditions"])
const WORKER_ARG_PREFIXES = ["--import=", "--loader=", "--require=", "--conditions="] as const

interface SandboxMessage {
  ok: boolean
  result?: unknown
  error?: string
}

export async function runToolInSandbox(input: {
  runtimePath: string
  toolboxId: string
  name: string
  argumentsValue: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<unknown> {
  const grant = currentRuntimeExecutionGrant()
  const permissions = grant?.permissions ?? []
  const fullAccess = grant?.accessMode === "full-access"
  const runtimePath = safeRealpath(input.runtimePath)
  const worker = new Worker(
    new URL(SOURCE_RUNTIME ? "./sandbox-worker.ts" : "./sandbox-worker.js", import.meta.url),
    {
      workerData: {
        runtimePath,
        name: input.name,
        toolboxId: input.toolboxId,
        input: input.argumentsValue,
        allowNetwork: fullAccess || permissions.includes("network"),
      },
      env: sandboxEnvironment(fullAccess || permissions.includes("secrets")),
      execArgv: buildSandboxExecArgv({
        runtimePath,
        permissions,
        fullAccess,
      }),
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 8,
      },
    }
  )

  const processId = runtimeProcessRegistry.register({
    kind: "sandbox",
    label: `${input.toolboxId}/${input.name}`,
    threadId: worker.threadId,
    detail: fullAccess
      ? "Full Access Trust Mode"
      : `permissions: ${permissions.join(", ") || "none"}`,
    stop: () => worker.terminate().then(() => undefined),
  })

  const timeout = setTimeout(() => {
    runtimeProcessRegistry.update(processId, {
      status: "failed",
      detail: "Sandbox execution timed out.",
    })
    void worker.terminate()
  }, input.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS)
  timeout.unref()

  const onAbort = () => {
    runtimeProcessRegistry.update(processId, { status: "stopped", detail: "Stopped by user." })
    void worker.terminate()
  }
  input.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    return await waitForWorker(worker)
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onAbort)
    runtimeProcessRegistry.remove(processId)
  }
}

export function buildSandboxExecArgv(input: {
  runtimePath: string
  permissions: CapabilityPermission[]
  fullAccess: boolean
}): string[] {
  const inherited = SOURCE_RUNTIME ? [] : workerSafeExecArgv(process.execArgv)
  if (input.fullAccess) return inherited

  const supportRoot = dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(supportRoot, "../..")
  const args = [...inherited, "--permission"]

  if (input.permissions.includes("filesystem")) {
    args.push("--allow-fs-read=*", "--allow-fs-write=*")
  } else {
    const runtimeDirectory = dirname(input.runtimePath)
    const canonicalRuntimeDirectory = safeRealpath(runtimeDirectory)
    args.push(`--allow-fs-read=${packageRoot}`, `--allow-fs-read=${runtimeDirectory}`)
    if (canonicalRuntimeDirectory !== runtimeDirectory) {
      args.push(`--allow-fs-read=${canonicalRuntimeDirectory}`)
    }
  }
  if (input.permissions.includes("shell")) {
    args.push("--allow-child-process", "--allow-worker")
  }
  return args
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function workerSafeExecArgv(values: readonly string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value) continue
    if (WORKER_ARG_WITH_VALUE.has(value)) {
      const next = values[index + 1]
      if (next) {
        result.push(value, next)
        index += 1
      }
      continue
    }
    if (
      value === "--enable-source-maps" ||
      value === "--no-warnings" ||
      WORKER_ARG_PREFIXES.some((prefix) => value.startsWith(prefix))
    ) {
      result.push(value)
    }
  }
  return result
}

function sandboxEnvironment(includeSecrets: boolean): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!includeSecrets && SENSITIVE_ENV_RE.test(key)) continue
    result[key] = value
  }
  result.OPENCHATX_SANDBOX = "1"
  return result
}

function waitForWorker(worker: Worker): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      action()
    }
    worker.once("message", (message: SandboxMessage) => {
      settle(() => {
        if (message.ok) resolvePromise(message.result)
        else reject(new Error(message.error ?? "Sandbox tool failed."))
      })
    })
    worker.once("error", (error) => settle(() => reject(error)))
    worker.once("exit", (code) => {
      if (code !== 0) settle(() => reject(new Error(`Sandbox worker exited with code ${code}.`)))
    })
  })
}
