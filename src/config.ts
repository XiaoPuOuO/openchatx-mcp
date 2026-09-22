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
  /** MCP server identity advertised to connected clients. */
  server: {
    /** MCP server name advertised during initialization. */
    name: "shellby-mcp",
    /** MCP server version sourced from package.json. */
    version: packageVersion,
    // icons: [
    //   {
    //     src: `data:image/png;base64,${readFileSync(new URL("../docs/assets/icon-80_square-compressed.png", import.meta.url)).toString("base64")}`,
    //     mimeType: "image/png",
    //     sizes: ["80x80"],
    //   },
    // ],
  },
  /** Network interface used by the local MCP HTTP server. */
  host: "127.0.0.1",
  /** TCP port used by the MCP HTTP server. */
  port: publicConfig.port,
  /** Stable identity for this repository and state-directory combination. */
  instanceId: createHash("sha256")
    .update(`${repositoryRoot}\0${resolveConfiguredPath(publicConfig.state_dir)}`)
    .digest("hex"),
  /** Directory for Shellby's persistent runtime state. */
  stateDir: resolveConfiguredPath(publicConfig.state_dir),
  /** Default filesystem workspace exposed to Shellby tools. */
  workspace: resolveConfiguredPath(publicConfig.workspace),
  /** Executables used by local computer-control tools. */
  peekaboo: {
    /** Bundled Peekaboo CLI executable. */
    executable: bundledPeekabooExecutable,
    /** Companion process used to control the physical cursor. */
    cursorHostExecutable: join(dirname(bundledPeekabooExecutable), "peekaboo-cursor-host"),
  },
  /** Browser-backed ChatGPT delegation settings. */
  chatGpt: {
    /** Chrome DevTools endpoint used to control the ChatGPT browser session. */
    cdpEndpoint: publicConfig.chatgpt.cdp_endpoint,
    /** ChatGPT project URL opened for delegated agents. */
    projectUrl: publicConfig.chatgpt.project_url,
    /** Maximum delegated ChatGPT agents allowed at once. */
    maxDelegatedAgents: publicConfig.chatgpt.max_delegated_agents,
    /** Default wait before a delegated-agent poll returns while still running. */
    defaultPollWaitMs: 30_000,
    /** Maximum delegated-agent poll wait accepted from callers. */
    maxPollWaitMs: 270_000,
  },
  /** Public ngrok tunnel settings. */
  ngrok: {
    /** Whether Shellby should expose MCP through ngrok. */
    enabled: publicConfig.ngrok.enabled,
    /** Local ngrok API port used to inspect active tunnels. */
    apiPort: publicConfig.ngrok.api_port,
    /** Optional configured public ngrok URL. */
    url: publicConfig.ngrok?.url,
    /** Whether ngrok endpoint pooling is enabled. */
    poolingEnabled: publicConfig.ngrok?.pooling_enabled ?? false,
  },
  /** MCP protocol presentation settings. */
  mcp: {
    /** Representation used for ordinary MCP tool results. */
    toolOutput: publicConfig.mcp.tool_output,
  },
  /** Shellby dashboard settings. */
  ui: {
    /** Whether the local Shellby UI is served. */
    enabled: publicConfig.ui.enabled,
  },
  /** HTTP and document-fetching limits. */
  web: {
    /** Default text format returned by fetch_url. */
    defaultFormat: "markdown" as const,
    /** Default model-output token budget for one fetch_url response. */
    defaultOutputTokens: 8000,
    /** Maximum model-output token budget a fetch_url caller may request. */
    maxOutputTokens: 32000,
    /** Maximum extracted document bytes retained for cursor continuation. */
    documentByteLimit: 2 * 1024 * 1024,
    /** Maximum downloaded resource size accepted before extraction. */
    resourceByteLimit: 16 * 1024 * 1024,
    /** Time a cached fetched document remains available for cursor reads. */
    documentTtlMs: 10 * 60 * 1_000,
    /** Maximum number of fetched documents retained in the cache. */
    documentLimit: 20,
  },
  /** Persistent shell execution, output, and lifecycle settings. */
  shell: {
    /** Shell executable used for persistent command sessions. */
    path: publicConfig.shell.path,
    /** Whether supported shell commands are rewritten through RTK. */
    rtk: publicConfig.shell.rtk,
    /** RTK executable resolved from PATH when available. */
    rtkExecutable,
    /** Rolling shell-wide character retention available to shell_poll cursors. */
    transcriptChars: 1024 * 1024,
    /** Maximum stdout/stderr bytes retained for one command before excess is dropped. */
    commandTranscriptBytes: 256 * 1024,
    /** Default model-output token budget for one shell_run or shell_poll response. */
    defaultOutputTokens: 2_000,
    /** Maximum model-output token budget a shell caller may request per response. */
    maxOutputTokens: 18_000,
    /** Default time shell_run waits before returning a still-running command. */
    defaultWaitMs: 10_000,
    /** Maximum shell_run wait accepted from callers. */
    maxWaitMs: 270_000,
    /** Default time shell_poll waits for additional output or completion. */
    defaultPollWaitMs: 40_000,
    /** Maximum shell_poll wait accepted from callers. */
    maxPollWaitMs: 270_000,
    /** Maximum time allowed for a newly created shell to become ready. */
    readyTimeoutMs: 10_000,
    /** Grace period before force-killing a shell process that did not stop. */
    stopGraceMs: 500,
    /** Maximum completed command records retained per shell for lookup and polling. */
    recordLimit: 1_024,
    /** Maximum number of simultaneously retained shell sessions. */
    maxShells: 8,
    /** Idle time before a named shell is hibernated or evicted. */
    idleTimeoutMs: 5 * 60 * 1000,
    /** Time cached shell state remains restorable after hibernation. */
    cacheTimeoutMs: 24 * 60 * 60 * 1000,
  },
  /** Feature flags controlling which MCP tool groups are registered. */
  tools: {
    /** Enables the Shellby feedback submission tool. */
    review: publicConfig.tools.review,
    /** Enables persistent shell execution and management tools. */
    shell: publicConfig.tools.shell,
    /** Enables the first-class apply_patch file-editing tool. */
    applyPatch: publicConfig.tools.apply_patch,
    /** Enables self-cloning agent tools. */
    clones: publicConfig.tools.clones,
    /** Enables delegated ChatGPT subagent tools. */
    subagents: publicConfig.tools.subagents,
    /** Enables HTTP and document fetching tools. */
    web: publicConfig.tools.web,
    /** Enables reusable workspace skill tools. */
    skills: publicConfig.tools.skills,
    /** Enables local image viewing tools. */
    image: publicConfig.tools.image,
    /** Enables macOS computer-control tools. */
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
- Every Shellby tool except start_here accepts \`then_run\`. Set it to exactly one nested Shellby tool call, for example \`{"then_run":{"shell_list":{... then_run:{call}}}}\`. Nested calls may contain their own \`then_run\` and execute sequentially after each preceding tool call succeeds.`
}
