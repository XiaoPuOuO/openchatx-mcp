import assert from "node:assert/strict"
import { test } from "node:test"
import { sessionSummary } from "../ui/src/lib/session-summary.js"

test("sidebar summary includes Dot and regular sessions", () => {
  const now = 100_000
  assert.deepEqual(
    sessionSummary(
      [
        { dot: false, lastSeenAt: 99_000 },
        { dot: true, lastSeenAt: 99_000 },
      ],
      now
    ),
    { active: 2, total: 2 }
  )
})
