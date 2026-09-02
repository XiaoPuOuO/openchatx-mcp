import assert from "node:assert/strict"
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { PeekabooClient, PeekabooError } from "../src/tools/computer/peekaboo.js"

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-peekaboo.mjs")

test("accepts an explicit Peekaboo executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-discovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const explicitLog = join(root, "explicit.jsonl")
  const explicitExecutable = await copyFixture(root, "explicit-peekaboo")

  const explicit = new PeekabooClient({
    executable: explicitExecutable,
    env: {
      ...process.env,
      FAKE_PEEKABOO_LOG: explicitLog,
    },
    timeoutMs: 2_000,
  })
  t.after(() => explicit.close())
  await explicit.run(["list", "screens"])

  assert.deepEqual(startEvents(await readLog(explicitLog))[0]?.args, ["list", "screens", "--json"])
})

test("can force Peekaboo operations to the local runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-local-only-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const client = fakeClient({ FAKE_PEEKABOO_LOG: logPath }, { localOnly: true })
  t.after(() => client.close())

  await client.run(["window", "focus", "--window-id", "42"])
  await client.run(["click", "--at", "10,20", "--no-remote"])

  const starts = startEvents(await readLog(logPath))
  assert.deepEqual(starts[0]?.args, ["window", "focus", "--window-id", "42", "--no-remote", "--json"])
  assert.deepEqual(starts[1]?.args, ["click", "--at", "10,20", "--no-remote", "--json"])
})

test("reports a missing Peekaboo executable", async (t) => {
  const client = new PeekabooClient({
    executable: join(tmpdir(), `peekaboo-not-installed-${process.pid}`),
    timeoutMs: 2_000,
  })
  t.after(() => client.close())

  const error = await peekabooRejection(client.run(["app", "list"]))
  assert.equal(error.code, "PEEKABOO_NOT_FOUND")
  assert.match(error.message, /Run npm install/)
})

test("passes literal values as exact argv without invoking a shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-argv-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const markerPath = join(root, "must-not-exist")
  const client = fakeClient({ FAKE_PEEKABOO_LOG: logPath })
  t.after(() => client.close())
  const app = `Text Editor ' quoted " app`
  const text = `--literal $() \`ticks\` 'quotes' "double"\n$(touch ${markerPath})`

  await client.run(["type", "--text", text, "--app", app])

  const event = startEvents(await readLog(logPath))[0]
  assert.deepEqual(event?.args, ["type", "--text", text, "--app", app, "--json"])
  await assert.rejects(access(markerPath))
})

test("parses success data while dropping debug logs and non-string messages", async (t) => {
  const client = fakeClient({})
  t.after(() => client.close())

  const result = await client.run(["list", "apps"])

  assert.deepEqual(result, {
    data: {
      command: "list",
      args: ["list", "apps", "--json"],
    },
    summary: "list:ok",
    messages: ["ready"],
  })
  assert.equal("debug_logs" in result, false)
})

test("uses the JSON success field even when Peekaboo exits zero", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-semantic-error-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const client = fakeClient({
    FAKE_PEEKABOO_LOG: logPath,
    FAKE_PEEKABOO_FAIL_COMMAND: "click",
  })
  t.after(() => client.close())

  const error = await peekabooRejection(client.run(["click", "--on", "B1", "--snapshot", "snapshot-42"]))
  assert.equal(error.code, "FAKE_COMMAND_FAILED")
  assert.equal(error.message, "Fake Peekaboo failure for click")
  assert.equal(error.details, "fixture requested failure")

  await client.run(["list", "apps"])
  const starts = startEvents(await readLog(logPath))
  assert.equal(starts.filter((event) => event.command === "click").length, 1)
  assert.equal(starts.filter((event) => event.command === "list").length, 1)
})

test("reports malformed JSON and process failures clearly", async (t) => {
  const malformed = fakeClient({ FAKE_PEEKABOO_MALFORMED_JSON: "1" })
  t.after(() => malformed.close())
  const malformedError = await peekabooRejection(malformed.run(["list", "apps"]))
  assert.equal(malformedError.code, "PEEKABOO_INVALID_JSON")
  assert.equal(malformedError.details, "not-json")

  const failed = fakeClient({ FAKE_PEEKABOO_EXIT_CODE: "7" })
  t.after(() => failed.close())
  const processError = await peekabooRejection(failed.run(["list", "apps"]))
  assert.equal(processError.code, "PEEKABOO_PROCESS_FAILED")
  assert.equal(processError.details, "fake process failure")
})

test("bounds oversized stdout and stderr", async (t) => {
  const stdoutClient = fakeClient({ FAKE_PEEKABOO_STDOUT_BYTES: "4096" }, { maxOutputBytes: 256 })
  t.after(() => stdoutClient.close())
  const stdoutError = await peekabooRejection(stdoutClient.run(["list", "apps"]))
  assert.equal(stdoutError.code, "PEEKABOO_PROCESS_FAILED")
  assert.ok(stdoutError.message.length < 1_000)

  const stderrClient = fakeClient({ FAKE_PEEKABOO_STDERR_BYTES: "4096" }, { maxOutputBytes: 256 })
  t.after(() => stderrClient.close())
  const stderrError = await peekabooRejection(stderrClient.run(["list", "apps"]))
  assert.equal(stderrError.code, "PEEKABOO_PROCESS_FAILED")
  assert.ok((stderrError.details?.length ?? 0) <= 4_096)
})

