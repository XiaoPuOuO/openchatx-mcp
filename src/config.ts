import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { hostDisplayName, resolveConfiguredShell, resolvePathExecutable } from "./host-platform.js"
import { loadPublicConfig } from "./public-config.cjs"

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
)
const packageVersion =
  typeof packageMetadata.version === "string" ? packageMetadata.version : undefined
if (!packageVersion) throw new Error("package.json is missing a valid version.")

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const publicConfig = loadPublicConfig()
const stateDir = resolveConfiguredPath(publicConfig.state_dir)
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
  instanceId: createHash("sha256").update(`${repositoryRoot}\0${stateDir}`).digest("hex"),
  /** Directory for persistent runtime state. */
  stateDir,
  /** Default cwd/root for relative shell and filesystem tool paths. */
  defaultCwd: homedir(),
  /** Persistent user-authored agent instructions. */
  agentInstructionsFile: join(stateDir, "AGENTS.md"),
  /** Persistent reusable skills owned by this OpenChatX installation. */
  skills: {
    root: join(stateDir, "skills"),
  },
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
  /** OpenAI Secure MCP Tunnel client settings. */
  tunnel: {
    /** tunnel-client profile initialized for this OpenChatX installation. */
    profile: publicConfig.tunnel.profile,
    /** Local tunnel-client health/admin UI port. */
    healthPort: publicConfig.tunnel.health_port,
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
  /** Shell and terminal execution settings. */
  shell: {
    /** Shell executable used by bash and terminal tools. */
    path: resolveConfiguredShell(publicConfig.shell.path),
    /** Whether supported shell commands are rewritten through RTK. */
    rtk: publicConfig.shell.rtk,
    /** RTK executable resolved from PATH when available. */
    rtkExecutable,
    /** Rolling character retention used by interactive terminal sessions. */
    transcriptChars: 1024 * 1024,
    /** Default model-output token budget for bash/terminal responses. */
    defaultOutputTokens: 2_000,
    /** Maximum model-output token budget a bash/terminal caller may request. */
    maxOutputTokens: 18_000,
    /** Maximum time allowed for a newly created terminal to become ready. */
    readyTimeoutMs: 10_000,
    /** Grace period before force-killing a terminal process that did not stop. */
    stopGraceMs: 500,
  },
  /** Feature flags controlling which MCP tool groups are registered. */
  tools: {
    /** Enables bash and terminal tools. */
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
  if (configured.startsWith("~/") || configured.startsWith("~\\"))
    return join(homedir(), configured.slice(2))
  return resolve(repositoryRoot, configured)
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
  const host = hostDisplayName()
  return (
    "# openchatx-mcp\n\nThis MCP acts as a connector to a fully permissioned " +
    host +
    " machine. This is normally a personal computer, do not run destructive commands without explicit approval.\n\n" +
    "# Tool routing\n\n" +
    "- Prefer the most specific OpenChatX tool over bash when both can perform the task.\n" +
    "- Known file or directory path: use file_read.\n" +
    "- Filename or path discovery: use glob. Do not use bash find or recursive ls for ordinary discovery.\n" +
    "- Search inside file contents: use grep. Do not use bash grep or rg for ordinary content search.\n" +
    "- Localized text edit: use file_edit after reading the relevant current content.\n" +
    "- New file or intentional whole-file replacement: use file_write.\n" +
    "- Use bash for genuine shell work such as builds, tests, git, package managers, processes, networking, permissions, pipelines, or capabilities the dedicated tools do not expose.\n\n" +
    "# Runtime\n\n" +
    "- Call start_here exactly once per conversation before using other openchatx-mcp tools.\n" +
    "- Custom toolbox and external MCP tools are lazy. Use tool_search to discover them, then tool_call with the returned id.\n" +
    "- When the user asks to create or modify a plugin/toolbox/custom tool, load skill `toolbox-manager.plugin-authoring` before authoring it.\n" +
    "- Use mcp_server_list and mcp_server_manage when the user asks to create, edit, enable, disable, or delete external MCP server connections.\n" +
    "- Use subagent_list before delegating work so you choose among the user's curated model profiles by their descriptions; never assume a provider's unlisted models are available."
  )
}
