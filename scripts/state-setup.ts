import { constants } from "node:fs"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { stringify } from "smol-toml"

import { DEFAULT_PUBLIC_CONFIG } from "../src/public-config.cjs"

export interface StateInitializationResult {
  stateDir: string
  agentsPath: string
  starterSkillPath: string
  agentsCreated: boolean
  starterSkillCreated: boolean
}

export interface ConfigInitializationResult {
  configPath: string
  created: boolean
  updated: boolean
}

const STARTER_SKILL_SOURCE = fileURLToPath(
  new URL("../skills/create-skill/SKILL.md", import.meta.url)
)
const AGENTS_TEMPLATE_SOURCE = fileURLToPath(
  new URL("../src/tools/start-here/AGENTS.template.md", import.meta.url)
)
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url))

const CONFIG_HEADER = `# openchatx-mcp configuration.
# All supported settings are shown below. Edit active values to customize this installation.

`

const LEGACY_STARTER_AGENTS_MD = `# OpenChatX Agent Instructions

This file contains persistent instructions for OpenChatX. Customize it for your preferences.

- Read and follow project-local \`AGENTS.md\` files and relevant project documentation before editing a repository.
- Keep existing projects in their current locations.
- Prefer more-specific project instructions when they conflict with this file.
`

export async function initializeOpenChatXState(
  stateDir: string
): Promise<StateInitializationResult> {
  await mkdir(stateDir, { recursive: true })

  const agentsPath = join(stateDir, "AGENTS.md")
  const starterSkillPath = join(stateDir, "skills", "create-skill", "SKILL.md")
  await mkdir(dirname(starterSkillPath), { recursive: true })
  await mkdir(join(stateDir, "rules"), { recursive: true })

  let agentsCreated = false
  const agentsTemplate = await readFile(AGENTS_TEMPLATE_SOURCE, "utf8")
  try {
    await writeFile(agentsPath, agentsTemplate, { encoding: "utf8", flag: "wx" })
    agentsCreated = true
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error
    const existing = await readFile(agentsPath, "utf8")
    if (existing === LEGACY_STARTER_AGENTS_MD) {
      await writeFile(agentsPath, agentsTemplate, "utf8")
    }
  }

  let starterSkillCreated = false
  try {
    await copyFile(STARTER_SKILL_SOURCE, starterSkillPath, constants.COPYFILE_EXCL)
    starterSkillCreated = true
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error
  }
  return { stateDir, agentsPath, starterSkillPath, agentsCreated, starterSkillCreated }
}

export async function initializeOpenChatXConfig(
  repositoryRoot = REPOSITORY_ROOT
): Promise<ConfigInitializationResult> {
  const configPath = join(repositoryRoot, ".openchatx", "config.toml")
  await mkdir(dirname(configPath), { recursive: true })

  try {
    await writeFile(configPath, serializeConfig(DEFAULT_PUBLIC_CONFIG), {
      encoding: "utf8",
      flag: "wx",
    })
    return { configPath, created: true, updated: false }
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error
  }

  // Runtime supplies missing defaults; preserve existing comments, formatting, and values.
  return { configPath, created: false, updated: false }
}

function serializeConfig(config: typeof DEFAULT_PUBLIC_CONFIG): string {
  const { tools: _legacyTools, ...visibleConfig } = config
  return `${CONFIG_HEADER}${stringify(visibleConfig)}\n`
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
