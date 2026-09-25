import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentTeamService, type TeamExecutor } from "../src/teams/team-service.js"

test("agent teams validate profiles, persist, and run members in parallel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-teams-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: string[] = []
  const executor: TeamExecutor = {
    profiles: () => [{ id: "coder" }, { id: "reviewer" }],
    async run(input) {
      calls.push(input.profileId)
      return {
        profile: input.profileId,
        provider: "test",
        model: input.profileId,
        content: `${input.profileId} result`,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
    },
  }
  const statePath = join(root, "teams.json")
  const teams = new AgentTeamService(executor, statePath)
  await teams.upsert({
    id: "ship",
    name: "Ship Feature",
    members: [
      { profile: "coder", role: "Coder" },
      { profile: "reviewer", role: "Reviewer" },
    ],
  })
  const result = await teams.run("ship", "implement feature")
  assert.deepEqual(
    calls.sort((left, right) => left.localeCompare(right)),
    ["coder", "reviewer"]
  )
  assert.equal(result.results.length, 2)
  assert.match(result.results[0]?.content ?? "", /result/u)

  const restored = new AgentTeamService(executor, statePath)
  assert.equal((await restored.list())[0]?.id, "ship")
  await assert.rejects(
    () =>
      teams.upsert({
        id: "bad",
        name: "Bad",
        members: [{ profile: "missing", role: "Unknown" }],
      }),
    /not configured/u
  )
})
