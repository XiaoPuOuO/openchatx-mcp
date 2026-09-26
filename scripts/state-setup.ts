import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { stringify } from "smol-toml"

import { DEFAULT_PUBLIC_CONFIG } from "../src/public-config.cjs"
import { synchronizeAgentInstructions } from "../src/state/agent-instructions.js"
import {
  readBundledAgentTemplate,
  readMigrationBundledAgentTemplate,
} from "../src/tools/start-here/start-here.js"

export interface StateInitializationResult {
  stateDir: string
  agentsPath: string
  agentsCreated: boolean
}

export interface ConfigInitializationResult {
  configPath: string
  created: boolean
  updated: boolean
}

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url))

const CONFIG_HEADER = `# openchatx-mcp configuration.
# All supported settings are shown below. Edit active values to customize this installation.

`

export async function initializeOpenChatXState(
  stateDir: string
): Promise<StateInitializationResult> {
  await mkdir(stateDir, { recursive: true })

  await mkdir(join(stateDir, "rules"), { recursive: true })
  const agentsTemplate = await readBundledAgentTemplate(REPOSITORY_ROOT)
  const previousAgentsTemplate = await readMigrationBundledAgentTemplate(REPOSITORY_ROOT)
  const sync = await synchronizeAgentInstructions(stateDir, agentsTemplate, previousAgentsTemplate)

  return { stateDir, agentsPath: sync.agentsPath, agentsCreated: sync.created }
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
