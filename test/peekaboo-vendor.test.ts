import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const peekaboo = fileURLToPath(new URL("../vendor/peekaboo/peekaboo", import.meta.url))
const cursorHost = fileURLToPath(
  new URL("../vendor/peekaboo/peekaboo-cursor-host", import.meta.url)
)

test("ships Universal 2 Peekaboo binaries and executes the CLI", () => {
  for (const executable of [peekaboo, cursorHost]) {
    const architectures = spawnSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" })
    assert.equal(architectures.status, 0, architectures.stderr)
    assert.match(architectures.stdout, /\barm64\b/u)
    assert.match(architectures.stdout, /\bx86_64\b/u)
  }

  const version = spawnSync(peekaboo, ["--version"], { encoding: "utf8" })
  assert.equal(version.status, 0, version.stderr || version.stdout)
  assert.match(version.stdout, /Peekaboo/u)
})
