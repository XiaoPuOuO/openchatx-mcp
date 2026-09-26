import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { getAgentIdentity, runWithAgent } from "../../src/agent/context.js"
import { MCP_CONFIG } from "../../src/config.js"
import { ProjectRegistry } from "../../src/projects/project-registry.js"
import { ProjectScope } from "../../src/projects/project-scope.js"
import { ToolboxRegistry } from "../../src/toolbox/registry.js"
import {
  buildStartHereInstructions,
  discoverPromptModes,
  readStartPrompt,
  renderStartHereTemplate,
} from "../../src/tools/start-here/start-here.js"
import { connectClient, startMcpHttpServer, toolText } from "./helpers.js"

test("renders editable AGENTS.md placeholders into start_here output", () => {
  const rendered = renderStartHereTemplate(
    [
      "mode={{MODE}}",
      "task={{TASK_ID}}",
      "{{MODE_INSTRUCTIONS}}",
      "{{PROJECT_CONTEXT}}",
      "{{GOAL_CONTEXT}}",
      "{{CAPABILITY_CATALOG}}",
      "{{ALWAYS_RULES}}",
    ].join("\n"),
    {
      mode: "coding",
      taskId: "editable-template",
      modeInstructions: "MODE BODY",
      projectContext: "PROJECT BODY",
      goalContext: "GOAL BODY",
      capabilityCatalog: "CAPABILITY BODY",
      alwaysRules: "RULE BODY",
    }
  )
  assert.equal(
    rendered,
    [
      "mode=coding",
      "task=editable-template",
      "MODE BODY",
      "PROJECT BODY",
      "GOAL BODY",
      "CAPABILITY BODY",
      "RULE BODY",
    ].join("\n")
  )
})

test("appends Goal context for older editable templates without the new placeholder", () => {
  const rendered = renderStartHereTemplate("{{MODE_INSTRUCTIONS}}", {
    mode: "coding",
    taskId: "legacy-template",
    modeInstructions: "MODE BODY",
    projectContext: "",
    goalContext: "# Tasks for this workspace session\n- [pending] ship: Ship release",
    capabilityCatalog: "",
    alwaysRules: "",
  })
  assert.match(rendered, /MODE BODY/u)
  assert.match(rendered, /Tasks for this workspace session/u)
  assert.match(rendered, /ship: Ship release/u)
})

test("start_here injects alwaysApply rule Markdown", { timeout: 10_000 }, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openchatx-rule-startup-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  const toolboxRoot = join(stateDir, "toolboxes")
  const rulesToolbox = join(toolboxRoot, "test-rules")
  const rulesRoot = join(rulesToolbox, "rules")
  const systemToolbox = join(toolboxRoot, "system")
  await mkdir(rulesRoot, { recursive: true })
  await mkdir(systemToolbox, { recursive: true })
  await writeFile(
    join(systemToolbox, "toolbox.json"),
    JSON.stringify({
      name: "System",
      enabled: true,
      builtin: "system",
      tools: { start_here: { enabled: true, required: true } },
      skills: {},
    }),
    "utf8"
  )
  await writeFile(
    join(rulesToolbox, "toolbox.json"),
    JSON.stringify({ name: "Test Rules", enabled: true, tools: {}, skills: {} }),
    "utf8"
  )
  await writeFile(
    join(rulesRoot, "always-rule.mdc"),
    "---\ndescription: Global coding rule\nalwaysApply: true\n---\n\nAlways rule body marker.\n"
  )
  await writeFile(
    join(rulesRoot, "manual-rule.mdc"),
    "---\nalwaysApply: false\n---\n\nManual rule body marker.\n"
  )

  const toolboxRegistry = new ToolboxRegistry(toolboxRoot)
  await toolboxRegistry.start()
  t.after(() => toolboxRegistry.close())

  const running = await startMcpHttpServer({ toolboxRegistry })
  t.after(() => running.close())
  const connected = await connectClient(
    running.url,
    "always-rule-startup-client",
    undefined,
    false,
    "always-rule-startup-session"
  )
  t.after(() => connected.client.close())

  const started = await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "always-rule-startup" },
  })
  const text = toolText(started)
  assert.match(text, /Always rule body marker\./u)
  assert.doesNotMatch(text, /Manual rule body marker\./u)
})

