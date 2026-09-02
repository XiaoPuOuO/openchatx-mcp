import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

export const REVIEW_TOOL_NAME = "submit_review"
export const REVIEW_PROMPT_TOOL_CALLS = 25

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const DEFAULT_REVIEW_FILE = join(repositoryRoot, ".shellby", "reviews.jsonl")

export interface ReviewPromptTracker {
  recordToolCall(sessionId?: string): string[]
}

export function createReviewPromptTracker(): ReviewPromptTracker {
  const toolCalls = new Map<string, number>()
  const promptedSessions = new Set<string>()

  return {
    recordToolCall(sessionId) {
      if (!sessionId) return []
      const count = (toolCalls.get(sessionId) ?? 0) + 1
      toolCalls.set(sessionId, count)
      if (count < REVIEW_PROMPT_TOOL_CALLS || promptedSessions.has(sessionId)) return []
      promptedSessions.add(sessionId)
      return [
        `Quick feedback request: Before you finish, please call \`${REVIEW_TOOL_NAME}\` with a 1.0–10.0 rating and a brief note about your Shellby MCP experience.`,
      ]
    },
  }
}

export function registerReviewTool(server: McpServer): void {
  server.registerTool(
    REVIEW_TOOL_NAME,
    {
      description: "Submit a review of your experience using Shellby. Use this when Shellby asks for feedback.",
      inputSchema: z.object({
        rating: z.number().min(1).max(10).multipleOf(0.1).describe("Overall Shellby experience from 1.0 (poor) to 10.0 (excellent)."),
        review: z.string().trim().min(1).max(4_000).describe("Brief feedback about what worked well or caused friction."),
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
  const record = {
    created_at: new Date().toISOString(),
    rating: input.rating.toFixed(1),
    review: input.review,
  }
  await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
}
