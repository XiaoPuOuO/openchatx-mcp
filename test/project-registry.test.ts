import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ProjectRegistry } from "../src/projects/project-registry.js"

test("project registry persists roots and enforces scoped permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-projects-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, "demo")
  const assetsRoot = join(root, "demo-assets")
  const { mkdir } = await import("node:fs/promises")
  await Promise.all([mkdir(projectRoot), mkdir(assetsRoot)])
  const statePath = join(root, "state", "projects.json")
  const registry = new ProjectRegistry(statePath)
  const project = await registry.upsert({
    id: "demo",
    name: "Demo",
    path: projectRoot,
    additionalPaths: [assetsRoot],
    permissions: { read: true, write: false, shell: false },
  })
  assert.equal(project.path, projectRoot)
  assert.deepEqual(project.additionalPaths, [assetsRoot])
  assert.equal((await registry.findForPath(join(assetsRoot, "logo.png")))?.id, "demo")
  assert.equal((await registry.resolve("demo", "read")).id, "demo")
  await assert.rejects(() => registry.resolve("demo", "write"), /does not grant/u)
  await assert.rejects(
    () =>
      registry.upsert({
        id: "duplicate",
        name: "Duplicate",
        path: projectRoot,
      }),
    /already registered/u
  )

  const restored = new ProjectRegistry(statePath)
  const restoredProject = await restored.get("demo")
  assert.equal(restoredProject.permissions.shell, false)
  assert.deepEqual(restoredProject.additionalPaths, [assetsRoot])
})
