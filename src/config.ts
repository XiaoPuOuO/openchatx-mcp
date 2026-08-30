import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const bundledPeekabooExecutable = fileURLToPath(new URL("../vendor/peekaboo/peekaboo", import.meta.url))
const peekabooExecutable = process.env.MCP_PEEKABOO_BIN?.trim() || bundledPeekabooExecutable
/**
 * ToolOutputStructuredMode is a enum that describes the structured mode of the tool output.
 * - always: the tool output is always structured. Includes output schemas.
 * - optional: the caller can request full structured tool output with a tool-call argument. Public output schemas remain omitted.
 * - never: the tool output is never structured. Output schemas are omitted.
 */
export type ToolOutputStructuredMode = "always" | "optional" | "never"

export const MCP_CONFIG = {
  server: {
    name: "shellby-mcp",
    version: "0.1.0",
    icons: [
      {
        src: `data:image/png;base64,${readFileSync(new URL("../docs/assets/icon-80_square-compressed.png", import.meta.url)).toString("base64")}`,
        mimeType: "image/png",
        sizes: ["80x80"],
      },
    ],
  },
  toolMeta: {
    securitySchemes: [{ type: "noauth" }],
  },
  host: "127.0.0.1",
  port: 3333,
  workspace: resolveWorkspacePath(process.env.MCP_CWD ?? "~/Desktop/agent-workspace"),
  peekaboo: {
    executable: peekabooExecutable,
    cursorHostExecutable: join(dirname(peekabooExecutable), "peekaboo-cursor-host"),
  },
  chatGpt: {
    cdpEndpoint: process.env.MCP_CHATGPT_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
    projectUrl: process.env.MCP_CHATGPT_PROJECT_URL?.trim() || undefined,
    defaultOververbosity: 2,
    defaultPollWaitMs: 30_000,
    maxPollWaitMs: 270_000,
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
  toolOutputStructured: "never" as ToolOutputStructuredMode,
  shell: {
    path: process.env.MCP_SHELL ?? "/bin/zsh",
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
    defaultWaitMs: 3_000,
    maxWaitMs: 10_000,
    defaultPollWaitMs: 2_000,
    maxPollWaitMs: 270_000,
    readyTimeoutMs: 10_000,
    stopGraceMs: 500,
    recordLimit: 1_024,
    maxShells: 8,
    idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
    cacheTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
  },
  ios: {
    host: process.env.MCP_IOS_HOST,
    port: 8765,
    tokenFile: process.env.MCP_IOS_TOKEN_FILE,
    timeoutMs: 5_000,
  },
}

function resolveWorkspacePath(configured: string): string {
  if (configured === "~") return homedir()
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2))
  return resolve(configured)
}

export function buildMcpInstructions(workspacePath: string): string {
  const workspace = JSON.stringify(workspacePath)
  return `# Agent harness

This MCP server provides shell, apply_patch, sub-agent, fetch_url, computer-use and more. Unless the user specifies otherwise, create or clone new projects only under the default workspace: \`${workspace}\`.

- When coding in a repository, read the project's \`**/AGENTS.md\` and follow its instructions.
- Prefer \`rtk\` over \`rg\` for filesystem search, listing, reading, linting, testing, and more.
- Scope and byte-cap shell commands whose output may be large or unknown.
- Run independent shell commands in parallel using \`shell_run.commands\` when possible.
- Use \`apply_patch\` for all file modifications.`
}
