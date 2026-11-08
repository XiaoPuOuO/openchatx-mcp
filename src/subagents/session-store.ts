import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { z } from "zod"

import type { AgentMessage } from "./agent-provider.js"
import type { SubagentEvent } from "./agent-sessions.js"
import type { SubagentRunResult } from "./runtime.js"

/** Session metadata, separate from the ordered model-message and UI-event records. */
export interface SessionRecord {
  job_id: string
  session_id: string
  profile: string
  provider: string
  model: string
  title: string
  parent_id?: string
  root_owner: string
  owner: string
  ownerAgentId?: string
  projectId?: string
  projectRouting?: "pending" | "project" | "unscoped"
  projectExternalAccessAll?: boolean
  depth: number
  status: "running" | "completed" | "failed"
  created_at: string
  updated_at: string
  pending_guidance: number
  bootstrapped: boolean
  notified: boolean
  result?: SubagentRunResult
  error?: string
}

const resultSchema: z.ZodType<SubagentRunResult> = z.object({
  profile: z.string(),
  provider: z.string(),
  model: z.string(),
  content: z.string(),
  usage: z.record(z.string(), z.unknown()).optional(),
})

const sessionSchema: z.ZodType<SessionRecord> = z.object({
  job_id: z.string(),
  session_id: z.string(),
  profile: z.string(),
  provider: z.string(),
  model: z.string(),
  title: z.string(),
  parent_id: z.string().optional(),
  root_owner: z.string(),
  owner: z.string(),
  ownerAgentId: z.string().optional(),
  projectId: z.string().optional(),
  projectRouting: z.enum(["pending", "project", "unscoped"]).optional(),
  projectExternalAccessAll: z.boolean().optional(),
  depth: z.number().int(),
  status: z.enum(["running", "completed", "failed"]),
  created_at: z.string(),
  updated_at: z.string(),
  pending_guidance: z.number().int(),
  bootstrapped: z.boolean(),
  notified: z.boolean(),
  result: resultSchema.optional(),
  error: z.string().optional(),
})

const messageSchema: z.ZodType<AgentMessage> = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  calls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
      })
    )
    .optional(),
  callId: z.string().optional(),
  name: z.string().optional(),
  rawOutput: z.array(z.unknown()).optional(),
})

const eventSchema: z.ZodType<SubagentEvent> = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool", "guidance"]),
  text: z.string(),
  time: z.string(),
  status: z.enum(["running", "completed", "failed", "queued", "delivered"]).optional(),
  tool: z.string().optional(),
  input: z.string().optional(),
})

const CREATE_TABLES = `
PRAGMA foreign_keys = ON;
CREATE TABLE session (
  job_id TEXT PRIMARY KEY,
  root_owner TEXT NOT NULL,
  parent_id TEXT REFERENCES session(job_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX session_owner ON session(root_owner);
CREATE TABLE message (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES session(job_id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE INDEX message_job ON message(job_id, seq);
CREATE TABLE event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  job_id TEXT NOT NULL REFERENCES session(job_id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE INDEX event_job ON event(job_id, seq);
`

/**
 * OpenCode-inspired SQLite storage: session -> messages + tool/UI events.
 * The parent ChatGPT runtime does not survive an app restart, so its dependent
 * sessions cannot be safely resumed; this database is reset on startup/close.
 */
export class SubagentSessionStore {
  private readonly db: DatabaseSync

  constructor(private readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(`${filename}${suffix}`, { force: true })
    this.db = new DatabaseSync(filename)
    chmodSync(filename, 0o600)
    this.db.exec("PRAGMA auto_vacuum = FULL")
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec(CREATE_TABLES)
  }