test("serializes CLI operations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-serial-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const client = fakeClient({
    FAKE_PEEKABOO_LOG: logPath,
    FAKE_PEEKABOO_DELAY_MS: "30",
  })
  t.after(() => client.close())

  await Promise.all([client.run(["first"]), client.run(["second"])])

  assert.deepEqual(
    (await readLog(logPath)).map((event) => `${event.event}:${event.command}`),
    ["start:first", "end:first", "start:second", "end:second"]
  )
})

test("does not launch an aborted operation waiting in the queue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-queued-abort-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const client = fakeClient({
    FAKE_PEEKABOO_LOG: logPath,
    FAKE_PEEKABOO_DELAY_MS: "40",
  })
  t.after(() => client.close())
  const controller = new AbortController()

  const first = client.run(["first"])
  const second = client.run(["second"], controller.signal)
  controller.abort()

  await first
  await assert.rejects(second, { name: "AbortError" })
  assert.deepEqual(
    startEvents(await readLog(logPath)).map((event) => event.command),
    ["first"]
  )
})

test("times out one invocation without retrying it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-timeout-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const client = fakeClient(
    {
      FAKE_PEEKABOO_LOG: logPath,
      FAKE_PEEKABOO_DELAY_MS: "2000",
    },
    { timeoutMs: 300 }
  )
  t.after(() => client.close())

  const error = await peekabooRejection(client.run(["click", "--coords", "1,2"]))
  assert.equal(error.code, "PEEKABOO_PROCESS_FAILED")

  if (!process.env.CI) {
    const events = await readLog(logPath)
    assert.equal(startEvents(events).length, 1)
    assert.equal(events.filter((event) => event.event === "signal").length, 1)
  }
})

test("returns screenshot bytes and removes observation artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-observe-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const client = fakeClient({ FAKE_PEEKABOO_LOG: logPath })
  t.after(() => client.close())

  const result = await client.observe(["--app", "Finder"], { annotate: true })

  assert.equal(result.mimeType, "image/jpeg")
  assert.equal(Buffer.from(result.imageData, "base64").subarray(0, 3).toString("hex"), "ffd8ff")
  assert.equal((result.data as { snapshot_id?: string }).snapshot_id, "snapshot-42")
  assert.deepEqual(result.messages, ["ready"])
  assert.deepEqual(result.target, {
    kind: "window-id",
    windowId: 4242,
    bounds: { x: 50, y: 75, width: 800, height: 600 },
  })
  assert.deepEqual(client.getSnapshotTarget("snapshot-42"), result.target)

  const args = startEvents(await readLog(logPath))[0]?.args ?? []
  const pathIndex = args.indexOf("--path")
  assert.ok(pathIndex >= 0)
  const screenshotPath = args[pathIndex + 1]
  assert.ok(screenshotPath)
  assert.deepEqual(args.slice(0, 3), ["see", "--app", "Finder"])
  assert.deepEqual(args.slice(-2), ["--annotate", "--json"])
  await assert.rejects(access(screenshotPath))
})

test("preserves an exact requested app selector for later snapshot actions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-observe-target-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const client = fakeClient({
    FAKE_PEEKABOO_LOG: logPath,
    FAKE_PEEKABOO_APP_NAME: "Google Chrome",
    FAKE_PEEKABOO_OMIT_OBSERVATION_TARGET: "1",
  })
  t.after(() => client.close())

  const result = await client.observe(["--app", "PID:95973"], { annotate: false })

  assert.deepEqual(result.target, {
    app: "PID:95973",
  })
  assert.deepEqual(client.getSnapshotTarget("snapshot-42"), result.target)
})

test("removes observation artifacts after a Peekaboo error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peekaboo-observe-error-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, "calls.jsonl")
  const client = fakeClient({
    FAKE_PEEKABOO_LOG: logPath,
    FAKE_PEEKABOO_FAIL_COMMAND: "see",
  })
  t.after(() => client.close())

  const error = await peekabooRejection(client.observe(["--app", "Finder"], { annotate: false }))
  assert.equal(error.code, "FAKE_COMMAND_FAILED")

  const args = startEvents(await readLog(logPath))[0]?.args ?? []
  const screenshotPath = args[args.indexOf("--path") + 1]
  assert.ok(screenshotPath)
  await assert.rejects(access(screenshotPath))
})

interface FakeEvent {
  event: "start" | "end" | "signal"
  command: string
  args: string[]
  pid: number
  signal?: string
}

function fakeClient(env: Record<string, string>, options: { timeoutMs?: number; maxOutputBytes?: number; localOnly?: boolean } = {}): PeekabooClient {
  return new PeekabooClient({
    executable: process.execPath,
    baseArgs: [fixture],
    env: { ...process.env, ...env },
    timeoutMs: options.timeoutMs ?? 2_000,
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
    localOnly: options.localOnly,
  })
}

async function copyFixture(root: string, name: string): Promise<string> {
  const executable = join(root, name)
  await writeFile(executable, await readFile(fixture))
  await chmod(executable, 0o755)
  return executable
}

async function readLog(path: string): Promise<FakeEvent[]> {
  const value = await readFile(path, "utf8")
  return value
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeEvent)
}

function startEvents(events: FakeEvent[]): FakeEvent[] {
  return events.filter((event) => event.event === "start")
}

async function peekabooRejection(promise: Promise<unknown>): Promise<PeekabooError> {
  let rejected: unknown
  try {
    await promise
  } catch (error) {
    rejected = error
  }
  assert.ok(rejected instanceof PeekabooError)
  return rejected
}
