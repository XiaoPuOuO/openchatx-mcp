import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { SummaryRegistry } from "../src/summaries/summary-registry.js"

test("summary registry creates, edits, lists, consumes, and persists temporary summaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-summaries-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "summaries.json")
  const registry = new SummaryRegistry(statePath)

  const created = await registry.create(" first summary ")
  assert.match(created.uuid, /^[0-9a-f-]{36}$/u)
  assert.equal(created.content, "first summary")
  assert.equal((await registry.list()).length, 1)

  const updated = await registry.update(created.uuid, "edited summary")
  assert.equal(updated.content, "edited summary")
  assert.equal((await registry.get(created.uuid)).content, "edited summary")

  const reloaded = new SummaryRegistry(statePath)
  assert.equal((await reloaded.get(created.uuid)).content, "edited summary")

  const consumed = await reloaded.consume(created.uuid)
  assert.equal(consumed.content, "edited summary")
  assert.equal((await reloaded.list()).length, 0)
  await assert.rejects(() => reloaded.get(created.uuid), /Unknown summary UUID/u)
})

test("summary registry manually removes summaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-summaries-delete-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new SummaryRegistry(join(root, "summaries.json"))

  const created = await registry.create("delete me")
  await registry.remove(created.uuid)
  assert.deepEqual(await registry.list(), [])
})