test("requires Project routing before normal work in a new session", {
  timeout: 10_000,
}, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openchatx-project-routing-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  const projectRegistry = new ProjectRegistry(join(stateDir, "projects.json"))
  const projectScope = new ProjectScope(projectRegistry)
  const running = await startMcpHttpServer({ projectRegistry, projectScope })
  t.after(() => running.close())

  const connected = await connectClient(
    running.url,
    "project-routing-client",
    undefined,
    false,
    "project-routing-session"
  )
  t.after(() => connected.client.close())

  const started = await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "route-project" },
  })
  assert.notEqual(started.isError, true)

  const blocked = await connected.client.callTool({
    name: "bash",
    arguments: { command: "pwd" },
  })
  assert.equal(blocked.isError, true)
  assert.match(toolText(blocked), /PROJECT_ROUTING_REQUIRED/u)

  const unscoped = await connected.client.callTool({
    name: "project_use",
    arguments: { project_id: null },
  })
  assert.notEqual(unscoped.isError, true)

  const allowed = await connected.client.callTool({
    name: "bash",
    arguments: { command: "pwd" },
  })
  assert.notEqual(allowed.isError, true)
})

test("requires start_here once per ChatGPT session", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
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

  const blocked = await first.client.callTool({
    name: "bash",
    arguments: { command: "printf blocked" },
  })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content.find((item) => item.type === "text")?.text ?? "", /start_here/u)

  const started = await first.client.callTool({
    name: "start_here",
    arguments: { mode: "coding", task_id: "startup-session" },
  })
  assert.equal(started.isError, undefined)
  const startInstructions = toolText(started)
  const codingPrompt = await readStartPrompt("coding")
  assert.match(startInstructions, /# OpenChatX Agent Instructions/u)
  assert.ok(startInstructions.includes(codingPrompt.prompt.trim()))
  assert.doesNotMatch(startInstructions, /\{\{MODE_INSTRUCTIONS\}\}/u)
  assert.equal(startInstructions, await buildStartHereInstructions("coding"))

  const allowed = await first.client.callTool({
    name: "bash",
    arguments: { command: "printf allowed" },
  })
  assert.equal(allowed.isError, undefined)

  const stillBlocked = await second.client.callTool({
    name: "bash",
    arguments: { command: "printf blocked" },
  })
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

test("searches skill metadata before loading full Markdown", {
  timeout: 10_000,
}, async (t) => {
  const toolboxRoot = await mkdtemp(join(tmpdir(), "openchatx-skill-search-"))
  const previousToolboxRoot = MCP_CONFIG.toolboxes.root
  MCP_CONFIG.toolboxes.root = toolboxRoot
  t.after(() => {
    MCP_CONFIG.toolboxes.root = previousToolboxRoot
    return rm(toolboxRoot, { recursive: true, force: true })
  })

  const toolboxDirectory = join(toolboxRoot, "test-skills")
  const skillDirectory = join(toolboxDirectory, "skills", "cooldown-skill")
  await mkdir(skillDirectory, { recursive: true })
  await mkdir(join(toolboxRoot, "system", "skills"), { recursive: true })
  await mkdir(join(toolboxRoot, "skills", "skills"), { recursive: true })
  await writeFile(
    join(toolboxRoot, "system", "toolbox.json"),
    JSON.stringify({
      name: "System",
      enabled: true,
      builtin: "system",
      tools: { start_here: { enabled: true, required: true } },
      skills: {},
    })
  )
  await writeFile(
    join(toolboxRoot, "skills", "toolbox.json"),
    JSON.stringify({
      name: "Skills",
      enabled: true,
      builtin: "skills",
      tools: {
        skill_search: { enabled: true },
        skill_load: { enabled: true },
        skill_manage: { enabled: true },
      },
      skills: {},
    })
  )
  await writeFile(
    join(toolboxDirectory, "toolbox.json"),
    JSON.stringify({ name: "Test Skills", enabled: true, dynamic: true, tools: {}, skills: {} })
  )
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: cooldown-skill\ndescription: Cooldown test skill for repeated work.\n---\n\n# Cooldown Skill\n\nFull instructions.\n"
  )
  const toolboxRegistry = new ToolboxRegistry(toolboxRoot)
  await toolboxRegistry.start()
  t.after(() => toolboxRegistry.close())
  const running = await startMcpHttpServer({ toolboxRegistry })
  t.after(() => running.close())
  const connected = await connectClient(
    running.url,
    "skill-search-client",
    undefined,
    false,
    "skill-search-session"
  )
  t.after(() => connected.client.close())

  const started = await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "skill-search" },
  })
  const startText = toolText(started)
  assert.doesNotMatch(startText, /cooldown-skill/u)

  const searched = await connected.client.callTool({
    name: "skill_search",
    arguments: { query: "cooldown skill" },
  })
  const searchText = toolText(searched)
  assert.match(searchText, /cooldown-skill/u)
  assert.match(searchText, /Cooldown test skill for repeated work\./u)
  assert.doesNotMatch(searchText, /Full instructions\./u)

  const firstLoad = await connected.client.callTool({
    name: "skill_load",
    arguments: { name: "test-skills.cooldown-skill" },
  })
  const secondLoad = await connected.client.callTool({
    name: "skill_load",
    arguments: { name: "test-skills.cooldown-skill" },
  })
  assert.match(toolText(firstLoad), /Full instructions\./u)
  assert.match(toolText(secondLoad), /Full instructions\./u)

  const missing = await connected.client.callTool({
    name: "skill_load",
    arguments: { name: "test-skills.missing-skill" },
  })
  assert.match(toolText(missing), /Unknown toolbox skill/u)
})

