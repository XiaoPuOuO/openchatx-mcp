import assert from "node:assert/strict"
import test from "node:test"

import { canonicalizeJsonSchema, compactToolAnnotations } from "../src/server/tool-registration-boundary.js"
import { shellRunFileEditNotices } from "../src/tools/shell/apply-patch-guidance.js"

test("canonicalizes schema keywords while preserving property order", () => {
  const schema = canonicalizeJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description: "Example",
    required: ["z", "type"],
    properties: {
      z: { maxLength: 64, description: "Z", type: "string", minLength: 1 },
      type: { default: "example", description: "Named type", type: "string" },
      a: { maximum: 10, type: "integer", description: "A", minimum: 1 },
    },
    type: "object",
  }) as Record<string, unknown>

  assert.deepEqual(Object.keys(schema), ["description", "type", "properties", "required"])

  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(properties), ["z", "type", "a"])
  assert.deepEqual(Object.keys(properties.z ?? {}), ["description", "type", "minLength", "maxLength"])
  assert.deepEqual(Object.keys(properties.type ?? {}), ["description", "type", "default"])
  assert.deepEqual(Object.keys(properties.a ?? {}), ["description", "type", "minimum", "maximum"])
})

test("removes schema metadata and artificial safe-integer bounds", () => {
  const schema = canonicalizeJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      unbounded: { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      nonnegative: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      bounded: { type: "integer", minimum: 0, maximum: 255 },
      number: { type: "number", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    },
  }) as Record<string, unknown>

  assert.equal("$schema" in schema, false)
  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(properties.unbounded, { type: "integer" })
  assert.deepEqual(properties.nonnegative, { type: "integer", minimum: 0 })
  assert.deepEqual(properties.bounded, { type: "integer", minimum: 0, maximum: 255 })
  assert.deepEqual(properties.number, {
    type: "number",
    minimum: Number.MIN_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  })
})

test("prioritizes shape before defaults and exact choices", () => {
  const schema = canonicalizeJsonSchema({
    const: "a",
    enum: ["a", "b"],
    default: "a",
    oneOf: [{ type: "string" }],
    anyOf: [{ type: "string" }],
    allOf: [{ type: "string" }],
    type: "string",
    description: "Example",
  }) as Record<string, unknown>

  assert.deepEqual(Object.keys(schema), ["description", "type", "anyOf", "oneOf", "allOf", "default", "enum", "const"])
})

test("does not reorder objects stored as schema data", () => {
  const defaultValue = { type: "literal", z: 1, a: 2 }
  const schema = canonicalizeJsonSchema({ default: defaultValue, type: "object" }) as Record<string, unknown>

  assert.deepEqual(Object.keys(schema), ["type", "default"])
  assert.equal(schema.default, defaultValue)
  assert.deepEqual(Object.keys(schema.default as Record<string, unknown>), ["type", "z", "a"])
})

test("omits default and irrelevant read-only annotations while preserving extension values", () => {
  assert.equal(
    compactToolAnnotations({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    }),
    undefined
  )
  assert.deepEqual(
    compactToolAnnotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: "Read records",
    }),
    {
      readOnlyHint: true,
      openWorldHint: false,
      title: "Read records",
    }
  )
})

test("emits apply_patch notice for obvious shell file edits", () => {
  const notice = "Use the `apply_patch` MCP tool over `shell_run` for file changes."
  const commands = [
    "cat > notes.txt <<'EOF'\nhello\nEOF",
    "echo hello >> notes.txt",
    "printf '%s\\n' hello > notes.txt",
    "printf hello | tee notes.txt",
    "sed -i '' 's/old/new/' notes.txt",
    "perl -pi -e 's/old/new/' notes.txt",
    "python -c 'from pathlib import Path; Path(\"notes.txt\").write_text(\"hello\")'",
    `python -c 'open("notes.txt", "w").write("hello")'`,
    `node -e 'require("fs").writeFileSync("notes.txt", "hello")'`,
  ]

  for (const command of commands) {
    assert.deepEqual(shellRunFileEditNotices({ command }), [notice], command)
  }

  assert.deepEqual(shellRunFileEditNotices({ commands: [{ command: "grep hello notes.txt" }, { command: "echo hello > notes.txt" }] }), [notice])
})

test("does not emit apply_patch notice for normal shell commands", () => {
  const commands = [
    "cat notes.txt",
    "grep hello notes.txt",
    "sed 's/old/new/' notes.txt",
    "python -m pytest",
    "rm -rf dist",
    "mv build output",
    "cp fixture.txt work.txt",
    "mkdir -p tmp/cache",
    "rmdir empty-dir",
  ]

  for (const command of commands) {
    assert.deepEqual(shellRunFileEditNotices({ command }), [], command)
  }
})
