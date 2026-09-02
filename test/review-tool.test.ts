import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { saveReview } from "../src/tools/review/review-tool.js"

test("saves Shellby reviews without session metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-review-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, ".shellby", "reviews.jsonl")

  await saveReview(path, { rating: 8.7, review: "Fast local tools; shell polling was easy to follow." })

  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.rating, "8.7")
  assert.equal(records[0]?.review, "Fast local tools; shell polling was easy to follow.")
  assert.equal(Object.hasOwn(records[0] ?? {}, "session"), false)
})
