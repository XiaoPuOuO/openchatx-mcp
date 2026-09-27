import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import process from "node:process"

const TEST_ROOT = join(process.cwd(), "test")
const TEST_TIMEOUT_MS = Number(process.env.OPENCHATX_TEST_FILE_TIMEOUT_MS ?? 120_000)

async function collectTests(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return collectTests(path)
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : []
    })
  )
  return nested.flat().sort()
}

async function runTestFile(file: string): Promise<void> {
  const display = relative(process.cwd(), file)
  process.stdout.write(`\n[test:ci] START ${display}\n`)

  const child = spawn(process.execPath, ["--import", "tsx", "--test", file], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    process.stderr.write(
      `\n[test:ci] TIMEOUT ${display} after ${Math.round(TEST_TIMEOUT_MS / 1000)}s\n`
    )
    terminateChild(child.pid)
  }, TEST_TIMEOUT_MS)
  timer.unref()

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    }
  )

  clearTimeout(timer)

  if (timedOut) {
    throw new Error(`Test file timed out: ${display}`)
  }
  if (exit.code !== 0) {
    throw new Error(
      `Test file failed: ${display} (code=${String(exit.code)}, signal=${String(exit.signal)})`
    )
  }

  process.stdout.write(`[test:ci] PASS ${display}\n`)
}

function terminateChild(pid: number | undefined): void {
  if (!pid) return

  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGTERM")
      return
    }
    process.kill(-pid, "SIGTERM")
  } catch {
    // The child may have exited between the timeout callback and termination.
  }

  const forceTimer = setTimeout(() => {
    try {
      if (process.platform === "win32") process.kill(pid, "SIGKILL")
      else process.kill(-pid, "SIGKILL")
    } catch {
      // The process group is already gone.
    }
  }, 2_000)
  forceTimer.unref()
}

const tests = await collectTests(TEST_ROOT)
if (tests.length === 0) throw new Error("No test files found.")

process.stdout.write(
  `[test:ci] Running ${tests.length} test files sequentially with ${Math.round(TEST_TIMEOUT_MS / 1000)}s/file timeout\n`
)

for (const file of tests) {
  await runTestFile(file)
}

process.stdout.write(`\n[test:ci] PASS all ${tests.length} test files\n`)
