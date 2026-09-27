import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { JobManager } from "../src/jobs/job-manager.js"

test("durable jobs persist status and logs across manager instances", {
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-jobs-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = new JobManager(root, join(root, "jobs.json"))
  const started = await first.start("smoke", "printf durable-job", undefined, "openchatx")
  assert.equal(started.status, "running")
  assert.equal(started.projectId, "openchatx")

  let finished = await first.get(started.id)
  for (let attempt = 0; attempt < 50 && finished.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    finished = await first.get(started.id)
  }
  assert.equal(finished.status, "completed")
  const output = await first.readLog(started.id)
  assert.match(output.output, /durable-job/u)

  const second = new JobManager(root, join(root, "jobs.json"))
  const restored = await second.get(started.id)
  assert.equal(restored.status, "completed")
  assert.equal(restored.label, "smoke")
  assert.equal(restored.projectId, "openchatx")
})

test("durable jobs enforce an explicit hard deadline", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-job-timeout-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manager = new JobManager(root, join(root, "jobs.json"))
  const started = await manager.start("timeout", "sleep 5", undefined, undefined, 100)
  const result = await manager.wait(started.id, 2_000)
  assert.equal(result.job.status, "failed")
  assert.equal(result.job.timedOut, true)
  assert.equal(result.job.exitCode, -1)
})

test("aborting a wait does not terminate the durable process", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-job-abort-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manager = new JobManager(root, join(root, "jobs.json"))
  const started = await manager.start("abort-safe", "sleep 0.3; printf survived")

  await assert.rejects(
    manager.wait(started.id, 2_000, 0, 16_384, AbortSignal.timeout(50)),
    /aborted|timeout/iu
  )

  const finished = await manager.wait(started.id, 2_000)
  assert.equal(finished.job.status, "completed")
  assert.match(finished.output, /survived/u)
})

for (const [label, contents] of [
  ["empty", ""],
  ["truncated", '{"jobs":['],
  ["schema-invalid", '{"jobs":[{"id":42}]}'],
] as const) {
  test(`durable jobs quarantine ${label} persisted state and continue empty`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `openchatx-job-corrupt-${label}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const statePath = join(root, "jobs.json")
    await writeFile(statePath, contents, "utf8")

    const manager = new JobManager(root, statePath)
    await manager.initialize()
    assert.deepEqual(await manager.list(), [])

    const quarantined = (await readdir(root)).filter((name) =>
      name.startsWith("jobs.json.corrupt-")
    )
    assert.equal(quarantined.length, 1)
    assert.equal(await readFile(join(root, quarantined[0] ?? ""), "utf8"), contents)

    await manager.close()
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { jobs: [] })
  })
}

test("durable job persistence atomically replaces state without leaving temp files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-job-atomic-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "jobs.json")
  const manager = new JobManager(root, statePath)

  await manager.initialize()
  await manager.close()

  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { jobs: [] })
  assert.equal(
    (await readdir(root)).some((name) => name.startsWith(".jobs.json.") && name.endsWith(".tmp")),
    false
  )
})
