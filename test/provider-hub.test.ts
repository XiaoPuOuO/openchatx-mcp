import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"

import { ProviderHub } from "../src/providers/provider-hub.js"

test("Provider Hub installs local presets without requiring an API key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-provider-hub-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, "subagents.json")
  const hub = new ProviderHub(configPath)
  const presets = hub.presets()
  assert.ok(presets.some((preset) => preset.id === "ollama" && preset.local))
  const config = hub.installPreset("ollama")
  assert.equal(config.providers.ollama?.base_url, "http://127.0.0.1:11434/v1")
  assert.equal(config.providers.ollama?.enabled, true)
})

test("Provider Hub requires a key for hosted presets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-provider-key-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  })
  const hub = new ProviderHub(join(root, "subagents.json"))
  assert.throws(() => hub.installPreset("openai"), /requires an API key/u)
})

test("Provider Hub can preserve an OpenAI API key supplied by the desktop environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-provider-env-key-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "sk-preserved-test-key"
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  })

  const hub = new ProviderHub(join(root, "subagents.json"))
  const config = hub.installPreset("openai")
  assert.equal(config.providers.openai?.api_key, "sk-preserved-test-key")
})
