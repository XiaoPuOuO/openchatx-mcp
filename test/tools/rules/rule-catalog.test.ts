import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { parseMdc, RuleCatalog, renderMdc } from "../../../src/tools/rules/rule-catalog.js"
import { tempDir } from "../../helpers/temp.js"

test("parses Cursor-style .mdc frontmatter", () => {
  const parsed = parseMdc(
    [
      "---",
      "description: React component conventions",
      "globs:",
      '  - "src/**/*.tsx"',
      '  - "**/*.jsx"',
      "alwaysApply: false",
      "---",
      "",
      "# React",
      "",
      "Prefer named exports.",
    ].join("\n")
  )

  assert.deepEqual(parsed, {
    description: "React component conventions",
    globs: ["src/**/*.tsx", "**/*.jsx"],
    alwaysApply: false,
    markdown: "# React\n\nPrefer named exports.",
  })
})

test("renders .mdc with description globs alwaysApply and Markdown", () => {
  const content = renderMdc({
    description: "TypeScript rules",
    globs: ["src/**/*.ts", "src/**/*.tsx"],
    alwaysApply: false,
    markdown: "# TS\n\nUse strict types.",
  })
  assert.match(content, /description: "TypeScript rules"/u)
  assert.match(content, /globs:/u)
  assert.match(content, /alwaysApply: false/u)
  assert.match(content, /# TS/u)
})

test("resolves always, glob, intelligent, and manual rule modes", async (t) => {
  const root = await tempDir(t, "openchatx-rules-")
  const rulesRoot = join(root, "rules")
  await mkdir(rulesRoot, { recursive: true })

  await writeFile(
    join(rulesRoot, "always.mdc"),
    "---\nalwaysApply: true\n---\n\nAlways instructions.\n"
  )
  await writeFile(
    join(rulesRoot, "typescript.mdc"),
    '---\nglobs: "**/*.ts"\nalwaysApply: false\n---\n\nTypeScript instructions.\n'
  )
  await writeFile(
    join(rulesRoot, "database.mdc"),
    "---\ndescription: Database migrations and schema changes\nalwaysApply: false\n---\n\nDatabase instructions.\n"
  )
  await writeFile(
    join(rulesRoot, "manual.mdc"),
    "---\nalwaysApply: false\n---\n\nManual instructions.\n"
  )

  const catalog = new RuleCatalog(rulesRoot)
  const always = await catalog.alwaysApplied()
  assert.deepEqual(
    always.map((rule) => rule.name),
    ["always"]
  )
  assert.equal(always[0]?.markdown, "Always instructions.")

  const resolved = await catalog.resolve({
    query: "prepare a database migration",
    paths: ["src/index.ts"],
  })
  assert.deepEqual(
    resolved.map((rule) => rule.name).sort((left, right) => left.localeCompare(right)),
    ["database", "typescript"]
  )
  assert.equal(
    resolved.some((rule) => rule.name === "always"),
    false
  )
  assert.equal(
    resolved.some((rule) => rule.name === "manual"),
    false
  )

  const manual = await catalog.load("manual")
  assert.equal(manual.markdown, "Manual instructions.")
})

test("creates edits and deletes .mdc rules", async (t) => {
  const root = await tempDir(t, "openchatx-rules-manage-")
  const catalog = new RuleCatalog(join(root, "rules"))

  const created = await catalog.create({
    name: "react-components",
    description: "React UI conventions",
    globs: ["src/components/**/*.tsx"],
    markdown: "# React\n\nUse named exports.",
  })
  assert.equal(created.description, "React UI conventions")
  assert.deepEqual(created.globs, ["src/components/**/*.tsx"])
  assert.equal(created.alwaysApply, false)

  const edited = await catalog.edit("react-components", {
    alwaysApply: true,
    markdown: "# React\n\nUse named exports and accessible labels.",
  })
  assert.equal(edited.alwaysApply, true)
  assert.match(edited.markdown, /accessible labels/u)

  await catalog.delete("react-components")
  assert.deepEqual(await catalog.list(), [])
})
