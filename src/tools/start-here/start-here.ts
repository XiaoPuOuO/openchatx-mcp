import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { setAgentTaskSlug } from "../../server/agent-context.js"

export const START_HERE_TOOL_NAME = "start_here"
const SHARED_PROMPT_NAME = "shared"
const PROMPT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TASK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

type PromptSource = {
  path: string
  prompt: string
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

export function registerStartHereTool(server: McpServer): void {
  const modes = discoverPromptModes()
  if (modes.length === 0) throw new Error("start_here requires at least one prompt mode")

  server.registerTool(
    START_HERE_TOOL_NAME,
    {
      description:
        "Required first call in a new ChatGPT conversation. Loads the selected Deep Work Mode instructions and unlocks the other Shellby tools. Call this once at the start of a conversation.",
      inputSchema: z.object({
        mode: z.enum(modes as [string, ...string[]]).describe("Select the Deep Work mode that best matches the task."),
        task_slug: z
          .string()
          .min(1)
          .max(64)
          .regex(TASK_SLUG_PATTERN, "task_slug must be lowercase kebab-case.")
          .describe("Short lowercase kebab-case label for the work, such as audit-session-labels."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ mode, task_slug }) => {
      const [selected, shared] = await Promise.all([readStartPrompt(mode), readStartPrompt(SHARED_PROMPT_NAME)])
      const instructions = [selected.prompt.trim(), shared.prompt.trim()].filter(Boolean).join("\n\n")
      setAgentTaskSlug(task_slug)
      return {
        content: [{ type: "text", text: instructions }],
      }
    }
  )
}

export function discoverPromptModes(root = repositoryRoot): string[] {
  const bundledDirectory = join(root, "src", "tools", "start-here", "prompts")
  const localDirectory = join(root, ".shellby", "prompts")
  const names = new Set([...readPromptSlugs(bundledDirectory), ...readPromptSlugs(localDirectory)])
  names.delete(SHARED_PROMPT_NAME)
  return [...names].sort()
}

export async function readStartPrompt(name: string, root = repositoryRoot): Promise<PromptSource> {
  const localPath = join(root, ".shellby", "prompts", `${name}.md`)
  try {
    return { path: localPath, prompt: await readFile(localPath, "utf8") }
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error
  }

  const bundledPath = join(root, "src", "tools", "start-here", "prompts", `${name}.md`)
  return { path: bundledPath, prompt: await readFile(bundledPath, "utf8") }
}

function readPromptSlugs(directory: string): string[] {
  try {
    const slugs = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3))
    const invalid = slugs.find((slug) => !PROMPT_SLUG_PATTERN.test(slug))
    if (invalid) throw new Error(`Invalid start_here prompt filename: ${invalid}.md. Use lowercase kebab-case.`)
    return slugs
  } catch (error) {
    if (isFsError(error, "ENOENT")) return []
    throw error
  }
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
}
