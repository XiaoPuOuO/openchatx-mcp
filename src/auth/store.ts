import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"

import { isRecord } from "../utils.js"

const AUTH_STATE_VERSION = 1

export interface OpenChatXAuthState {
  version: typeof AUTH_STATE_VERSION
  subject: string | null
}

export type OpenChatXAuthErrorCode =
  | "state_missing"
  | "state_invalid"
  | "subject_missing"
  | "subject_mismatch"

export class OpenChatXAuthError extends Error {
  constructor(
    readonly code: OpenChatXAuthErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "OpenChatXAuthError"
  }
}

export class OpenChatXAuthStore {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string) {}

  async ensureState(): Promise<OpenChatXAuthState> {
    return this.withMutation(async () => {
      try {
        return await this.readState()
      } catch (error) {
        if (!(error instanceof OpenChatXAuthError) || error.code !== "state_missing") throw error
      }

      const state: OpenChatXAuthState = { version: AUTH_STATE_VERSION, subject: null }
      await ensurePrivateDirectory(dirname(this.filePath))
      try {
        await writeFile(this.filePath, serializeState(state), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        })
        await chmod(this.filePath, 0o600)
        return state
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error
        return this.readState()
      }
    })
  }

  async readState(): Promise<OpenChatXAuthState> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        // biome-ignore lint/style/useErrorCause: OpenChatXAuthError accepts ErrorOptions as its third argument and forwards the cause to Error.
        throw new OpenChatXAuthError(
          "state_missing",
          "openchatx-mcp authentication state is missing.",
          {
            cause: error,
          }
        )
      }
      throw error
    }

    const state = parseState(raw)
    await ensurePrivateDirectory(dirname(this.filePath))
    await chmod(this.filePath, 0o600)
    return state
  }

  async authorizeToolCall(subject: string | undefined): Promise<OpenChatXAuthState> {
    if (!isValidSubject(subject)) {
      throw new OpenChatXAuthError(
        "subject_missing",
        "OpenAI subject is required for remote tool calls."
      )
    }

    return this.withMutation(async () => {
      const state = await this.readState()
      if (state.subject === null) {
        const boundState: OpenChatXAuthState = { ...state, subject }
        await writeStateAtomically(this.filePath, boundState)
        return boundState
      }
      if (state.subject !== subject) {
        throw new OpenChatXAuthError(
          "subject_mismatch",
          "This openchatx-mcp installation is bound to a different ChatGPT user."
        )
      }
      return state
    })
  }

  async reset(): Promise<OpenChatXAuthState> {
    return this.withMutation(async () => {
      const state: OpenChatXAuthState = { version: AUTH_STATE_VERSION, subject: null }
      await writeStateAtomically(this.filePath, state)
      return state
    })
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function parseState(raw: string): OpenChatXAuthState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw invalidState("openchatx-mcp authentication state is malformed.", error)
  }

  if (!isRecord(parsed)) {
    throw invalidState("openchatx-mcp authentication state must be an object.")
  }
  const state = parsed
  if (state.version !== AUTH_STATE_VERSION) {
    throw invalidState("openchatx-mcp authentication state version is unsupported.")
  }
  const subject = state.subject
  if (subject !== null && !isValidSubject(subject)) {
    throw invalidState("openchatx-mcp authentication subject is invalid.")
  }
  return { version: AUTH_STATE_VERSION, subject }
}

async function writeStateAtomically(filePath: string, state: OpenChatXAuthState): Promise<void> {
  const directory = dirname(filePath)
  await ensurePrivateDirectory(directory)
  const temporaryPath = join(directory, `.auth-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(temporaryPath, serializeState(state), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

function serializeState(state: OpenChatXAuthState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isValidSubject(subject: unknown): subject is string {
  return typeof subject === "string" && subject.length > 0 && subject.length <= 512
}

function invalidState(message: string, cause?: unknown): OpenChatXAuthError {
  return new OpenChatXAuthError(
    "state_invalid",
    message,
    cause === undefined ? undefined : { cause }
  )
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
