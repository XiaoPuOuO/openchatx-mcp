import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
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
  const started = await first.start("smoke", "printf durable-job")
  assert.equal(started.status, "running")

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
})
