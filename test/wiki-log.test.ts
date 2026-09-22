import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("keeps the wiki context log in chronological order", async () => {
  const log = await readFile(new URL("../wiki/log.md", import.meta.url), "utf8")
  const dates = [...log.matchAll(/^## (\d{4}-\d{2}-\d{2}) — /gmu)].map((match) => {
    const date = match[1]
    assert.ok(date)
    return date
  })

  const [firstDate, ...remainingDates] = dates
  assert.ok(firstDate, "expected at least one dated wiki log entry")
  let previousDate = firstDate
  for (const date of remainingDates) {
    assert.ok(previousDate <= date, `wiki log entry ${date} appears after ${previousDate}`)
    previousDate = date
  }
})
