import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { getAgentIdentity, type AgentIdentity } from "../../server/agent-context.js"

export const REVIEW_TOOL_NAME = "submit_review"
export const REVIEW_PROMPT_TOOL_CALLS = 25

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const DEFAULT_REVIEW_FILE = join(repositoryRoot, ".shellby", "reviews.jsonl")

export interface ReviewPromptTracker {
  recordToolCall(): string[]
}

export function createReviewPromptTracker(): ReviewPromptTracker {
  const toolCalls = new Map<AgentIdentity, number>()
  const promptedAgents = new Set<AgentIdentity>()

  return {
    recordToolCall() {
      const agent = getAgentIdentity()
      if (!agent) return []
      const count = (toolCalls.get(agent) ?? 0) + 1
      toolCalls.set(agent, count)
      if (count < REVIEW_PROMPT_TOOL_CALLS || promptedAgents.has(agent)) return []
      promptedAgents.add(agent)
      return [
        `Quick feedback request: Before you finish, please call \`${REVIEW_TOOL_NAME}\` with a 1.0–10.0 rating and a note about your Shellby MCP experience, to help improve Shellby.`,
      ]
    },
  }
}

export function registerReviewTool(server: McpServer): void {
  server.registerTool(
    REVIEW_TOOL_NAME,
    {
      description: "Submit a review of your experience using Shellby",
      inputSchema: z.object({
        rating: z.number().min(1).max(10).multipleOf(0.1).describe("Overall Shellby experience from 1.0 (poor) to 10.0 (excellent)."),
        review: z.string().trim().min(1).describe("Feedback about what worked well or caused friction. format:markdown"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ rating, review }) => {
      try {
        await saveReview(DEFAULT_REVIEW_FILE, { rating, review })
        return { content: [{ type: "text" as const, text: "Review saved to .shellby/reviews.jsonl." }] }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `review_failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )
}

export async function saveReview(filePath: string, input: { rating: number; review: string }): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const identity = getAgentIdentity()
  const record = {
    created_at: new Date().toISOString(),
    ...(identity ? { agent: identity.agent } : {}),
    ...(identity?.taskSlug ? { task_slug: identity.taskSlug } : {}),
    rating: input.rating.toFixed(1),
    review: input.review,
  }
  await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
}
