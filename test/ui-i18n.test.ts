import assert from "node:assert/strict"
import test from "node:test"

import { en } from "../ui/src/i18n/locales/en.js"
import { ru } from "../ui/src/i18n/locales/ru.js"
import { vi } from "../ui/src/i18n/locales/vi.js"

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

test("Vietnamese translations cover exactly the English message keys", () => {
  assert.deepEqual(
    Object.keys(vi).sort((a, b) => a.localeCompare(b)),
    Object.keys(en).sort((a, b) => a.localeCompare(b))
  )
  for (const [key, message] of Object.entries(vi)) {
    assert.ok(message.trim(), `${key} must not be empty`)
  }
})

test("Vietnamese translations preserve every interpolation placeholder", () => {
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const placeholders = (message: string) =>
      [...message.matchAll(/\{([^}]+)\}/gu)]
        .map((match) => match[0])
        .sort((a, b) => a.localeCompare(b))
    assert.deepEqual(placeholders(vi[key]), placeholders(en[key]), key)
  }
})

test("Vietnamese translations retain technical filenames", () => {
  const filenames = /\b[\w.-]+\.(?:md|mdc|json|ts|tsx|toml|exe|sh|py|yaml|yml|txt|xml|html)\b/giu
  for (const [key, message] of Object.entries(en)) {
    for (const match of message.matchAll(filenames)) {
      assert.ok(vi[key as keyof typeof en].includes(match[0]), key)
    }
  }
})
