import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import process from "node:process"
import { StringDecoder } from "node:string_decoder"
import {
  signalProcessGroup,
  startProcessGroupTermination,
} from "../../child-process-termination.js"
import { MCP_CONFIG } from "../../config.js"
import { prepareShellCommand } from "./rtk.js"

type StopReason = "reset" | "close"
const INTEGER_TEXT_PATTERN = /^-?\d+$/u

export interface ShellRecoverableState {
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface ShellProcessContext {
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface ShellProcessCommandResult {
  status: "completed" | "shell_exited" | "reset"
  exitCode: number | null
  cwd: string
}

interface RunningShellCommand {
  completion: Promise<ShellProcessCommandResult>
}

export interface ShellProcessOptions {
  shellPath: string
  cwd: string
  env: NodeJS.ProcessEnv
  initialState?: ShellRecoverableState
  onIdleOutput: (chunk: string) => void
  onUpdate: () => void
}

export interface ShellProcess {
  readonly shellPath: string
  readonly initialCwd: string
  readonly currentCwd: string
  readonly generation: number
  readonly ready: boolean
  readonly closed: boolean
  readonly hasActiveOperation: boolean
  start(): Promise<void>
  beginCommand(
    command: string,
    cwd: string | undefined,
    onOutput: (chunk: string) => void
  ): Promise<RunningShellCommand>
  captureContext(cwd?: string): Promise<ShellProcessContext>
  captureRecoverableState(): Promise<ShellRecoverableState>
  reset(reason?: string): Promise<number>
  close(): Promise<void>
}

interface ReadyState {
  child: ChildProcessWithoutNullStreams
  marker: string
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ContextCaptureState {
  child: ChildProcessWithoutNullStreams
  startMarker: string
  endMarker: string
  started: boolean
  value: string
  resolve: (context: ShellProcessContext) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ActiveCommandState {
  child: ChildProcessWithoutNullStreams
  markerPrefix: string
  onOutput: (chunk: string) => void
  resolve: (result: ShellProcessCommandResult) => void
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The process controller is a cohesive closure over one child-process state machine; splitting it would widen mutable state ownership.
export function createShellProcess(options: ShellProcessOptions): ShellProcess {
  const shellPath = options.shellPath
  const cwd = options.cwd
  const env = cloneEnvironment(options.env)
  const stopReasons = new WeakMap<ChildProcessWithoutNullStreams, StopReason>()
  const handledChildren = new WeakSet<ChildProcessWithoutNullStreams>()

  let child: ChildProcessWithoutNullStreams | null = null
  let activeCommand: ActiveCommandState | null = null
  let readyState: ReadyState | null = null
  let contextCaptureState: ContextCaptureState | null = null
  let startPromise: Promise<void> | null = null
  let parserBuffer = ""
  let stdoutDecoder = new StringDecoder("utf8")
  let stderrDecoder = new StringDecoder("utf8")
  let generation = 1
  let currentCwd = options.initialState?.cwd ?? cwd
  let initialState = options.initialState ? cloneRecoverableState(options.initialState) : null
  let ready = false
  let closed = false

  async function start(): Promise<void> {
    if (closed) throw new Error("The shell process is closed.")
    if (ready && child) return
    if (startPromise !== null) return startPromise

    startPromise = spawnShell().finally(() => {
      startPromise = null
    })
    return startPromise
  }

  async function beginCommand(
    command: string,
    commandCwd: string | undefined,
    onOutput: (chunk: string) => void
  ): Promise<RunningShellCommand> {
    if (!child || !ready) throw new Error("The shell process is not ready.")
    if (activeCommand || contextCaptureState)
      throw new Error("The shell process already has an active operation.")

    const commandChild = child
    const token = randomUUID().replaceAll("-", "")
    let resolveCompletion!: (result: ShellProcessCommandResult) => void
    const completion = new Promise<ShellProcessCommandResult>((resolve) => {
      resolveCompletion = resolve
    })
    const operation: ActiveCommandState = {
      child: commandChild,
      markerPrefix: `\u001e__MCP_DONE_${token}__:`,
      onOutput,
      resolve: resolveCompletion,
    }
    activeCommand = operation

    try {
      const executionCommand = prepareShellCommand(command, commandCwd ?? currentCwd, env)
      await writeToStdin(commandChild, buildCommandScript(executionCommand, token, commandCwd))
    } catch (error) {
      if (activeCommand === operation) {
        activeCommand = null
        operation.resolve({
          status: stopReasons.get(commandChild) === "reset" ? "reset" : "shell_exited",
          exitCode: null,
          cwd: currentCwd,
        })
        options.onUpdate()
      }
      signalProcessGroup(commandChild, "SIGKILL")
      throw error
    }

    return { completion }
  }

  async function captureContext(captureCwd?: string): Promise<ShellProcessContext> {
    if (!child || !ready) throw new Error("The shell process is not ready.")
    if (activeCommand || contextCaptureState)
      throw new Error("The shell process already has an active operation.")

    const captureChild = child
    const token = randomUUID().replaceAll("-", "")
    const startMarker = `\u001e__MCP_CONTEXT_${token}__\u001f`
    const endMarker = `\u001e__MCP_CONTEXT_END_${token}__\u001f`

    return new Promise<ShellProcessContext>((resolveContext, rejectContext) => {
      const timer = setTimeout(() => {
        if (contextCaptureState?.child === captureChild) contextCaptureState = null
        signalProcessGroup(captureChild, "SIGKILL")
        rejectContext(
          new Error(
            `Shell context capture did not complete within ${MCP_CONFIG.shell.readyTimeoutMs}ms.`
          )
        )
      }, MCP_CONFIG.shell.readyTimeoutMs)
      contextCaptureState = {
        child: captureChild,
        startMarker,
        endMarker,
        started: false,
        value: "",
        resolve: (context) => {
          currentCwd = context.cwd
          resolveContext(context)
        },
        reject: rejectContext,
        timer,
      }
      void writeToStdin(captureChild, buildContextCaptureScript(token, captureCwd)).catch(
        (error) => {
          clearTimeout(timer)
          if (contextCaptureState?.child === captureChild) contextCaptureState = null
          rejectContext(error instanceof Error ? error : new Error(String(error)))
        }
      )
    })
  }

  async function captureRecoverableState(): Promise<ShellRecoverableState> {
    if (activeCommand || contextCaptureState || startPromise)
      throw new Error("The shell process is busy.")
    if (!child || !ready) return cloneRecoverableState(initialState ?? { cwd: currentCwd, env })
    return cloneRecoverableState(await captureContext())
  }

  async function reset(reason?: string): Promise<number> {
    if (closed) throw new Error("The shell process is closed.")
    initialState = null
    currentCwd = cwd

    const currentChild = child
    if (currentChild) {
      stopReasons.set(currentChild, "reset")
      options.onIdleOutput(`\n[mcp] Resetting shell${reason ? `: ${reason}` : ""}\n`)
      await stopChild(currentChild)
    } else {
      generation += 1
      ready = false
      options.onIdleOutput(`\n[mcp] Resetting unavailable shell${reason ? `: ${reason}` : ""}\n`)
      finishActiveCommand("reset", null, currentCwd)
      options.onUpdate()
    }

    await start()
    return generation
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true

    const currentChild = child
    if (currentChild) {
      stopReasons.set(currentChild, "close")
      await stopChild(currentChild)
    }
  }

  async function spawnShell(): Promise<void> {
    parserBuffer = ""
    stdoutDecoder = new StringDecoder("utf8")
    stderrDecoder = new StringDecoder("utf8")
    ready = false

    let restoreState = initialState
    if (restoreState && !isUsableWorkingDirectory(restoreState.cwd)) {
      restoreState = null
      initialState = null
      currentCwd = cwd
    }
    const spawnCwd = restoreState?.cwd ?? cwd
    const spawnEnv = restoreState?.env ?? env
    currentCwd = spawnCwd

    const spawned = spawn("/bin/sh", ["-c", 'exec "$1" -f 2>&1', "mcp-shell", shellPath], {
      cwd: spawnCwd,
      env: spawnEnv,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    child = spawned

    spawned.stdout.on("data", (chunk: Buffer) => {
      if (child !== spawned) return
      handleDecodedOutput(stdoutDecoder.write(chunk))
    })
    spawned.stderr.on("data", (chunk: Buffer) => {
      if (child !== spawned) return
      handleDecodedOutput(stderrDecoder.write(chunk))
    })

    let terminationDescription = "unknown termination"
    let finalizeTimer: NodeJS.Timeout | null = null
    const scheduleForcedFinalization = (description: string) => {
      terminationDescription = description
      if (finalizeTimer) return
      finalizeTimer = setTimeout(
        () => finalizeChild(spawned, terminationDescription),
        MCP_CONFIG.shell.stopGraceMs
      )
    }

    spawned.once("error", (error) => scheduleForcedFinalization(`spawn error: ${error.message}`))
    spawned.once("exit", (code, signal) => {
      scheduleForcedFinalization(signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`)
      if (!stopReasons.has(spawned)) signalProcessGroup(spawned, "SIGKILL")
    })
    spawned.once("close", (code, signal) => {
      if (finalizeTimer) clearTimeout(finalizeTimer)
      const description =
        terminationDescription === "unknown termination"
          ? describeTermination(code, signal)
          : terminationDescription
      finalizeChild(spawned, description)
    })

    const token = randomUUID().replaceAll("-", "")
    const marker = `\u001e__MCP_READY_${token}__\u001f`

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Shell did not become ready within ${MCP_CONFIG.shell.readyTimeoutMs}ms.`))
        signalProcessGroup(spawned, "SIGKILL")
      }, MCP_CONFIG.shell.readyTimeoutMs)

      readyState = { child: spawned, marker, resolve, reject, timer }
      writeToStdin(
        spawned,
        [`builtin printf '\\036__MCP_READY_${token}__\\037'`, ""].join("\n")
      ).catch((error) => {
        clearTimeout(timer)
        readyState = null
        reject(error instanceof Error ? error : new Error(String(error)))
        signalProcessGroup(spawned, "SIGKILL")
      })
    })
    if (initialState === restoreState) initialState = null
  }

  function handleDecodedOutput(chunk: string): void {
    if (chunk.length === 0) return
    parserBuffer += chunk

    while (parserBuffer.length > 0) {
      // Each consumer returns false when it needs another chunk to continue.
      let canContinue: boolean
      if (readyState) {
        canContinue = consumeReadyOutput(readyState)
      } else if (contextCaptureState) {
        canContinue = consumeContextOutput(contextCaptureState)
      } else if (activeCommand) {
        canContinue = consumeCommandOutput(activeCommand)
      } else {
        options.onIdleOutput(parserBuffer)
        parserBuffer = ""
        return
      }
      if (!canContinue) return
    }
  }

  function consumeReadyOutput(state: ReadyState): boolean {
    const markerIndex = parserBuffer.indexOf(state.marker)
    if (markerIndex < 0) {
      flushSafePrefix(state.marker)
      return false
    }

    options.onIdleOutput(parserBuffer.slice(0, markerIndex))
    parserBuffer = parserBuffer.slice(markerIndex + state.marker.length)
    clearTimeout(state.timer)
    readyState = null
    ready = true
    state.resolve()
    options.onUpdate()
    return true
  }

  function consumeContextOutput(context: ContextCaptureState): boolean {
    if (!context.started) {
      const markerIndex = parserBuffer.indexOf(context.startMarker)
      if (markerIndex < 0) {
        flushSafePrefix(context.startMarker)
        return false
      }
      options.onIdleOutput(parserBuffer.slice(0, markerIndex))
      parserBuffer = parserBuffer.slice(markerIndex + context.startMarker.length)
      context.started = true
    }

    const markerIndex = parserBuffer.indexOf(context.endMarker)
    if (markerIndex < 0) {
      flushContextCapturePrefix(context)
      return false
    }

    context.value += parserBuffer.slice(0, markerIndex)
    parserBuffer = parserBuffer.slice(markerIndex + context.endMarker.length)
    clearTimeout(context.timer)
    contextCaptureState = null
    try {
      context.resolve(parseShellContext(context.value))
    } catch (error) {
      context.reject(error instanceof Error ? error : new Error(String(error)))
    }
    options.onUpdate()
    return true
  }

  function consumeCommandOutput(command: ActiveCommandState): boolean {
    const markerIndex = parserBuffer.indexOf(command.markerPrefix)
    if (markerIndex < 0) {
      flushSafePrefix(command.markerPrefix, command.onOutput)
      return false
    }

    const markerEnd = parserBuffer.indexOf("\u001f", markerIndex + command.markerPrefix.length)
    if (markerEnd < 0) {
      command.onOutput(parserBuffer.slice(0, markerIndex))
      parserBuffer = parserBuffer.slice(markerIndex)
      return false
    }

    const markerPayload = parserBuffer.slice(markerIndex + command.markerPrefix.length, markerEnd)
    const cwdSeparator = markerPayload.indexOf("\0")
    const statusText = markerPayload.slice(0, cwdSeparator)
    const parsedCwd = markerPayload.slice(cwdSeparator + 1)
    const parsedStatus = Number.parseInt(statusText, 10)
    if (
      cwdSeparator < 1 ||
      !INTEGER_TEXT_PATTERN.test(statusText) ||
      !Number.isSafeInteger(parsedStatus) ||
      !isAbsolute(parsedCwd)
    ) {
      const falsePrefixEnd = markerIndex + command.markerPrefix.length
      command.onOutput(parserBuffer.slice(0, falsePrefixEnd))
      parserBuffer = parserBuffer.slice(falsePrefixEnd)
      return true
    }

    command.onOutput(parserBuffer.slice(0, markerIndex))
    parserBuffer = parserBuffer.slice(markerEnd + 1)
    currentCwd = parsedCwd
    finishActiveCommand("completed", parsedStatus, parsedCwd)
    options.onUpdate()
    return true
  }

  function flushSafePrefix(marker: string, onOutput?: (chunk: string) => void): void {
    // Retain only a suffix that could become the marker when another chunk arrives.
    let retainedLength = Math.min(parserBuffer.length, marker.length - 1)
    while (retainedLength > 0 && !parserBuffer.endsWith(marker.slice(0, retainedLength))) {
      retainedLength -= 1
    }
    let safeLength = parserBuffer.length - retainedLength
    if (
      safeLength > 0 &&
      safeLength < parserBuffer.length &&
      isHighSurrogate(parserBuffer.charCodeAt(safeLength - 1)) &&
      isLowSurrogate(parserBuffer.charCodeAt(safeLength))
    ) {
      safeLength -= 1
    }
    if (safeLength === 0) return
    const output = parserBuffer.slice(0, safeLength)
    if (onOutput) onOutput(output)
    else options.onIdleOutput(output)
    parserBuffer = parserBuffer.slice(safeLength)
  }

  function flushContextCapturePrefix(context: ContextCaptureState): void {
    let safeLength = Math.max(0, parserBuffer.length - context.endMarker.length + 1)
    if (
      safeLength > 0 &&
      safeLength < parserBuffer.length &&
      isHighSurrogate(parserBuffer.charCodeAt(safeLength - 1)) &&
      isLowSurrogate(parserBuffer.charCodeAt(safeLength))
    ) {
      safeLength -= 1
    }
    if (safeLength === 0) return
    context.value += parserBuffer.slice(0, safeLength)
    parserBuffer = parserBuffer.slice(safeLength)
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Child finalization reconciles all pending process states atomically before optional restart.
  function finalizeChild(
    finalizedChild: ChildProcessWithoutNullStreams,
    description: string
  ): void {
    if (handledChildren.has(finalizedChild)) return
    handledChildren.add(finalizedChild)

    const reason = stopReasons.get(finalizedChild)
    if (child === finalizedChild) {
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      if (stdoutTail) handleDecodedOutput(stdoutTail)
      if (stderrTail) handleDecodedOutput(stderrTail)
      if (parserBuffer) {
        if (activeCommand) activeCommand.onOutput(parserBuffer)
        else options.onIdleOutput(parserBuffer)
        parserBuffer = ""
      }

      finalizedChild.stdout.removeAllListeners()
      finalizedChild.stderr.removeAllListeners()
      finalizedChild.stdout.destroy()
      finalizedChild.stderr.destroy()

      if (readyState?.child === finalizedChild) {
        clearTimeout(readyState.timer)
        readyState.reject(new Error(`Shell exited before becoming ready (${description}).`))
        readyState = null
      }

      if (contextCaptureState?.child === finalizedChild) {
        clearTimeout(contextCaptureState.timer)
        contextCaptureState.reject(
          new Error(`Shell exited during context capture (${description}).`)
        )
        contextCaptureState = null
      }

      finishActiveCommand(reason === "reset" ? "reset" : "shell_exited", null, currentCwd)
      child = null
      ready = false

      if (reason !== "close") {
        generation += 1
        if (reason !== "reset") currentCwd = cwd
        options.onIdleOutput(
          `\n[mcp] Shell state lost (${reason ?? "unexpected"}: ${description}). Starting generation ${generation}.\n`
        )
      }
      options.onUpdate()
    }

    if (!reason) {
      signalProcessGroup(finalizedChild, "SIGKILL")
      if (!closed) {
        queueMicrotask(() => {
          if (closed) return
          void start().catch((error) =>
            options.onIdleOutput(`\n[mcp] Shell restart failed: ${errorMessage(error)}\n`)
          )
        })
      }
    }
  }

  function finishActiveCommand(
    status: ShellProcessCommandResult["status"],
    exitCode: number | null,
    resultCwd: string
  ): void {
    const command = activeCommand
    if (!command) return
    activeCommand = null
    command.resolve({ status, exitCode, cwd: resultCwd })
  }

  async function stopChild(stoppedChild: ChildProcessWithoutNullStreams): Promise<void> {
    const termination = startProcessGroupTermination(stoppedChild, {
      graceMs: MCP_CONFIG.shell.stopGraceMs,
      waitForExit: true,
    })
    await termination.completion
    if (!(await waitForChildClose(stoppedChild, MCP_CONFIG.shell.stopGraceMs)))
      finalizeChild(stoppedChild, "forced shutdown timeout")
  }

  function waitForChildClose(
    waitChild: ChildProcessWithoutNullStreams,
    timeoutMs: number
  ): Promise<boolean> {
    if (handledChildren.has(waitChild)) return Promise.resolve(true)

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waitChild.off("close", onClose)
        resolve(false)
      }, timeoutMs)
      const onClose = () => {
        clearTimeout(timer)
        resolve(true)
      }
      waitChild.once("close", onClose)
    })
  }

  return {
    shellPath,
    initialCwd: cwd,
    get currentCwd() {
      return currentCwd
    },
    get generation() {
      return generation
    },
    get ready() {
      return ready
    },
    get closed() {
      return closed
    },
    get hasActiveOperation() {
      return activeCommand !== null || contextCaptureState !== null || startPromise !== null
    },
    start,
    beginCommand,
    captureContext,
    captureRecoverableState,
    reset,
    close,
  }
}

function describeTermination(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
}

function buildCommandScript(command: string, token: string, cwd?: string): string {
  return [
    "function __mcp_eval_command {",
    '  local __mcp_command="$1"',
    '  if (( $# > 1 )); then builtin cd -- "$2" || return $?; fi',
    '  builtin eval -- "$__mcp_command" </dev/null 1>&1 2>&1',
    "}",
    "set +e",
    `__mcp_eval_command ${singleQuote(command)}${cwd === undefined ? "" : ` ${singleQuote(cwd)}`}`,
    `builtin printf '\\036__MCP_DONE_${token}__:%s\\000%s\\037' "$?" "$PWD"`,
    "unfunction __mcp_eval_command 2>/dev/null",
    "set +e",
    "",
  ].join("\n")
}

function buildContextCaptureScript(token: string, cwd?: string): string {
  const functionName = `__mcp_capture_context_${token}`
  return [
    `function ${functionName} {`,
    '  if (( $# > 0 )); then builtin cd -- "$1" || return $?; fi',
    `  builtin printf '\\036__MCP_CONTEXT_${token}__\\037%s\\000' "$PWD"`,
    "  /usr/bin/env -0",
    `  builtin printf '\\036__MCP_CONTEXT_END_${token}__\\037'`,
    "}",
    "set +e",
    `${functionName}${cwd === undefined ? "" : ` ${singleQuote(cwd)}`}`,
    `unfunction ${functionName} 2>/dev/null`,
    "set +e",
    "",
  ].join("\n")
}

function parseShellContext(value: string): ShellProcessContext {
  const cwdEnd = value.indexOf("\0")
  if (cwdEnd < 1) throw new Error("Shell context did not include a working directory.")
  const cwd = value.slice(0, cwdEnd)
  if (!isAbsolute(cwd))
    throw new Error(`Shell context returned a non-absolute cwd: ${JSON.stringify(cwd)}.`)

  const env: NodeJS.ProcessEnv = {}
  for (const entry of value.slice(cwdEnd + 1).split("\0")) {
    if (entry.length === 0) continue
    const separator = entry.indexOf("=")
    if (separator < 1) continue
    env[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  env.PWD = cwd
  return { cwd, env }
}

function cloneRecoverableState(state: ShellRecoverableState): ShellRecoverableState {
  return { cwd: state.cwd, env: cloneEnvironment(state.env) }
}

function cloneEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env }
}

function isUsableWorkingDirectory(cwd: string): boolean {
  if (!isAbsolute(cwd)) return false
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function writeToStdin(child: ChildProcessWithoutNullStreams, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(value, "utf8", (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}
