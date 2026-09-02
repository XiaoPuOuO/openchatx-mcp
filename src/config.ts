import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parse } from "smol-toml"
import { z } from "zod"

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const packageVersion = typeof packageMetadata.version === "string" ? packageMetadata.version : undefined
if (!packageVersion) throw new Error("package.json is missing a valid version.")

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const bundledPeekabooExecutable = fileURLToPath(new URL("../vendor/peekaboo/peekaboo", import.meta.url))
const defaultConfigPath = fileURLToPath(new URL("../.shellby/config.toml", import.meta.url))
const httpUrl = z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "URL must use http or https")
const cdpEndpoint = httpUrl.refine((value) => {
  const url = new URL(value)
  const managedLocal = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  return !managedLocal || url.port.length > 0
}, "Local CDP endpoint must include an explicit port")

const toolOutputFormatSchema = z.enum(["compact", "structured"])
export type ToolOutputFormat = z.infer<typeof toolOutputFormatSchema>

const publicConfigSchema = z
  .object({
    workspace: z.string().trim().min(1),
    shell: z.object({ path: z.string().trim().min(1) }).strict(),
    chatgpt: z
      .object({
        cdp_endpoint: cdpEndpoint,
        project_url: httpUrl,
      })
      .strict(),
    mcp: z.object({ tool_output: toolOutputFormatSchema }).strict(),
    tools: z
      .object({
        review: z.boolean(),
        shell: z.boolean(),
        apply_patch: z.boolean(),
        clones: z.boolean(),
        subagents: z.boolean(),
        web: z.boolean(),
        skills: z.boolean(),
        image: z.boolean(),
        computer: z.boolean(),
      })
      .strict(),
  })
  .strict()

type ShellbyPublicConfig = z.infer<typeof publicConfigSchema>

export function loadPublicConfig(path = defaultConfigPath): ShellbyPublicConfig {
  if (!existsSync(path)) {
    throw new Error(`Shellby config is missing at ${path}. Run \`npm run setup\` first.`)
  }

  let value: unknown
  try {
    value = parse(readFileSync(path, "utf8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Shellby config at ${path}: ${message}`, { cause: error })
  }

  const parsed = publicConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`Invalid Shellby config at ${path}: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

const publicConfig = loadPublicConfig()

export const MCP_CONFIG = {
  server: {
    name: "shellby-mcp",
    version: packageVersion,
    icons: [
      {
        src: `data:image/png;base64,${readFileSync(new URL("../docs/assets/icon-80_square-compressed.png", import.meta.url)).toString("base64")}`,
        mimeType: "image/png",
        sizes: ["80x80"],
      },
    ],
  },
  host: "127.0.0.1",
  port: 3333,
  workspace: resolveConfiguredPath(publicConfig.workspace),
  peekaboo: {
    executable: bundledPeekabooExecutable,
    cursorHostExecutable: join(dirname(bundledPeekabooExecutable), "peekaboo-cursor-host"),
  },
  chatGpt: {
    cdpEndpoint: publicConfig.chatgpt.cdp_endpoint,
    projectUrl: publicConfig.chatgpt.project_url,
    defaultOververbosity: 2,
    defaultPollWaitMs: 30_000,
    maxPollWaitMs: 270_000,
  },
  mcp: {
    toolOutput: publicConfig.mcp.tool_output,
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

export function buildMcpInstructions(workspacePath: string): string {
  return `# Shellby MCP

- The user is invoking Shellby because they want deep task execution. Treat the instructions returned by \`start_here\` as the operating instructions for how to work in this conversation. You are now in Deep Work Mode.
- Call \`start_here\` before using any other Shellby tool.
- Read the context required to do the work correctly. Do not guess, shortcut, or act on partial context when the necessary context can be inspected.
- Do not use ChatGPT's internal container or sandbox for paths under \`/Users/...\` or for work intended to affect the user's local machine; use Shellby MCP instead.
- Unless the user specifies another location, perform Shellby work in the configured default workspace: \`${workspacePath}\`.`
}