test("prefers repo-local .openchatx prompt overrides and falls back to bundled prompts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shellby-start-prompt-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const bundledPath = join(root, "src", "tools", "start-here", "prompts", "coding.md")
  const overridePath = join(root, ".openchatx", "prompts", "coding.md")
  await mkdir(join(root, "src", "tools", "start-here", "prompts"), { recursive: true })
  await mkdir(join(root, ".openchatx", "prompts"), { recursive: true })
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
  const localDirectory = join(root, ".openchatx", "prompts")
  await mkdir(bundledDirectory, { recursive: true })
  await mkdir(localDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(bundledDirectory, "coding.md"), "coding"),
    writeFile(join(bundledDirectory, "general.md"), "general"),
    writeFile(join(localDirectory, "coding.md"), "override"),
    writeFile(join(localDirectory, "deep-research.md"), "research"),
  ])

  assert.deepEqual(discoverPromptModes(root), ["coding", "deep-research", "general"])

  await writeFile(join(localDirectory, "Not-A-Mode.md"), "invalid")
  assert.throws(() => discoverPromptModes(root), /lowercase kebab-case/u)
})

test("keeps a ChatGPT session locked when start_here fails", { timeout: 10_000 }, async (t) => {
  const running = await startMcpHttpServer()
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

  const blocked = await connected.client.callTool({
    name: "bash",
    arguments: { command: "printf blocked" },
  })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content.find((item) => item.type === "text")?.text ?? "", /start_here/u)

  const retry = await connected.client.callTool({
    name: "start_here",
    arguments: { mode: "coding", task_id: "retry-startup" },
  })
  assert.equal(toolText(retry), await buildStartHereInstructions("coding"))
  const allowed = await connected.client.callTool({
    name: "bash",
    arguments: { command: "printf allowed" },
  })
  assert.equal(allowed.isError, undefined)
})

test("does not require start_here when no ChatGPT session is provided", {
  timeout: 10_000,
}, async (t) => {
  const running = await startMcpHttpServer()
  t.after(() => running.close())
  const connected = await connectClient(running.url, "startup-local-client")
  t.after(() => connected.client.close())

  const result = await connected.client.callTool({
    name: "bash",
    arguments: { command: "printf local" },
  })
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
