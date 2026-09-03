import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { AgentIdentity } from "../../server/agent-context.js"

export interface PersistedSubagent {
  conversationUrl: string
  turnCount: number
  kind: "subagent" | "clone"
}

export interface SubagentStore {
  get(parentAgent: AgentIdentity | undefined, agentId: string): PersistedSubagent | undefined
  set(parentAgent: AgentIdentity | undefined, agentId: string, value: PersistedSubagent): void
  close(): void
}

export function subagentDatabasePath(): string {
  return join(homedir(), ".shellby", "subagents.sqlite")
}

export function createSubagentStore(path = subagentDatabasePath()): SubagentStore | undefined {
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
    const get = db.prepare("SELECT conversation_url, turn_count, kind FROM agents WHERE parent_session_id = ? AND agent_id = ?")
    const set = db.prepare(`
      INSERT INTO agents (parent_session_id, agent_id, conversation_url, turn_count, kind)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET
        conversation_url = excluded.conversation_url,
        turn_count = excluded.turn_count,
        kind = excluded.kind
    `)

    return {
      get(parentAgent, agentId) {
        try {
          const row = get.get(parentAgent?.sessionId ?? "", agentId) as { conversation_url?: unknown; turn_count?: unknown; kind?: unknown } | undefined
          if (!row || typeof row.conversation_url !== "string" || typeof row.turn_count !== "number") return undefined
          return {
            conversationUrl: row.conversation_url,
            turnCount: row.turn_count,
            kind: row.kind === "clone" ? "clone" : "subagent",
          }
        } catch {
          return undefined
        }
      },
      set(parentAgent, agentId, value) {
        try {
          set.run(parentAgent?.sessionId ?? "", agentId, value.conversationUrl, value.turnCount, value.kind)
        } catch {
          // Persistence is best effort. Runtime behavior should continue normally.
        }
      },
      close() {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      },
    }
  } catch {
    return undefined
  }
}
