import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { SmartModelRouter } from "../src/subagents/router.js"

test("smart router honors local-only, tags, cost, and context constraints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-router-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "subagents.json")
  await writeFile(
    path,
    JSON.stringify({
      providers: {
        local: {
          type: "openai-compatible",
          base_url: "http://127.0.0.1:11434/v1",
          enabled: true,
          timeout: 1000,
        },
        cloud: {
          type: "openai-compatible",
          base_url: "https://example.com/v1",
          enabled: true,
          timeout: 1000,
        },
      },
      models: {
        coder: {
          provider: "local",
          model: "qwen",
          name: "Local Coder",
          description: "Fast coding and code analysis",
          enabled: true,
          context_window: 131072,
          tags: ["coding", "analysis"],
          cost_tier: "low",
          thinking: { mode: "none" },
        },
        vision: {
          provider: "cloud",
          model: "vision",
          name: "Cloud Vision",
          description: "Vision model",
          enabled: true,
          context_window: 32768,
          tags: ["vision"],
          cost_tier: "high",
          thinking: { mode: "none" },
        },
      },
    })
  )

  const router = new SmartModelRouter(path)
  const selection = router.select({
    task: "analyze this codebase",
    preferredTags: ["coding"],
    localOnly: true,
    maxCostTier: "low",
    minContextWindow: 100000,
  })
  assert.equal(selection.profile, "coder")
  assert.equal(selection.local, true)
  assert.equal(selection.costTier, "low")
  assert.ok(selection.reasons.includes("tag:coding"))
})
