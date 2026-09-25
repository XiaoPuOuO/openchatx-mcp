import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { RuleCatalog } from "../../../src/tools/rules/rule-catalog.js"
import {
  exportRule,
  importRule,
  parseExternalRule,
  renderExternalRule,
} from "../../../src/tools/rules/rule-compat.js"
import { tempDir } from "../../helpers/temp.js"

test("imports Cursor, Claude, and AGENTS rule formats", async (t) => {
  const root = await tempDir(t, "openchatx-rule-import-")
  const catalog = new RuleCatalog(join(root, "rules"))

  const cursorPath = join(root, "react.mdc")
  await writeFile(
    cursorPath,
    [
      "---",
      'description: "React conventions"',
      'globs: "src/**/*.tsx"',
      "alwaysApply: false",
      "---",
      "",
      "# React",
    ].join("\n")
  )
  const cursor = await importRule(catalog, { format: "cursor", source: cursorPath })
  assert.equal(cursor.mode, "auto_attached")
  assert.deepEqual(cursor.globs, ["src/**/*.tsx"])

  const claudePath = join(root, "typescript.md")
  await writeFile(
    claudePath,
    ["---", "paths:", '  - "src/**/*.ts"', "---", "", "# TypeScript", "", "Use strict types."].join(
      "\n"
    )
  )
  const claude = await importRule(catalog, { format: "claude", source: claudePath })
  assert.equal(claude.mode, "auto_attached")
  assert.deepEqual(claude.globs, ["src/**/*.ts"])

  const agentsDirectory = join(root, "service")
  await mkdir(agentsDirectory, { recursive: true })
  const agentsPath = join(agentsDirectory, "AGENTS.md")
  await writeFile(agentsPath, "# Service\n\nUse service conventions.\n")
  const agents = await importRule(catalog, { format: "agents", source: agentsPath })
  assert.equal(agents.name, "service")
  assert.equal(agents.mode, "always")
})

test("import mode overrides map to all four OpenChatX modes", async (t) => {
  const root = await tempDir(t, "openchatx-rule-mode-import-")
  const source = join(root, "rule.md")
  await writeFile(source, "# Rule\n\nInstructions.\n")
  const catalog = new RuleCatalog(join(root, "rules"))

  const always = await importRule(catalog, {
    format: "agents",
    source,
    name: "always-rule",
    mode: "always",
  })
  assert.equal(always.mode, "always")

  const attached = await importRule(catalog, {
    format: "agents",
    source,
    name: "attached-rule",
    mode: "auto_attached",
    globs: ["src/**/*.ts"],
  })
  assert.equal(attached.mode, "auto_attached")

  const requested = await importRule(catalog, {
    format: "agents",
    source,
    name: "requested-rule",
    mode: "agent_requested",
    description: "Use for database migrations.",
  })
  assert.equal(requested.mode, "agent_requested")

  const manual = await importRule(catalog, {
    format: "agents",
    source,
    name: "manual-rule",
    mode: "manual",
  })
  assert.equal(manual.mode, "manual")
})

test("exports losslessly when the target format can preserve activation semantics", async (t) => {
  const root = await tempDir(t, "openchatx-rule-export-")
  const catalog = new RuleCatalog(join(root, "rules"))
  await catalog.create({
    name: "attached",
    globs: ["src/**/*.tsx"],
    markdown: "# React\n\nUse accessible labels.",
  })

  const cursorPath = join(root, "exports", "attached.mdc")
  const cursor = await exportRule(catalog, {
    format: "cursor",
    name: "attached",
    destination: cursorPath,
  })
  assert.deepEqual(cursor.warnings, [])
  assert.match(await readFile(cursorPath, "utf8"), /alwaysApply: false/u)

  const claudePath = join(root, "exports", "attached.md")
  const claude = await exportRule(catalog, {
    format: "claude",
    name: "attached",
    destination: claudePath,
  })
  assert.deepEqual(claude.warnings, [])
  assert.match(await readFile(claudePath, "utf8"), /paths:/u)
})

test("rejects lossy Claude and AGENTS exports unless explicitly allowed", async (t) => {
  const root = await tempDir(t, "openchatx-rule-lossy-")
  const catalog = new RuleCatalog(join(root, "rules"))
  await catalog.create({
    name: "requested",
    description: "Use for database work.",
    markdown: "# Database\n",
  })

  await assert.rejects(
    exportRule(catalog, {
      format: "claude",
      name: "requested",
      destination: join(root, "requested.md"),
    }),
    /allow_lossy=true/u
  )

  const result = await exportRule(catalog, {
    format: "agents",
    name: "requested",
    destination: join(root, "AGENTS.md"),
    allowLossy: true,
  })
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0] ?? "", /Agent Requested/u)
})

test("format adapters classify external rules predictably", () => {
  assert.equal(parseExternalRule("claude", "# Always\n").alwaysApply, true)
  const rendered = renderExternalRule(
    {
      description: "Database work",
      globs: [],
      alwaysApply: false,
      mode: "agent_requested",
      markdown: "# Database",
    },
    "cursor",
    false
  )
  assert.match(rendered.content, /description: "Database work"/u)
})
