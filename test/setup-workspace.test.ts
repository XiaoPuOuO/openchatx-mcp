import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { initializeOpenChatXConfig, initializeWorkspace } from "../scripts/workspace-setup.js"
import { defaultShellPath } from "../src/host-platform.js"
import { loadPublicConfig } from "../src/public-config.cjs"
import { SkillCatalog } from "../src/tools/skills/skill-catalog.js"
import { tempDir } from "./helpers/temp.js"

test("workspace setup creates starter instructions and create-skill without overwriting either", async (t) => {
  const workspace = await tempDir(t, "mcp-setup-workspace-")

  const initial = await initializeWorkspace(workspace)
  assert.equal(initial.created, true)
  assert.equal(initial.starterSkillCreated, true)
  const agentsPath = join(workspace, "AGENTS.md")
  assert.match(await readFile(agentsPath, "utf8"), /# Workspace Instructions/u)
  const skillPath = join(workspace, "skills", "create-skill", "SKILL.md")
  assert.match(await readFile(skillPath, "utf8"), /name: create-skill/u)

  const catalog = new SkillCatalog(join(workspace, "skills"))
  assert.deepEqual(
    (await catalog.list()).map(({ name }) => name),
    ["create-skill"]
  )

  await writeFile(agentsPath, "# My Instructions\n", "utf8")
  await writeFile(
    skillPath,
    "---\nname: create-skill\ndescription: My custom skill.\n---\n",
    "utf8"
  )
  const repeated = await initializeWorkspace(workspace)
  assert.equal(repeated.created, false)
  assert.equal(repeated.starterSkillCreated, false)
  assert.equal(await readFile(agentsPath, "utf8"), "# My Instructions\n")
  assert.match(await readFile(skillPath, "utf8"), /My custom skill/u)
})

test("setup creates all defaults and preserves existing partial configs", async (t) => {
  const root = await tempDir(t, "shellby-config-scaffold-")

  const initial = await initializeOpenChatXConfig(root)
  assert.equal(initial.created, true)
  assert.equal(initial.updated, false)
  assert.equal(initial.configPath, join(root, ".openchatx", "config.toml"))
  const scaffold = loadPublicConfig(initial.configPath)
  assert.equal(scaffold.state_dir, "~/.openchatx-mcp")
  assert.equal(scaffold.workspace, "~/Desktop/agent-workspace")
  assert.deepEqual(scaffold.shell, { path: defaultShellPath(), rtk: false })
  assert.deepEqual(scaffold.mcp, { tool_output: "compact" })
  assert.equal(scaffold.tools.file_read, true)
  assert.equal(scaffold.tools.file_write, true)
  assert.deepEqual(scaffold.ngrok, { enabled: true, api_port: 4040, pooling_enabled: false })

  const scaffoldText = await readFile(initial.configPath, "utf8")
  assert.match(scaffoldText, /^# url = "https:\/\/your-reserved-domain.ngrok.app"$/mu)
  const unchanged = await initializeOpenChatXConfig(root)
  assert.equal(unchanged.updated, false)
  assert.equal(await readFile(initial.configPath, "utf8"), scaffoldText)

  await writeFile(
    initial.configPath,
    scaffoldText
      .replace(/^# url = /mu, "url = ")
      .replace("pooling_enabled = false", "pooling_enabled = true")
  )
  assert.deepEqual(loadPublicConfig(initial.configPath).ngrok, {
    enabled: true,
    api_port: 4040,
    url: "https://your-reserved-domain.ngrok.app",
    pooling_enabled: true,
  })

  await writeFile(initial.configPath, 'workspace = "~/Custom"\n')
  const repeated = await initializeOpenChatXConfig(root)
  assert.equal(repeated.created, false)
  assert.equal(repeated.updated, false)
  const migrated = loadPublicConfig(initial.configPath)
  assert.equal(migrated.state_dir, "~/.openchatx-mcp")
  assert.equal(migrated.workspace, "~/Custom")
  assert.equal(migrated.tools.shell, true)
  assert.equal(migrated.shell.rtk, false)
  assert.equal(migrated.mcp.tool_output, "compact")
  assert.deepEqual(migrated.ngrok, { enabled: true, api_port: 4040, pooling_enabled: false })
  assert.equal(await readFile(initial.configPath, "utf8"), 'workspace = "~/Custom"\n')

  const complete = await initializeOpenChatXConfig(root)
  assert.equal(complete.created, false)
  assert.equal(complete.updated, false)
})

test("setup preserves an active ngrok URL without adding a duplicate example", async (t) => {
  const root = await tempDir(t, "shellby-config-ngrok-")
  const { configPath } = await initializeOpenChatXConfig(root)
  await writeFile(
    configPath,
    'workspace = "~/Custom"\n\n[ngrok]\nurl = "https://custom.ngrok.app"\npooling_enabled = true\n'
  )

  const migrated = await initializeOpenChatXConfig(root)
  assert.equal(migrated.updated, false)
  assert.deepEqual(loadPublicConfig(configPath).ngrok, {
    enabled: true,
    api_port: 4040,
    url: "https://custom.ngrok.app",
    pooling_enabled: true,
  })
  assert.doesNotMatch(await readFile(configPath, "utf8"), /^# url = /mu)
})
