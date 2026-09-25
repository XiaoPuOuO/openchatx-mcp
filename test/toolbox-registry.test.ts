import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"

import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { ToolboxRegistry } from "../src/toolbox/registry.js"
import { tempDir } from "./helpers/temp.js"

test("loads a custom TypeScript toolbox tool and exposes it through MCP", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".openchatx-toolbox-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const box = join(root, "demo")
  await mkdir(join(box, "tools"), { recursive: true })
  await mkdir(join(box, "skills"), { recursive: true })
  await writeFile(
    join(box, "toolbox.json"),
    JSON.stringify({ name: "Demo", enabled: true, dynamic: false, tools: {}, skills: {} })
  )
  await writeFile(
    join(box, "tools", "hello.ts"),
    `import { z } from "zod"
export default {
  name: "hello",
  description: "Say hello",
  inputSchema: z.object({ name: z.string() }),
  async execute(input: { name: string }) {
    return { content: [{ type: "text", text: "Hello " + input.name }] }
  }
}
`
  )

  const registry = new ToolboxRegistry(root)
  await registry.start()
  t.after(() => registry.close())

  const snapshot = registry.snapshots()[0]
  assert.equal(snapshot?.id, "demo")
  assert.equal(snapshot?.tools[0]?.name, "hello")
  assert.equal(snapshot?.tools[0]?.error, undefined)

  const server = new McpServer({ name: "toolbox-registry-test", version: "1.0.0" })
  const client = new Client({ name: "toolbox-registry-client", version: "1.0.0" })
  registry.registerCustomTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))

  const tools = await client.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["demo__hello"]
  )
  const result = await client.callTool({ name: "demo__hello", arguments: { name: "OpenChatX" } })
  assert.equal(result.content.find((item) => item.type === "text")?.text, "Hello OpenChatX")
})

test("toolbox settings persist tool toggles and required toolboxes stay enabled", async (t) => {
  const root = await tempDir(t, "openchatx-toolbox-settings-")
  const box = join(root, "system")
  await mkdir(join(box, "skills"), { recursive: true })
  await writeFile(
    join(box, "toolbox.json"),
    JSON.stringify({
      name: "System",
      enabled: true,
      builtin: "system",
      tools: {
        start_here: { enabled: true, required: true },
        optional: { enabled: true },
      },
      skills: {},
    })
  )

  const registry = new ToolboxRegistry(root)
  await registry.reload()
  await registry.setToolEnabled("system", "optional", false)
  assert.equal(registry.isToolEnabled("system", "optional"), false)
  assert.equal(registry.isToolboxDynamic("system"), false)
  await assert.rejects(registry.setToolboxDynamic("system", true), /must remain eager/u)
  await assert.rejects(registry.setToolEnabled("system", "start_here", false), /required/u)
  await assert.rejects(registry.setToolboxEnabled("system", false), /required/u)

  const manifest = JSON.parse(await readFile(join(box, "toolbox.json"), "utf8")) as {
    dynamic?: boolean
    tools: { optional: { enabled: boolean } }
  }
  assert.equal(manifest.dynamic, undefined)
  assert.equal(manifest.tools.optional.enabled, false)
})

test("toolbox skills are discovered, toggled, and loaded", async (t) => {
  const root = await tempDir(t, "openchatx-toolbox-skill-")
  const box = join(root, "game")
  await mkdir(join(box, "skills", "debug-level"), { recursive: true })
  await writeFile(
    join(box, "toolbox.json"),
    JSON.stringify({ name: "Game", enabled: true, tools: {}, skills: {} })
  )
  await writeFile(
    join(box, "skills", "debug-level", "SKILL.md"),
    "---\nname: debug-level\ndescription: Debug a game level\n---\n\n# Debug Level\n"
  )

  const registry = new ToolboxRegistry(root)
  await registry.reload()
  assert.deepEqual(
    (await registry.listSkills()).map((skill) => skill.name),
    ["game.debug-level"]
  )
  const skill = await registry.readSkill("game.debug-level")
  assert.match(skill.content, /Debug Level/u)
  await registry.setSkillEnabled("game", "debug-level", false)
  assert.deepEqual(await registry.listSkills(), [])
})

test("toolbox rules are stored inside the owning toolbox", async (t) => {
  const root = await tempDir(t, "openchatx-toolbox-rule-")
  const box = join(root, "game")
  await mkdir(box, { recursive: true })
  await writeFile(
    join(box, "toolbox.json"),
    JSON.stringify({ name: "Game", enabled: true, tools: {}, skills: {} })
  )

  const registry = new ToolboxRegistry(root)
  await registry.reload()
  const created = await registry.ruleCatalog("game").create({
    name: "user-rule",
    alwaysApply: true,
    markdown: "# Game Rule\n",
  })

  assert.equal(created.path, join(box, "rules", "user-rule.mdc"))
  assert.match(await readFile(created.path, "utf8"), /Game Rule/u)
  assert.deepEqual(
    (await registry.alwaysAppliedRules()).map((rule) => [rule.toolboxId, rule.name]),
    [["game", "user-rule"]]
  )
})

test("createTool writes a TypeScript SDK template", async (t) => {
  const root = await tempDir(t, "openchatx-toolbox-template-")
  const registry = new ToolboxRegistry(root)
  await registry.reload()
  await registry.createToolbox("custom")
  const path = await registry.createTool("custom", "ping")
  const source = await readFile(path, "utf8")
  assert.match(source, /openchatx-mcp\/toolbox/u)
  assert.match(source, /defineTool/u)
})

test("built-in tools are filtered by toolbox settings instead of legacy tool flags", async (t) => {
  const root = await tempDir(t, "openchatx-builtin-toolbox-")
  for (const [id, manifest] of Object.entries({
    system: {
      name: "System",
      enabled: true,
      builtin: "system",
      tools: { start_here: { enabled: true, required: true } },
      skills: {},
    },
    files: {
      name: "Files",
      enabled: true,
      builtin: "files",
      tools: {
        apply_patch: { enabled: true },
        file_read: { enabled: false },
        file_write: { enabled: false },
      },
      skills: {},
    },
  })) {
    const path = join(root, id)
    await mkdir(join(path, "skills"), { recursive: true })
    await writeFile(join(path, "toolbox.json"), JSON.stringify(manifest))
  }

  const registry = new ToolboxRegistry(root)
  await registry.reload()

  const factory = createMcpServerFactory(
    { toolboxRegistry: registry },
    {
      tools: {
        shell: false,
        applyPatch: false,
        fileRead: true,
        fileWrite: true,
        web: false,
        skills: false,
        image: false,
      },
    }
  )
  const server = factory()
  const client = new Client({ name: "builtin-toolbox-client", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(() => Promise.all([client.close(), server.close()]))

  const names = (await client.listTools()).tools.map((tool) => tool.name).sort()
  assert.ok(names.includes("start_here"))
  assert.ok(names.includes("apply_patch"))
  assert.ok(!names.includes("file_read"))
  assert.ok(!names.includes("file_write"))
})