  create(session: SessionRecord, messages: AgentMessage[]): void {
    const writeSession = this.db.prepare(
      "INSERT INTO session(job_id,root_owner,parent_id,status,updated_at,data) VALUES(?,?,?,?,?,?)"
    )
    const writeMessage = this.db.prepare("INSERT INTO message(job_id,data) VALUES(?,?)")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      writeSession.run(
        session.job_id,
        session.root_owner,
        session.parent_id ?? null,
        session.status,
        session.updated_at,
        serializeSession(session)
      )
      for (const message of messages) writeMessage.run(session.job_id, JSON.stringify(message))
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  save(session: SessionRecord): void {
    this.db
      .prepare("UPDATE session SET status=?,updated_at=?,data=? WHERE job_id=?")
      .run(session.status, session.updated_at, serializeSession(session), session.job_id)
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT data FROM session WHERE job_id=?").get(id)
    const data = parseData(row)
    return data === undefined ? undefined : sessionSchema.parse(data)
  }

  list(): SessionRecord[] {
    return this.db
      .prepare("SELECT data FROM session ORDER BY updated_at DESC")
      .all()
      .map((row) => sessionSchema.parse(parseData(row)))
  }

  messages(id: string): AgentMessage[] {
    return this.db
      .prepare("SELECT data FROM message WHERE job_id=? ORDER BY seq")
      .all(id)
      .map((row) => messageSchema.parse(parseData(row)))
  }

  appendMessage(id: string, message: AgentMessage): void {
    this.db.prepare("INSERT INTO message(job_id,data) VALUES(?,?)").run(id, JSON.stringify(message))
  }

  replaceFirstMessage(id: string, message: AgentMessage): void {
    this.db
      .prepare(
        "UPDATE message SET data=? WHERE seq=(SELECT seq FROM message WHERE job_id=? ORDER BY seq LIMIT 1)"
      )
      .run(JSON.stringify(message), id)
  }

  countDirectChildren(parentId: string | undefined, rootOwner: string): number {
    const row = parentId
      ? this.db.prepare("SELECT COUNT(*) AS total FROM session WHERE parent_id=?").get(parentId)
      : this.db
          .prepare("SELECT COUNT(*) AS total FROM session WHERE parent_id IS NULL AND root_owner=?")
          .get(rootOwner)
    return Number(row?.total ?? 0)
  }

  subtreeIds(id: string): string[] {
    const rows = this.db
      .prepare(
        "WITH RECURSIVE descendants(id) AS (SELECT job_id FROM session WHERE job_id=? UNION ALL SELECT s.job_id FROM session s JOIN descendants d ON s.parent_id=d.id) SELECT id FROM descendants"
      )
      .all(id)
    return rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []))
  }

  deleteSubtree(id: string): string[] {
    const ids = this.subtreeIds(id)
    if (!ids.length) return []
    this.db.prepare("DELETE FROM session WHERE job_id=?").run(id)
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    return ids
  }

  events(id: string): SubagentEvent[] {
    return this.db
      .prepare("SELECT data FROM event WHERE job_id=? ORDER BY seq")
      .all(id)
      .map((row) => eventSchema.parse(parseData(row)))
  }

  addEvent(jobId: string, event: SubagentEvent): void {
    this.db
      .prepare("INSERT INTO event(id,job_id,data) VALUES(?,?,?)")
      .run(event.id, jobId, JSON.stringify(event))
  }

  updateEvent(event: SubagentEvent): void {
    this.db.prepare("UPDATE event SET data=? WHERE id=?").run(JSON.stringify(event), event.id)
  }

  event(id: string): SubagentEvent | undefined {
    const data = parseData(this.db.prepare("SELECT data FROM event WHERE id=?").get(id))
    return data === undefined ? undefined : eventSchema.parse(data)
  }

  deleteOwner(ownerId: string): string[] {
    const rows = this.db.prepare("SELECT job_id FROM session WHERE root_owner=?").all(ownerId)
    const ids = rows.flatMap((row) => (typeof row.job_id === "string" ? [row.job_id] : []))
    if (!ids.length) return []
    this.db.prepare("DELETE FROM session WHERE root_owner=?").run(ownerId)
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    return ids
  }

  dispose(): void {
    this.db.close()
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(`${this.filename}${suffix}`, { force: true })
  }
}

function parseData(row: Record<string, unknown> | undefined): unknown {
  if (row === undefined) return undefined
  if (typeof row.data !== "string") throw new Error("Invalid stored Subagent row.")
  return JSON.parse(row.data)
}

/** Never serialize the active Agent's in-memory messages/controller in session metadata. */
function serializeSession(item: SessionRecord): string {
  const {
    job_id,
    session_id,
    profile,
    provider,
    model,
    title,
    parent_id,
    root_owner,
    owner,
    ownerAgentId,
    projectId,
    projectRouting,
    projectExternalAccessAll,
    depth,
    status,
    created_at,
    updated_at,
    pending_guidance,
    bootstrapped,
    notified,
    result,
    error,
  } = item
  return JSON.stringify({
    job_id,
    session_id,
    profile,
    provider,
    model,
    title,
    parent_id,
    root_owner,
    owner,
    ownerAgentId,
    projectId,
    projectRouting,
    projectExternalAccessAll,
    depth,
    status,
    created_at,
    updated_at,
    pending_guidance,
    bootstrapped,
    notified,
    result,
    error,
  })
}
