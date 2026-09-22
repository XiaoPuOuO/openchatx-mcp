import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { tempDir } from "./helpers/temp.js"

const applyPatch = fileURLToPath(new URL("../vendor/apply-patch/apply_patch", import.meta.url))

test("executes the vendored apply_patch binary on the host architecture", async (t) => {
  const cwd = await tempDir(t, "apply-patch-vendor-")
  const result = spawnSync(applyPatch, [], {
    cwd,
    input: "*** Begin Patch\n*** Add File: architecture.txt\n+native\n*** End Patch\n",
    encoding: "utf8",
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(await readFile(join(cwd, "architecture.txt"), "utf8"), "native\n")
})
