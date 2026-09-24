import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { loadPublicConfig } from "./public-config.cjs"

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
)
const packageVersion =
  typeof packageMetadata.version === "string" ? packageMetadata.version : undefined
if (!packageVersion) throw new Error("package.json is missing a valid version.")

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const publicConfig = loadPublicConfig()
const rtkExecutable = resolvePathExecutable("rtk")
const brandIcon = readOptionalFile(new URL("../ui/public/openchatx-mcp-icon.png", import.meta.url))

export const MCP_CONFIG = {
  /** MCP server identity advertised to connected clients. */
  server: {
    /** MCP server name advertised during initialization. */
    name: "openchatx-mcp",
    /** MCP server version sourced from package.json. */
    version: packageVersion,
    ...(brandIcon
      ? {
          icons: [
            {
              src: `data:image/png;base64,${brandIcon.toString("base64")}`,
              mimeType: "image/png",
              sizes: ["1536x1536"],
            },
          ],
        }
      : {}),
  },
  /** Network interface used by the local MCP HTTP server. */
  host: "127.0.0.1",
  /** TCP port used by the MCP HTTP server. */
  port: publicConfig.port,
  /** Stable identity for this repository and state-directory combination. */
  instanceId: createHash("sha256")
    .update(`${repositoryRoot}\0${resolveConfiguredPath(publicConfig.state_dir)}`)
    .digest("hex"),
  /** Directory for persistent runtime state. */
  stateDir: resolveConfiguredPath(publicConfig.state_dir),
  /** Default filesystem workspace exposed to local tools. */
  workspace: resolveConfiguredPath(publicConfig.workspace),
  /** External local/remote MCP servers aggregated into the tool surface. */
  externalMcp: {
    configFile: fileURLToPath(new URL("../mcp-servers.json", import.meta.url)),
  },
  subagents: {
    configFile: fileURLToPath(new URL("../subagents.json", import.meta.url)),
  },
  /** Toolbox/plugin folders and user-authored TypeScript tools. */
  toolboxes: {
    root: fileURLToPath(new URL("../toolboxes/", import.meta.url)),
  },
  /** Public ngrok tunnel settings. */
  ngrok: {
    /** Whether openchatx-mcp should expose MCP through ngrok. */
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
    /** Enables persistent shell execution and management tools. */
    shell: publicConfig.tools.shell,
    /** Enables the first-class apply_patch file-editing tool. */
    applyPatch: publicConfig.tools.apply_patch,
    /** Enables local file export through MCP binary content. */
    fileRead: publicConfig.tools.file_read,
    /** Enables writing ChatGPT file inputs to the local filesystem. */
    fileWrite: publicConfig.tools.file_write,
    /** Enables HTTP and document fetching tools. */
    web: publicConfig.tools.web,
    /** Enables reusable workspace skill tools. */
    skills: publicConfig.tools.skills,
    /** Enables local image viewing tools. */
    image: publicConfig.tools.image,
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

function readOptionalFile(url: URL): Buffer | undefined {
  try {
    return readFileSync(url)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export function buildMcpInstructions(): string {
  return "# openchatx-mcp\n\nThis MCP acts as a connector to a fully permissioned macOS machine. This is normally a personal Mac, do not run destructive commands without explicit approval.\n\n- Call start_here exactly once per conversation before using other openchatx-mcp tools.\n- Custom toolbox and external MCP tools are lazy. Use tool_search to discover them, then tool_call with the returned id.\n- When the user asks to create or modify a plugin/toolbox/custom tool, load skill `toolbox-manager.plugin-authoring` before authoring it.\n- Use mcp_server_list and mcp_server_manage when the user asks to create, edit, enable, disable, or delete external MCP server connections.\n- Use subagent_list before delegating work so you choose among the user's curated model profiles by their descriptions; never assume a provider's unlisted models are available."
}
