import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { getAgentIdentity, runWithAgent } from "../../src/agent/context.js"
import { MCP_CONFIG } from "../../src/config.js"
import { createShellSession } from "../../src/tools/shell/session.js"
import { createShellSessionManager } from "../../src/tools/shell/session-manager.js"
import {
  buildStartHereInstructions,
  discoverPromptModes,
  readStartPrompt,
} from "../../src/tools/start-here/start-here.js"
import { connectClient, startMcpHttpServer, toolText } from "./helpers.js"

test("requires start_here once per ChatGPT session", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "shellby-start-here-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const running = await startMcpHttpServer({
    shellManager: createShellSessionManager({
      defaultShell: createShellSession({ cwd: workspace }),
    }),
  })
  t.after(() => running.close())

  const first = await connectClient(
    running.url,
    "startup-first",
    undefined,
    false,
    "startup-session-a"
  )
  const second = await connectClient(
    running.url,
    "startup-second",
    undefined,
    false,
    "startup-session-b"
  )
  t.after(() => Promise.all([first.client.close(), second.client.close()]))

  const blocked = await first.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content.find((item) => item.type === "text")?.text ?? "", /start_here/u)

  const started = await first.client.callTool({
    name: "start_here",
    arguments: { mode: "coding", task_id: "startup-session" },
  })
  assert.equal(started.isError, undefined)
  const startInstructions = toolText(started)
  const [sharedPrompt, codingPrompt] = await Promise.all([
    readStartPrompt("shared"),
    readStartPrompt("coding"),
  ])
  assert.ok(
    startInstructions.indexOf(sharedPrompt.prompt.trim()) <
      startInstructions.indexOf(codingPrompt.prompt.trim())
  )
  assert.equal(startInstructions, await buildStartHereInstructions("coding"))

  const allowed = await first.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(allowed.isError, undefined)

  const stillBlocked = await second.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(stillBlocked.isError, true)
})

test("suppresses duplicate start_here modes for five seconds per agent", {
  timeout: 10_000,
}, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const first = await connectClient(
    running.url,
    "start-cooldown-first",
    undefined,
    false,
    "start-cooldown-session-a"
  )
  const second = await connectClient(
    running.url,
    "start-cooldown-second",
    undefined,
    false,
    "start-cooldown-session-b"
  )
  t.after(() => Promise.all([first.client.close(), second.client.close()]))

  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  const codingInstructions = await buildStartHereInstructions("coding")
  const simultaneous = await Promise.all([
    first.client.callTool({
      name: "start_here",
      arguments: { mode: "coding", task_id: "initial-task" },
    }),
    first.client.callTool({
      name: "start_here",
      arguments: { mode: "coding", task_id: "renamed-task" },
    }),
  ])
  assert.ok(simultaneous.every((result) => !result.isError))
  const simultaneousText = simultaneous.map(toolText)
  assert.equal(simultaneousText.filter((text) => text === codingInstructions).length, 1)
  assert.equal(
    simultaneousText.filter((text) => /loaded recently by this agent/u.test(text)).length,
    1
  )

  now += 4_999
  const duplicate = await first.client.callTool({
    name: "start_here",
    arguments: { mode: "coding", task_id: "updated-task" },
  })
  assert.match(toolText(duplicate), /loaded recently by this agent/u)
  assert.equal(
    runWithAgent("start-cooldown-session-a", () => getAgentIdentity()?.taskSlug),
    "updated-task"
  )

  const otherMode = await first.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "general-task" },
  })
  assert.equal(toolText(otherMode), await buildStartHereInstructions("general"))
  const otherAgent = await second.client.callTool({
    name: "start_here",
    arguments: { mode: "coding", task_id: "other-task" },
  })
  assert.equal(toolText(otherAgent), codingInstructions)

  now += 1
  const expired = await first.client.callTool({
    name: "start_here",
    arguments: { mode: "coding", task_id: "after-cooldown" },
  })
  assert.equal(toolText(expired), codingInstructions)
})

