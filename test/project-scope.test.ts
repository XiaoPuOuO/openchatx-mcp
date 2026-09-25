import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  getAgentIdentity,
  grantAgentProjectExternalAccessOnce,
  runWithAgent,
  setAgentProjectExternalAccessAll,
} from "../src/agent/context.js"
import { ProjectRegistry } from "../src/projects/project-registry.js"
import { ProjectScope } from "../src/projects/project-scope.js"

test("active Project controls relative roots and enforces read/write/shell permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-project-scope-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, "app")
  const appAssets = join(root, "app-assets")
  const other = join(root, "other")
  await Promise.all([mkdir(app), mkdir(appAssets), mkdir(other)])

  const registry = new ProjectRegistry(join(root, "projects.json"))
  await registry.upsert({
    id: "app",
    name: "App",
    path: app,
    additionalPaths: [appAssets],
    permissions: { read: true, write: false, shell: false },
  })
  await registry.upsert({
    id: "other",
    name: "Other",
    path: other,
    permissions: { read: true, write: true, shell: true },
  })
  const scope = new ProjectScope(registry)

  await runWithAgent("project-scope-session", async () => {
    assert.equal((await scope.use("app"))?.id, "app")
    assert.equal(getAgentIdentity()?.projectId, "app")
    assert.equal((await scope.resolvePath(undefined, "read")).path, app)
    assert.equal((await scope.resolvePath("src/index.ts", "read")).path, join(app, "src/index.ts"))
    await assert.rejects(
      () => scope.resolvePath("src/index.ts", "write"),
      /does not grant "write"/u
    )
    await assert.rejects(() => scope.resolvePath(undefined, "shell"), /does not grant "shell"/u)
    await assert.rejects(
      () => scope.resolvePath("../escape.txt", "read"),
      /outside active Project/u
    )
    assert.equal(
      (await scope.resolvePath(join(appAssets, "design.fig"), "read")).path,
      join(appAssets, "design.fig")
    )

    const otherPath = join(other, "file.txt")
    await assert.rejects(
      () => scope.resolvePath(otherPath, "read"),
      /PROJECT_EXTERNAL_ACCESS_REQUIRED|outside active Project/u
    )
    await assert.rejects(
      () => scope.resolvePath(otherPath, "read", "other"),
      /not the active Project/u
    )

    grantAgentProjectExternalAccessOnce(other)
    assert.equal((await scope.resolvePath(otherPath, "read")).path, otherPath)
    await assert.rejects(() => scope.resolvePath(otherPath, "read"), /outside active Project/u)

    setAgentProjectExternalAccessAll(true)
    assert.equal((await scope.resolvePath(otherPath, "read")).path, otherPath)
    assert.equal(
      (await scope.resolvePath(join(root, "anywhere.txt"), "read")).path,
      join(root, "anywhere.txt")
    )

    setAgentProjectExternalAccessAll(false)
    await assert.rejects(
      () => scope.resolvePath(otherPath, "read", "app"),
      /outside active Project/u
    )

    await scope.use(undefined)
    assert.equal(getAgentIdentity()?.projectId, undefined)
  })
})

test("registered Project permissions apply to absolute paths without an active Project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-project-absolute-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readonly = join(root, "readonly")
  await mkdir(readonly)

  const registry = new ProjectRegistry(join(root, "projects.json"))
  await registry.upsert({
    id: "readonly",
    name: "Readonly",
    path: readonly,
    permissions: { read: true, write: false, shell: false },
  })
  const scope = new ProjectScope(registry)

  await runWithAgent("project-absolute-session", async () => {
    assert.equal(
      (await scope.resolvePath(join(readonly, "README.md"), "read")).project?.id,
      "readonly"
    )
    await assert.rejects(
      () => scope.resolvePath(join(readonly, "README.md"), "write"),
      /does not grant "write"/u
    )
  })
})
