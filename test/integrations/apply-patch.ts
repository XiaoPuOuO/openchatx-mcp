import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { applyPatch } from "../../src/tools/apply-patch/apply-patch.js"
import { connectClient, startMcpHttpServer, toolText } from "./helpers.js"

test("applies real patches and reports partial native changes through MCP", {
  timeout: 20_000,
}, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-patch-result-")))
  const project = join(directory, "project")
  await mkdir(project, { recursive: true })
  await writeFile(join(project, "a.txt"), "one\ntwo\nthree\n")
  await writeFile(join(project, "b.txt"), "alpha\nbeta\n")

  const running = await startMcpHttpServer()
  t.after(async () => {
    await running.close()
    await rm(directory, { recursive: true, force: true })
  })
  const connected = await connectClient(running.url, "patch-result-client")
  t.after(() => connected.client.close())

  const partialPatch = [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "@@ one",
    "-two",
    "+TWO",
    "*** Update File: b.txt",
    "@@ alpha",
    "-beta",
    "+BETA",
    "@@",
    "-missing",
    "+MISSING",
    "*** End Patch",
  ].join("\n")
  const partial = await connected.client.callTool({
    name: "apply_patch",
    arguments: { cwd: project, patch: partialPatch },
  })
  assert.equal(partial.isError, true)
  const partialText = toolText(partial)
  assert.match(partialText, /^status=partial exit_code=1/u)
  assert.match(partialText, /changed:\na\.txt \+1 -1/u)
  assert.match(partialText, /failed:\nb\.txt hunk 2/u)
  assert.match(partialText, /output:\n\nFailed to find expected lines .*\/b\.txt:\nmissing/u)
  assert.equal(await readFile(join(project, "a.txt"), "utf8"), "one\nTWO\nthree\n")
  assert.equal(await readFile(join(project, "b.txt"), "utf8"), "alpha\nbeta\n")

  const movePatch = [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "*** Move to: nested/a.txt",
    "@@ one",
    "-TWO",
    "+two",
    "*** End Patch",
  ].join("\n")
  const moved = await connected.client.callTool({
    name: "apply_patch",
    arguments: { cwd: project, patch: movePatch },
  })
  assert.equal(moved.structuredContent, undefined)
  assert.equal(
    toolText(moved),
    "status=completed exit_code=0\n\nchanged:\na.txt -> nested/a.txt +1 -1"
  )
  await assert.rejects(readFile(join(project, "a.txt")), { code: "ENOENT" })
  assert.equal(await readFile(join(project, "nested/a.txt"), "utf8"), "one\ntwo\nthree\n")
})

test("rejects a nonexistent apply_patch cwd clearly", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "patch-missing-cwd-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "apply_patch",
    arguments: {
      cwd: "/definitely/missing/apply-patch-cwd",
      patch: "*** Begin Patch\n*** End Patch",
    },
  })

  assert.equal(result.isError, true)
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /cwd does not exist:/u
  )
})

test("aborting applyPatch force-kills a SIGTERM-resistant child", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-aborted-patch-")))
  const project = join(directory, "project")
  const bin = join(directory, "bin")
  await mkdir(project, { recursive: true })
  await mkdir(bin, { recursive: true })
  const executable = join(bin, "apply_patch")
  await writeFile(
    executable,
    "#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' \"$$\" > \"$PWD/patch.pid\"\ncat >/dev/null\nwhile :; do sleep 1; done\n"
  )
  await import("node:fs/promises").then(({ chmod }) => chmod(executable, 0o755))

  let patchPid: number | undefined
  t.after(async () => {
    if (patchPid) {
      try {
        process.kill(-patchPid, "SIGKILL")
      } catch {
        // Process may already be gone.
      }
    }
    await rm(directory, { recursive: true, force: true })
  })

  const controller = new AbortController()
  const runningPatch = applyPatch({
    cwd: project,
    patch: "*** Begin Patch\n*** End Patch",
    executable,
    signal: controller.signal,
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      patchPid = Number.parseInt(await readFile(join(project, "patch.pid"), "utf8"), 10)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  assert.ok(patchPid && Number.isSafeInteger(patchPid), "fake apply_patch did not start")
  controller.abort()
  await assert.rejects(runningPatch, /apply_patch request was aborted/u)

  let exited = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(patchPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        exited = true
        break
      }
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(exited, true, "SIGTERM-resistant apply_patch process was not force-killed")
})