test("suppresses rapid duplicate skill loads for the same agent", {
  timeout: 10_000,
}, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "shellby-skill-cooldown-"))
  const previousWorkspace = MCP_CONFIG.workspace
  MCP_CONFIG.workspace = workspace
  t.after(() => {
    MCP_CONFIG.workspace = previousWorkspace
    return rm(workspace, { recursive: true, force: true })
  })

  const skillDirectory = join(workspace, "skills", "cooldown-skill")
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: cooldown-skill\ndescription: Cooldown test skill.\n---\n\n# Cooldown Skill\n\nFull instructions.\n"
  )

  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(
    running.url,
    "skill-cooldown-client",
    undefined,
    false,
    "skill-cooldown-session"
  )
  t.after(() => connected.client.close())

  await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "skill-cooldown" },
  })

  const simultaneous = await Promise.all([
    connected.client.callTool({ name: "skill_load", arguments: { name: "cooldown-skill" } }),
    connected.client.callTool({ name: "skill_load", arguments: { name: "cooldown-skill" } }),
  ])
  const simultaneousText = simultaneous.map(toolText)
  assert.equal(simultaneousText.filter((text) => /Full instructions\./u.test(text)).length, 1)
  assert.equal(
    simultaneousText.filter((text) => /loaded recently by this agent/u.test(text)).length,
    1
  )

  const duplicate = await connected.client.callTool({
    name: "skill_load",
    arguments: { name: "cooldown-skill" },
  })
  assert.match(toolText(duplicate), /loaded recently by this agent/u)

  const firstMissing = await connected.client.callTool({
    name: "skill_load",
    arguments: { name: "missing-skill" },
  })
  const retryMissing = await connected.client.callTool({
    name: "skill_load",
    arguments: { name: "missing-skill" },
  })
  assert.match(toolText(firstMissing), /unknown_skill/u)
  assert.match(toolText(retryMissing), /unknown_skill/u)
})

test("prefers repo-local .shellby prompt overrides and falls back to bundled prompts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-start-prompt-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const bundledPath = join(root, "src", "tools", "start-here", "prompts", "coding.md")
  const overridePath = join(root, ".shellby", "prompts", "coding.md")
  await mkdir(join(root, "src", "tools", "start-here", "prompts"), { recursive: true })
  await mkdir(join(root, ".shellby", "prompts"), { recursive: true })
  await writeFile(bundledPath, "bundled")
  await writeFile(overridePath, "override")

  assert.deepEqual(await readStartPrompt("coding", root), {
    path: overridePath,
    prompt: "override",
  })

  await rm(overridePath)
  assert.deepEqual(await readStartPrompt("coding", root), { path: bundledPath, prompt: "bundled" })
})

test("derives start_here modes from bundled and local prompt filename slugs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-start-modes-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const bundledDirectory = join(root, "src", "tools", "start-here", "prompts")
  const localDirectory = join(root, ".shellby", "prompts")
  await mkdir(bundledDirectory, { recursive: true })
  await mkdir(localDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(bundledDirectory, "coding.md"), "coding"),
    writeFile(join(bundledDirectory, "general.md"), "general"),
    writeFile(join(bundledDirectory, "shared.md"), "shared"),
    writeFile(join(localDirectory, "coding.md"), "override"),
    writeFile(join(localDirectory, "deep-research.md"), "research"),
  ])

  assert.deepEqual(discoverPromptModes(root), ["coding", "deep-research", "general"])

  await writeFile(join(localDirectory, "Not-A-Mode.md"), "invalid")
  assert.throws(() => discoverPromptModes(root), /lowercase kebab-case/u)
})

test("keeps a ChatGPT session locked when start_here fails", { timeout: 10_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "shellby-start-here-missing-"))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const running = await startMcpHttpServer({
    shellManager: createShellSessionManager({
      defaultShell: createShellSession({ cwd: workspace }),
    }),
  })
  t.after(() => running.close())
  const connected = await connectClient(
    running.url,
    "startup-failure",
    undefined,
    false,
    "startup-session-failure"
  )
  t.after(() => connected.client.close())

  const failed = await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "invalid", task_id: "invalid-mode" },
  })
  assert.equal(failed.isError, true)

  const blocked = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content.find((item) => item.type === "text")?.text ?? "", /start_here/u)

  const retry = await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "coding", task_id: "retry-startup" },
  })
  assert.equal(toolText(retry), await buildStartHereInstructions("coding"))
  const allowed = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(allowed.isError, undefined)
})

test("does not require start_here when no ChatGPT session is provided", {
  timeout: 10_000,
}, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "startup-local-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({ name: "shell_list", arguments: {} })
  assert.equal(result.isError, undefined)

  const instructions = await buildStartHereInstructions("coding")
  for (let call = 0; call < 2; call += 1) {
    const started = await connected.client.callTool({
      name: "start_here",
      arguments: { mode: "coding", task_id: "local-startup" },
    })
    assert.equal(toolText(started), instructions)
  }
})
