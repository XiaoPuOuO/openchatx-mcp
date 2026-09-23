import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { AgentIdentity } from "../../agent/context.js"
import { asRecord } from "../../utils.js"

interface PersistedDelegatedAgent {
  conversationUrl: string
  turnCount: number
  kind: "subagent" | "clone"
}

interface PersistedDelegatedAgentEntry extends PersistedDelegatedAgent {
  agentId: string
}

export type DelegationStoreFailureOperation = "initialize" | "read" | "write"

export class DelegationStoreError extends Error {
  constructor(
    readonly operation: DelegationStoreFailureOperation,
    readonly path: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "DelegationStoreError"
  }
}

export interface DelegationStore {
  readonly status: "available" | "unavailable"
  readonly failure?: DelegationStoreError
  get(parentAgent: AgentIdentity | undefined, agentId: string): PersistedDelegatedAgent | undefined
  list(parentAgent: AgentIdentity | undefined): PersistedDelegatedAgentEntry[]
  set(parentAgent: AgentIdentity | undefined, agentId: string, value: PersistedDelegatedAgent): void
  close(): void
}

export function createDelegationStore(path: string): DelegationStore {
  let failure: DelegationStoreError | undefined

  const markFailed = (
    operation: DelegationStoreFailureOperation,
    error: unknown
  ): DelegationStoreError => {
    if (failure) return failure
    const detail = error instanceof Error ? error.message : String(error)
    failure = new DelegationStoreError(
      operation,
      path,
      `Subagent persistence ${operation} failed for ${path}: ${detail}`,
      { cause: error }
    )
    console.warn(failure.message)
    return failure
  }

  const unavailableStore = (error: unknown): DelegationStore => {
    const initialFailure = markFailed("initialize", error)
    return {
      get status() {
        return "unavailable" as const
      },
      get failure() {
        return initialFailure
      },
      get() {
        throw initialFailure
      },
      list() {
        throw initialFailure
      },
      set() {
        throw initialFailure
      },
      close() {
        // No database handle was opened.
      },
    }
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        parent_session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_url TEXT NOT NULL,
        turn_count INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'subagent',
        PRIMARY KEY (parent_session_id, agent_id)
      )
    `)
    const get = db.prepare(
      "SELECT conversation_url, turn_count, kind FROM agents WHERE parent_session_id = ? AND agent_id = ?"
    )
    const list = db.prepare(
      "SELECT agent_id, conversation_url, turn_count, kind FROM agents WHERE parent_session_id = ? ORDER BY agent_id"
    )
    const set = db.prepare(`
      INSERT INTO agents (parent_session_id, agent_id, conversation_url, turn_count, kind)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET
        conversation_url = excluded.conversation_url,
        turn_count = excluded.turn_count,
        kind = excluded.kind
    `)

    return {
      get status() {
        return failure ? "unavailable" : "available"
      },
      get failure() {
        return failure
      },
      get(parentAgent, agentId) {
        if (failure) throw failure
        try {
          const row = asRecord(get.get(parentAgent?.sessionId ?? "", agentId))
          if (!row) return
          if (typeof row.conversation_url !== "string" || typeof row.turn_count !== "number") {
            throw new Error("Stored subagent row has an invalid shape.")
          }
          return {
            conversationUrl: row.conversation_url,
            turnCount: row.turn_count,
            kind: row.kind === "clone" ? "clone" : "subagent",
          }
        } catch (error) {
          throw markFailed("read", error)
        }
      },
      list(parentAgent) {
        if (failure) throw failure
        try {
          const rows = list.all(parentAgent?.sessionId ?? "")
          return rows.map((rawRow) => {
            const row = asRecord(rawRow)
            if (!row) throw new Error("Stored subagent row is not an object.")
            if (
              typeof row.agent_id !== "string" ||
              typeof row.conversation_url !== "string" ||
              typeof row.turn_count !== "number"
            )
              throw new Error("Stored subagent row has an invalid shape.")
            return {
              agentId: row.agent_id,
              conversationUrl: row.conversation_url,
              turnCount: row.turn_count,
              kind: row.kind === "clone" ? "clone" : "subagent",
            } satisfies PersistedDelegatedAgentEntry
          })
        } catch (error) {
          throw markFailed("read", error)
        }
      },
      set(parentAgent, agentId, value) {
        if (failure) throw failure
        try {
          set.run(
            parentAgent?.sessionId ?? "",
            agentId,
            value.conversationUrl,
            value.turnCount,
            value.kind
          )
        } catch (error) {
          throw markFailed("write", error)
        }
      },
      close() {
        try {
          db.close()
        } catch (error) {
          console.warn(`Could not close subagent persistence at ${path}: ${String(error)}`)
        }
      },
    }
  } catch (error) {
    return unavailableStore(error)
  }
}
