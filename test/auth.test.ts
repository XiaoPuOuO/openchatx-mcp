import assert from "node:assert/strict"
import { readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import test from "node:test"

import { ShellbyAuthError, ShellbyAuthStore } from "../src/auth/auth.js"
import { tempDir } from "./helpers/temp.js"

test("creates durable auth state with owner-only permissions", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-")
  const filePath = join(root, ".shellby", "auth.json")
  const auth = new ShellbyAuthStore(filePath)

  const first = await auth.ensureState()
  const second = await new ShellbyAuthStore(filePath).ensureState()

  assert.deepEqual(first, { version: 1, subject: null })
  assert.deepEqual(second, first)
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), first)

  if (process.platform !== "win32") {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(filePath))).mode & 0o777, 0o700)
  }
})

test("first remote access binds one subject and later access requires it", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-bind-")
  const auth = new ShellbyAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  assert.equal((await auth.authorizeRemoteAccess("subject-a")).subject, "subject-a")
  assert.equal((await auth.authorizeRemoteAccess("subject-a")).subject, "subject-a")
  await assert.rejects(
    () => auth.authorizeRemoteAccess("subject-b"),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "subject_mismatch"
  )
})

test("concurrent first remote access binds exactly one subject", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-race-")
  const auth = new ShellbyAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  const results = await Promise.allSettled([auth.authorizeRemoteAccess("subject-a"), auth.authorizeRemoteAccess("subject-b")])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => result.status === "rejected").length, 1)
})

test("reset clears the bound subject", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-reset-")
  const auth = new ShellbyAuthStore(join(root, "auth.json"))
  await auth.ensureState()
  await auth.authorizeRemoteAccess("subject-a")

  assert.deepEqual(await auth.reset(), { version: 1, subject: null })
})

test("malformed auth state fails closed instead of being replaced", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-invalid-")
  const filePath = join(root, "auth.json")
  await writeFile(filePath, "not-json\n", { mode: 0o600 })
  const auth = new ShellbyAuthStore(filePath)

  await assert.rejects(
    () => auth.ensureState(),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "state_invalid"
  )
  assert.equal(await readFile(filePath, "utf8"), "not-json\n")
})
