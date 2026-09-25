import assert from "node:assert/strict"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { initializeOpenChatXConfig, initializeOpenChatXState } from "../scripts/state-setup.js"
import { defaultShellPath } from "../src/host-platform.js"
import { loadPublicConfig } from "../src/public-config.cjs"
import { tempDir } from "./helpers/temp.js"

test("state setup creates AGENTS.md without creating a global skills catalog", async (t) => {
  const stateDir = await tempDir(t, "mcp-setup-state-")

  const initial = await initializeOpenChatXState(stateDir)
  assert.equal(initial.agentsCreated, true)
  const agentsPath = join(stateDir, "AGENTS.md")
  const agentsTemplate = await readFile(agentsPath, "utf8")
  assert.match(agentsTemplate, /# OpenChatX Agent Instructions/u)
  assert.match(agentsTemplate, /\{\{CAPABILITY_CATALOG\}\}/u)
  await assert.rejects(stat(join(stateDir, "skills")), /ENOENT/u)

  await writeFile(agentsPath, "# My Instructions\n", "utf8")
  const repeated = await initializeOpenChatXState(stateDir)
  assert.equal(repeated.agentsCreated, false)
  assert.equal(await readFile(agentsPath, "utf8"), "# My Instructions\n")
})

test("setup creates tunnel-client defaults and preserves existing partial configs", async (t) => {
  const root = await tempDir(t, "openchatx-config-scaffold-")

  const initial = await initializeOpenChatXConfig(root)
  assert.equal(initial.created, true)
  assert.equal(initial.updated, false)
  assert.equal(initial.configPath, join(root, ".openchatx", "config.toml"))
  const scaffold = loadPublicConfig(initial.configPath)
  assert.equal(scaffold.state_dir, "~/.openchatx-mcp")
  assert.deepEqual(scaffold.shell, { path: defaultShellPath(), rtk: false })
  assert.deepEqual(scaffold.mcp, { tool_output: "compact" })
  assert.deepEqual(scaffold.tunnel, { profile: "openchatx", health_port: 8080 })
  assert.equal(scaffold.tools.file_read, true)
  assert.equal(scaffold.tools.file_write, true)

  const scaffoldText = await readFile(initial.configPath, "utf8")
  assert.match(scaffoldText, /^\[tunnel\]$/mu)
  assert.match(scaffoldText, /^profile = "openchatx"$/mu)
  assert.match(scaffoldText, /^health_port = 8080$/mu)

  const unchanged = await initializeOpenChatXConfig(root)
  assert.equal(unchanged.updated, false)
  assert.equal(await readFile(initial.configPath, "utf8"), scaffoldText)

  await writeFile(initial.configPath, '[tunnel]\nprofile = "personal"\nhealth_port = 8181\n')
  const repeated = await initializeOpenChatXConfig(root)
  assert.equal(repeated.created, false)
  assert.equal(repeated.updated, false)
  const loaded = loadPublicConfig(initial.configPath)
  assert.deepEqual(loaded.tunnel, { profile: "personal", health_port: 8181 })
})
