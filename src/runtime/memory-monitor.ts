import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const INTERVAL_MS = 60_000
const MAX_LOG_BYTES = 512 * 1024
const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u

export interface ProcessMemorySample {
  pid: number
  ppid: number
  rssKiB: number
  command: string
}

export function selectProcessTree(
  rows: ProcessMemorySample[],
  rootPid: number
): ProcessMemorySample[] {
  const included = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (included.has(row.ppid) && !included.has(row.pid)) {
        included.add(row.pid)
        changed = true
      }
    }
  }
  return rows.filter((row) => included.has(row.pid))
}

export function parseProcessMemory(output: string): ProcessMemorySample[] {
  return output.split("\n").flatMap((line) => {
    const match = PROCESS_ROW.exec(line)
    if (!match) return []
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKiB: Number(match[3]),
        command: match[4] ?? "unknown",
      },
    ]
  })
}

/** Persistent, bounded diagnostics; never logs process command arguments or tool payloads. */
export function startMemoryMonitor(stateDir: string): () => void {
  const logPath = join(stateDir, "diagnostics", "memory.jsonl")
  let busy = false
  const sample = async () => {
    if (busy) return
    busy = true
    try {
      const memory = process.memoryUsage()
      let processes: ProcessMemorySample[] = []
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="], {
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
        })
        processes = selectProcessTree(parseProcessMemory(stdout), process.pid)
      }
      const record = {
        at: new Date().toISOString(),
        rootPid: process.pid,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        rss: memory.rss,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        childRssKiB: processes
          .filter((row) => row.pid !== process.pid)
          .reduce((sum, row) => sum + row.rssKiB, 0),
        processes,
      }
      await mkdir(join(stateDir, "diagnostics"), { recursive: true })
      const line = `${JSON.stringify(record)}\n`
      await appendFile(logPath, line, { mode: 0o600 })
      const content = await readFile(logPath)
      if (content.length > MAX_LOG_BYTES) {
        const last = content.subarray(content.length - MAX_LOG_BYTES)
        const newline = last.indexOf(10)
        await writeFile(logPath, last.subarray(newline + 1), { mode: 0o600 })
      }
    } catch {
      // Diagnostics must never interrupt the runtime.
    } finally {
      busy = false
    }
  }
  void sample()
  const timer = setInterval(() => void sample(), INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
