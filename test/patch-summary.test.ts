import assert from "node:assert/strict"
import test from "node:test"

import { summarizePatchExecution } from "../src/tools/apply-patch/patch-summary.js"

test("summarizes successful add, delete, and move/update sections", () => {
  const patch = `*** Begin Patch
*** Add File: added.txt
+first
+second
*** Delete File: removed.txt
*** Update File: before.txt
*** Move to: after.txt
@@ section
-old
+new
*** End Patch`

  assert.deepEqual(summarizePatchExecution(patch, true, "Done!"), {
    changed: "added.txt +2\nremoved.txt deleted\nbefore.txt -> after.txt +1 -1",
  })
})

test("reports prior sections and a contextual hunk for a recognized failure", () => {
  const patch = `*** Begin Patch
*** Add File: added.txt
+created
*** Update File: target.ts
@@ first
-old first
+new first
@@ second
-old second
+new second
*** End Patch`
  const output = "Failed to find expected lines in target.ts: context 'second'"

  assert.deepEqual(summarizePatchExecution(patch, false, output), {
    changed: "added.txt +1",
    failed: "target.ts @@ second",
  })
})

test("identifies one bare hunk from diagnostic body evidence", () => {
  const patch = `*** Begin Patch
*** Update File: target.ts
@@
 old first
-remove first
+replace first
@@
 old second
-remove second
+replace second
*** End Patch`
  const output = "Failed to find expected lines in target.ts:\nold second\nremove second"

  assert.deepEqual(summarizePatchExecution(patch, false, output), {
    failed: "target.ts hunk 2",
  })
})

test("does not guess a hunk when diagnostic evidence is ambiguous", () => {
  const patch = `*** Begin Patch
*** Update File: target.ts
@@
 shared
-first
+one
@@
 shared
-second
+two
*** End Patch`
  const output = "Failed to find expected lines in target.ts:\nshared"

  assert.deepEqual(summarizePatchExecution(patch, false, output), {
    failed: "target.ts",
  })
})

test("does not claim changes when the native failure cannot be mapped to a section", () => {
  const patch = `*** Begin Patch
*** Add File: first.txt
+created
*** Delete File: second.txt
*** End Patch`

  assert.deepEqual(summarizePatchExecution(patch, false, "Unexpected native parser failure"), {})
})
