import { spawnSync } from "node:child_process"
import { basename } from "node:path"
import process from "node:process"

const TRANSIENT_APPLE_SERVICE_PATTERNS = [
  /NSURLErrorDomain Code=-1001/u,
  /NSURLErrorDomain Code=-1005/u,
  /The request timed out/iu,
  /network connection was lost/iu,
  /CloudKit's response is inconsistent/iu,
  /HTTPError\(statusCode: nil/iu,
]

export function isTransientAppleServiceFailure(output: string): boolean {
  return TRANSIENT_APPLE_SERVICE_PATTERNS.some((pattern) => pattern.test(output))
}

export async function runAppleCommandWithRetry(
  executable: string,
  args: string[],
  options: {
    cwd: string
    attempts?: number
    baseDelayMs?: number
  }
): Promise<void> {
  const attempts = options.attempts ?? 5
  const baseDelayMs = options.baseDelayMs ?? 5_000
  let lastFailure = ""

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(executable, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status === 0) return

    lastFailure = `${result.stdout ?? ""}\\n${result.stderr ?? ""}`
    if (!isTransientAppleServiceFailure(lastFailure)) {
      throw commandFailure(executable, result.status, lastFailure)
    }
    if (attempt === attempts) break

    const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000)
    console.warn(
      `Apple service connection failed transiently (attempt ${attempt}/${attempts}); retrying ${basename(executable)} in ${delayMs / 1000}s.`
    )
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  throw commandFailure(executable, 1, lastFailure)
}

function commandFailure(executable: string, status: number | null, output: string): Error {
  const detail = output.trim()
  return new Error(
    `${basename(executable)} failed with exit code ${status ?? 1}${detail ? `: ${detail}` : ""}`
  )
}
