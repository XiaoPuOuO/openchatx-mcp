import assert from "node:assert/strict"
import test from "node:test"

import { shellRunFileEditNotices } from "../../../src/tools/shell/apply-patch-guidance.js"

test("emits apply_patch notice for obvious shell file edits", () => {
  const notice =
    "Use `file_edit` for precise single-file replacements or `apply_patch` for structural/multi-file changes instead of `bash`."
  const commands = [
    "cat > notes.txt <<'EOF'\nhello\nEOF",
    "echo hello >> notes.txt",
    "printf '%s\\n' hello > notes.txt",
    "printf hello | tee notes.txt",
    "sed -i '' 's/old/new/' notes.txt",
    "perl -pi -e 's/old/new/' notes.txt",
    'python -c \'from pathlib import Path; Path("notes.txt").write_text("hello")\'',
    `python -c 'open("notes.txt", "w").write("hello")'`,
    `node -e 'require("fs").writeFileSync("notes.txt", "hello")'`,
  ]

  for (const command of commands) {
    assert.deepEqual(shellRunFileEditNotices({ command }), [notice], command)
  }

  assert.deepEqual(
    shellRunFileEditNotices({
      commands: [{ command: "grep hello notes.txt" }, { command: "echo hello > notes.txt" }],
    }),
    [notice]
  )
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
