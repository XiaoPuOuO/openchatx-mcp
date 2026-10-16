import assert from "node:assert/strict"
import test from "node:test"
import { parseProcessMemory, selectProcessTree } from "../../src/runtime/memory-monitor.js"

test("parses process RSS and selects nested descendants without unrelated processes", () => {
  const rows = parseProcessMemory(
    "100 1 2048 /runtime/node\n101 100 4096 /bin/sh\n102 101 8192 /UnrealEditor\n200 1 9999 /other\n"
  )
  assert.deepEqual(
    selectProcessTree(rows, 100).map(({ pid, rssKiB }) => ({ pid, rssKiB })),
    [
      { pid: 100, rssKiB: 2048 },
      { pid: 101, rssKiB: 4096 },
      { pid: 102, rssKiB: 8192 },
    ]
  )
})
