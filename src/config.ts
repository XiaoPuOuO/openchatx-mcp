import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { loadPublicConfig } from "./public-config.cjs"

export { loadPublicConfig, type ToolOutputFormat } from "./public-config.cjs"

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const packageVersion = typeof packageMetadata.version === "string" ? packageMetadata.version : undefined
if (!packageVersion) throw new Error("package.json is missing a valid version.")

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const bundledPeekabooExecutable = fileURLToPath(new URL("../vendor/peekaboo/peekaboo", import.meta.url))
const publicConfig = loadPublicConfig()
const rtkExecutable = resolvePathExecutable("rtk")

export const MCP_CONFIG = {
  server: {
    name: "shellby-mcp",
    version: packageVersion,
    // icons: [
    //   {
    //     src: `data:image/png;base64,${readFileSync(new URL("../docs/assets/icon-80_square-compressed.png", import.meta.url)).toString("base64")}`,
    //     mimeType: "image/png",
    //     sizes: ["80x80"],
    //   },
    // ],
  },
  host: "127.0.0.1",
  port: publicConfig.port,
  instanceId: createHash("sha256")
    .update(`${repositoryRoot}\0${resolveConfiguredPath(publicConfig.state_dir)}`)
    .digest("hex"),
  stateDir: resolveConfiguredPath(publicConfig.state_dir),
  workspace: resolveConfiguredPath(publicConfig.workspace),
  peekaboo: {
    executable: bundledPeekabooExecutable,
    cursorHostExecutable: join(dirname(bundledPeekabooExecutable), "peekaboo-cursor-host"),
  },
  chatGpt: {
    cdpEndpoint: publicConfig.chatgpt.cdp_endpoint,
    projectUrl: publicConfig.chatgpt.project_url,
    maxDelegatedAgents: publicConfig.chatgpt.max_delegated_agents,
    defaultPollWaitMs: 30_000,
    maxPollWaitMs: 270_000,
  },
  ngrok: {
    enabled: publicConfig.ngrok.enabled,
    apiPort: publicConfig.ngrok.api_port,
    url: publicConfig.ngrok?.url,
    poolingEnabled: publicConfig.ngrok?.pooling_enabled ?? false,
  },
  mcp: {
    toolOutput: publicConfig.mcp.tool_output,
  },
  ui: {
    enabled: publicConfig.ui.enabled,
  },
  web: {
    defaultFormat: "markdown" as const,
    defaultOutputTokens: 8_192,
    maxOutputTokens: 32_768,
    documentByteLimit: 2 * 1024 * 1024,
    resourceByteLimit: 16 * 1024 * 1024,
    documentTtlMs: 10 * 60 * 1_000,
    documentLimit: 20,
  },
  shell: {
    path: publicConfig.shell.path,
    rtk: publicConfig.shell.rtk,
    rtkExecutable,
    // Rolling shell-wide stdout/stderr retention used by cursor-based shell_poll.
    // This is a server-memory/history bound, not a model-output limit.
    transcriptChars: 1024 * 1024,
    // Maximum stdout/stderr retained for any one command before additional output
    // is permanently dropped. This prevents a noisy command from consuming the
    // entire shell transcript. Parallel child commands use this limit too.
    commandTranscriptBytes: 256 * 1024,
    // Token ceiling for text returned to the model in one shell_run/shell_poll call.
    // Additional retained output can be retrieved with shell_poll and next_cursor.
    defaultOutputTokens: 1_024,
    // Largest model-output token budget a caller may explicitly request per call.
    maxOutputTokens: 16_384,
    defaultWaitMs: 10_000,
    maxWaitMs: 10_000,
    defaultPollWaitMs: 40_000,
    maxPollWaitMs: 270_000,
    readyTimeoutMs: 10_000,
    stopGraceMs: 500,
    recordLimit: 1_024,
    maxShells: 8,
    idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
    cacheTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
  },
  tools: {
    review: publicConfig.tools.review,
    shell: publicConfig.tools.shell,
    applyPatch: publicConfig.tools.apply_patch,
    clones: publicConfig.tools.clones,
    subagents: publicConfig.tools.subagents,
    web: publicConfig.tools.web,
    skills: publicConfig.tools.skills,
    image: publicConfig.tools.image,
    computer: publicConfig.tools.computer,
  },
}

function resolveConfiguredPath(configured: string): string {
  if (configured === "~") return homedir()
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2))
  return resolve(repositoryRoot, configured)
}

function resolvePathExecutable(name: string): string | undefined {
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" })
  if (result.error || result.status !== 0) return undefined
  const executable = result.stdout.trim()
  return executable || undefined
}

export function buildMcpInstructions(): string {
  return `# Shellby MCP\n\nThis MCP acts as a connector to a fully permissioned macOS machine. This is normally a personal Mac, do not run destructive commands without explicit approval.\n\n- Call start_here exactly once per conversation before using other Shellby tools.
- Do not use ChatGPT's internal container or sandbox for paths under \`/Users/...\` or for work intended to affect the user's local machine; use Shellby MCP instead.`
}
