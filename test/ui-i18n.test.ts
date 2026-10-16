import assert from "node:assert/strict"
import test from "node:test"

import { en } from "../ui/src/i18n/locales/en.js"
import { ru } from "../ui/src/i18n/locales/ru.js"

test("Russian translations cover exactly the English message keys", () => {
  assert.deepEqual(
    Object.keys(ru).sort((a, b) => a.localeCompare(b)),
    Object.keys(en).sort((a, b) => a.localeCompare(b))
  )
  for (const [key, message] of Object.entries(ru)) {
    assert.ok(message.trim(), `${key} must not be empty`)
  }
})

test("Russian translations preserve every interpolation placeholder", () => {
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const placeholders = (message: string) =>
      [...message.matchAll(/\{([^}]+)\}/gu)]
        .map((match) => match[0])
        .sort((a, b) => a.localeCompare(b))
    assert.deepEqual(placeholders(ru[key]), placeholders(en[key]), key)
  }
})
