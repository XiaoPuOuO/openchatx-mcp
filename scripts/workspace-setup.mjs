import { constants } from "node:fs"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { parse, stringify } from "smol-toml"

const STARTER_SKILL_SOURCE = fileURLToPath(new URL("../skills/create-skill/SKILL.md", import.meta.url))
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url))

const DEFAULT_PUBLIC_CONFIG = {
  workspace: "~/Desktop/agent-workspace",
  shell: {
    path: "/bin/zsh",
    rtk: false,
  },
  chatgpt: {
    cdp_endpoint: "http://127.0.0.1:9222",
    project_url: "https://chatgpt.com/",
    max_delegated_agents: 3,
  },
  ngrok: {
    pooling_enabled: false,
  },
  mcp: {
    tool_output: "compact",
  },
  ui: {
    enabled: false,
  },
  tools: {
    review: true,
    shell: true,
    apply_patch: true,
    clones: true,
    subagents: true,
    web: true,
    skills: true,
    image: true,
    computer: true,
  },
}

const CONFIG_HEADER = `# Shellby configuration.
# All supported settings are shown below. Edit active values to customize this installation.
# Settings without defaults are commented examples; uncomment and customize them to enable.

`

const STARTER_AGENTS_MD = `# Workspace Instructions

This file contains persistent instructions for coding work in this workspace. Customize it for your preferences.

- Read and follow project-local \`AGENTS.md\` files and relevant project documentation before editing a repository.
- Keep existing projects in their current locations.
- Create or clone new projects in this workspace unless the user asks for another location.
- Prefer more-specific project instructions when they conflict with this file.
`

export async function initializeWorkspace(workspace) {
  await mkdir(workspace, { recursive: true })

  const agentsPath = join(workspace, "AGENTS.md")
  const starterSkillPath = join(workspace, "skills", "create-skill", "SKILL.md")
  await mkdir(dirname(starterSkillPath), { recursive: true })

  let agentsCreated = false
  try {
    await writeFile(agentsPath, STARTER_AGENTS_MD, { encoding: "utf8", flag: "wx" })
    agentsCreated = true
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }

  let starterSkillCreated = false
  try {
    await copyFile(STARTER_SKILL_SOURCE, starterSkillPath, constants.COPYFILE_EXCL)
    starterSkillCreated = true
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }

  return { workspace, agentsPath, starterSkillPath, created: agentsCreated, starterSkillCreated }
}

export async function initializeShellbyConfig(repositoryRoot = REPOSITORY_ROOT) {
  const configPath = join(repositoryRoot, ".shellby", "config.toml")
  await mkdir(dirname(configPath), { recursive: true })

  try {
    await writeFile(configPath, serializeConfig(DEFAULT_PUBLIC_CONFIG), { encoding: "utf8", flag: "wx" })
    return { configPath, created: true, updated: false }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }

  const existing = parse(await readFile(configPath, "utf8"))
  const complete = fillMissingConfig(existing, DEFAULT_PUBLIC_CONFIG)
  const updated = JSON.stringify(existing) !== JSON.stringify(complete)
  if (updated) await writeFile(configPath, serializeConfig(complete), "utf8")
  return { configPath, created: false, updated }
}

function fillMissingConfig(current, defaults) {
  if (!isRecord(current) || !isRecord(defaults)) return current ?? defaults

  const complete = { ...current }
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in complete)) {
      complete[key] = defaultValue
      continue
    }
    if (isRecord(complete[key]) && isRecord(defaultValue)) {
      complete[key] = fillMissingConfig(complete[key], defaultValue)
    }
  }
  return complete
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serializeConfig(config) {
  let body = stringify(config)
  if (isRecord(config.ngrok) && !("url" in config.ngrok)) {
    body = body.replace(
      "[ngrok]\n",
      '[ngrok]\n# Optional reserved endpoint; leave commented to let ngrok assign the public URL.\n# url = "https://your-reserved-domain.ngrok.app"\n'
    )
  }
  return `${CONFIG_HEADER}${body}\n`
}
