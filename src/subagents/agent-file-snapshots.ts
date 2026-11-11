import { randomUUID } from "node:crypto"
import { readFile, realpath, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import type { AgentFunctionCall } from "./agent-provider.js"

const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_SESSION_SNAPSHOTS = 100
const PATCH_FILE = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gmu

interface FileState {
  exists: boolean
  content: string
}
interface CapturedFile {
  path: string
  before: FileState
}
export interface SnapshotCapture {
  root: string
  jobId: string
  tool: string
  files: CapturedFile[]
}
interface FileChange {
  path: string
  before: FileState
  after: FileState
  diff: string
}
interface SnapshotRecord {
  id: string
  root: string
  jobId: string
  tool: string
  time: string
  applied: boolean
  changes: FileChange[]
}
export interface SubagentFileSnapshot {
  id: string
  tool: string
  time: string
  applied: boolean
  changes: Array<{ path: string; diff: string }>
}

function pathsFromCall(call: AgentFunctionCall): string[] {
  if (call.name === "file_write" || call.name === "file_edit") {
    const path = call.arguments.filePath
    return typeof path === "string" ? [path] : []
  }
  if (call.name === "apply_patch" && typeof call.arguments.patch === "string") {
    return [...call.arguments.patch.matchAll(PATCH_FILE)].map((match) => match[1] ?? "")
  }
  return []
}

function escapesRoot(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

async function scopedPath(root: string, source: string): Promise<string | undefined> {
  if (!source || source.includes("\0")) return undefined
  const path = resolve(root, source)
  const canonicalRoot = await realpath(root).catch(() => undefined)
  if (!canonicalRoot) return undefined
  if (escapesRoot(root, path)) return undefined
  let ancestor = path
  for (;;) {
    try {
      const resolved = await realpath(ancestor)
      if (escapesRoot(canonicalRoot, resolved)) return undefined
      return path
    } catch (error) {
      if ((error instanceof Error && "code" in error ? error.code : undefined) !== "ENOENT")
        return undefined
      const parent = dirname(ancestor)
      if (parent === ancestor) return undefined
      ancestor = parent
    }
  }
}

async function readState(path: string): Promise<FileState | undefined> {
  try {
    const details = await stat(path)
    if (!details.isFile() || details.size > MAX_SNAPSHOT_BYTES) return undefined
    const bytes = await readFile(path)
    if (bytes.includes(0)) return undefined
    return { exists: true, content: bytes.toString("utf8") }
  } catch (error) {
    if ((error instanceof Error && "code" in error ? error.code : undefined) === "ENOENT")
      return { exists: false, content: "" }
    return undefined
  }
}

function fileDiff(before: FileState, after: FileState): string {
  const oldLines = before.content.split("\n")
  const newLines = after.content.split("\n")
  let prefix = 0
  while (
    prefix < Math.min(oldLines.length, newLines.length) &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix += 1
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  return [
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ]
    .join("\n")
    .slice(0, 40_000)
}

/** Session-scoped snapshots of explicit file-edit tool calls, not shell commands. */
export class SubagentFileSnapshots {
  private readonly history = new Map<string, SnapshotRecord[]>()

  async capture(
    jobId: string,
    root: string | undefined,
    call: AgentFunctionCall
  ): Promise<SnapshotCapture | undefined> {
    if (!root) return undefined
    const files: CapturedFile[] = []
    for (const source of new Set(pathsFromCall(call))) {
      const path = await scopedPath(root, source)
      if (!path) continue
      const before = await readState(path)
      if (before) files.push({ path, before })
    }
    return files.length ? { root, jobId, tool: call.name, files } : undefined
  }

  async complete(capture: SnapshotCapture | undefined): Promise<void> {
    if (!capture) return
    const changes: FileChange[] = []
    for (const { path, before } of capture.files) {
      const after = await readState(path)
      if (!after || (before.exists === after.exists && before.content === after.content)) continue
      changes.push({ path, before, after, diff: fileDiff(before, after) })
    }
    if (!changes.length) return
    const records = this.history.get(capture.jobId) ?? []
    records.push({
      id: randomUUID(),
      root: capture.root,
      jobId: capture.jobId,
      tool: capture.tool,
      time: new Date().toISOString(),
      applied: true,
      changes,
    })
    if (records.length > MAX_SESSION_SNAPSHOTS) records.shift()
    this.history.set(capture.jobId, records)
  }

  list(jobId: string): SubagentFileSnapshot[] {
    return (this.history.get(jobId) ?? []).map(({ id, tool, time, applied, changes }) => ({
      id,
      tool,
      time,
      applied,
      changes: changes.map(({ path, diff }) => ({ path, diff })),
    }))
  }

  async restore(
    jobId: string,
    id: string,
    operation: "undo" | "redo"
  ): Promise<SubagentFileSnapshot> {
    const record = this.history.get(jobId)?.find((item) => item.id === id)
    if (!record) throw new Error("Unknown file snapshot.")
    if ((operation === "undo") !== record.applied)
      throw new Error("This snapshot is already in the requested state.")
    // Verify every file before writing any. Never overwrite newer user or agent edits.
    for (const change of record.changes) {
      if ((await scopedPath(record.root, change.path)) !== change.path)
        throw new Error(`Cannot ${operation}: ${change.path} is outside the project.`)
      const current = await readState(change.path)
      const expected = operation === "undo" ? change.after : change.before
      if (!current || current.exists !== expected.exists || current.content !== expected.content)
        throw new Error(`Cannot ${operation}: ${change.path} has changed since this snapshot.`)
    }
    for (const change of record.changes) {
      const target = operation === "undo" ? change.before : change.after
      if (target.exists) await writeFile(change.path, target.content, "utf8")
      else await unlink(change.path)
    }
    record.applied = operation === "redo"
    const snapshot = this.list(jobId).find((item) => item.id === id)
    if (!snapshot) throw new Error("Snapshot not found after restoration.")
    return snapshot
  }

  delete(jobId: string): void {
    this.history.delete(jobId)
  }
}
