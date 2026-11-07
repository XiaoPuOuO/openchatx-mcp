import assert from "node:assert/strict"
import test from "node:test"
import { createSafeModeSwitcher } from "../src/recovery/safe-mode-switch.js"

test("safe mode rolls back both live registries when a switch fails", async () => {
  let root = "user"
  let config = "user"
  const apply = createSafeModeSwitcher({
    root: () => root,
    config: () => config,
    setRoot: async (next) => {
      root = next
    },
    setConfig: async (next) => {
      config = next
      if (next === "safe") throw new Error("failed")
    },
    publishConfig: () => {},
    userRoot: "user",
    safeRoot: "safe",
    userConfig: "user",
    safeConfig: "safe",
  })
  await assert.rejects(apply(true), /failed/)
  assert.equal(root, "user")
  assert.equal(config, "user")
})

test("safe mode switches are serialized", async () => {
  let root = "user"
  let config = "user"
  const apply = createSafeModeSwitcher({
    root: () => root,
    config: () => config,
    setRoot: async (next) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      root = next
    },
    setConfig: async (next) => {
      config = next
    },
    publishConfig: () => {},
    userRoot: "user",
    safeRoot: "safe",
    userConfig: "user",
    safeConfig: "safe",
  })
  await Promise.all([apply(true), apply(false)])
  assert.equal(root, "user")
  assert.equal(config, "user")
})
