import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runWithAgent } from "../src/agent/context.js"
import { GoalRegistry } from "../src/goals/goal-registry.js"
import { GoalScope } from "../src/goals/goal-scope.js"
import { ProjectRegistry } from "../src/projects/project-registry.js"
import { ProjectScope } from "../src/projects/project-scope.js"

test("goal registry persists status and project association", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-goals-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statePath = join(root, "goals.json")
  const registry = new GoalRegistry(statePath)

  const created = await registry.upsert({
    id: "ship-v1",
    title: "Ship v1",
    description: "Finish the desktop release.",
    projectId: "openchatx",
  })
  assert.equal(created.status, "pending")
  assert.equal(created.projectId, "openchatx")

  const completed = await registry.update("ship-v1", { status: "completed" })
  assert.equal(completed.status, "completed")
  assert.ok(completed.completedAt)

  const restored = new GoalRegistry(statePath)
  assert.equal((await restored.get("ship-v1")).status, "completed")
  assert.equal((await restored.list({ projectId: "openchatx" })).length, 1)
})

test("goal scope returns only Goals for the current workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-goal-scope-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, "app")
  await mkdir(projectRoot)

  const projects = new ProjectRegistry(join(root, "projects.json"))
  await projects.upsert({ id: "app", name: "App", path: projectRoot })
  const projectScope = new ProjectScope(projects)
  const goals = new GoalRegistry(join(root, "goals.json"))
  await goals.upsert({
    id: "feature",
    title: "Build feature",
    projectId: "app",
  })
  await goals.upsert({
    id: "machine-task",
    title: "Configure machine",
  })
  const goalScope = new GoalScope(goals, projectScope)

  await runWithAgent("goal-session", async () => {
    assert.deepEqual(
      (await goalScope.open()).map((goal) => goal.id),
      ["machine-task"]
    )
    await assert.rejects(() => goalScope.get("feature"), /not available in an unscoped session/u)
    await projectScope.use("app")
    assert.deepEqual(
      (await goalScope.open()).map((goal) => goal.id),
      ["feature"]
    )
    assert.equal((await goalScope.get("feature")).id, "feature")
    const created = await goalScope.create({ id: "feature-2", title: "Build second feature" })
    assert.equal(created.projectId, "app")
    await projectScope.use(undefined)
    assert.deepEqual(
      (await goalScope.open()).map((goal) => goal.id),
      ["machine-task"]
    )
  })
})
