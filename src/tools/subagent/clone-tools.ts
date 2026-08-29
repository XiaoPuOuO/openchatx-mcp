import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ChatGptSubagentError, type ChatGptSubagentService } from "./chatgpt-subagent-contracts.js"

const cloneSelfResultSchema = z.object({
  clone_id: z.string(),
  turn_id: z.string().optional().describe("Unique ID for the clone's first submitted turn."),
  status: z.enum(["running", "failed"]),
  error: z.string().optional(),
})

const cloneRunResultSchema = z.object({
  clone_id: z.string(),
  turn_id: z.string().optional().describe("Unique ID for the submitted clone turn."),
  status: z.enum(["running", "failed"]),
  error: z.string().optional(),
})

const cloneResultSchema = z.object({
  turn_id: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  activity: z.enum(["Working", "Searching the web", "Using tools", "Generating response"]).optional(),
  activity_age_ms: z.int().nonnegative().optional(),
  response: z.string().optional(),
  error: z.string().optional(),
})

export function registerCloneTools(server: McpServer, chatGptAgents: ChatGptSubagentService, notificationSessionId?: string): void {
  server.registerTool(
    "clone_self",
    {
      title: "Clone yourself from a ChatGPT conversation",
      description:
        "Fork a ChatGPT conversation into an independent copy of yourself with equivalent reasoning capability. The clone inherits the source through its latest forkable turn, then continues independently with the supplied prompt. Returns a detached turn_id.",
      inputSchema: z.object({
        conversation_url: z
          .string()
          .url()
          .describe("URL of the ChatGPT conversation to fork. The URL is treated as an opaque source location."),
        clone_id: z
          .string()
          .min(1)
          .max(64)
          .refine((value) => value.trim().length > 0, "clone_id cannot be only whitespace.")
          .transform((value) => value.trim())
          .describe("Unique identifier for the new clone. Use a different clone_id for each independent clone."),
        prompt: z
          .string()
          .refine((value) => value.trim().length > 0, "prompt cannot be only whitespace.")
          .transform((value) => value.trim())
          .describe("First instruction to send after the conversation is forked."),
      }),
      outputSchema: cloneSelfResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ conversation_url, clone_id, prompt }, ctx) => {
      try {
        if (!chatGptAgents.cloneSelf) {
          throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "This ChatGPT agent service does not support clone_self.")
        }
        const result = await chatGptAgents.cloneSelf(
          {
            sourceConversationUrl: conversation_url,
            cloneId: clone_id,
            prompt,
            notificationSessionId,
          },
          ctx.mcpReq.signal
        )
        return {
          structuredContent: {
            clone_id: result.agentId,
            turn_id: result.turnId,
            status: result.status,
          },
          content: [],
        }
      } catch (error) {
        return {
          structuredContent: {
            clone_id,
            status: "failed" as const,
            error: cloneErrorText(error),
          },
          content: [],
        }
      }
    }
  )

  server.registerTool(
    "clone_run",
    {
      title: "Run another turn in an existing clone",
      description:
        "Send another instruction to an existing clone. Reuse the clone_id returned by clone_self to preserve that clone's independent conversation context. Returns a detached turn_id for clone_result.",
      inputSchema: z.object({
        clone_id: z
          .string()
          .min(1)
          .max(64)
          .refine((value) => value.trim().length > 0, "clone_id cannot be only whitespace.")
          .transform((value) => value.trim()),
        prompt: z
          .string()
          .refine((value) => value.trim().length > 0, "prompt cannot be only whitespace.")
          .transform((value) => value.trim())
          .describe("Next instruction to send to the clone."),
      }),
      outputSchema: cloneRunResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ clone_id, prompt }, ctx) => {
      try {
        if (!chatGptAgents.cloneRun) {
          throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "This ChatGPT agent service does not support clone_run.")
        }
        const result = await chatGptAgents.cloneRun(
          { cloneId: clone_id, prompt, notificationSessionId },
          ctx.mcpReq.signal
        )
        return {
          structuredContent: {
            clone_id: result.agentId,
            turn_id: result.turnId,
            status: result.status,
          },
          content: [],
        }
      } catch (error) {
        return {
          structuredContent: {
            clone_id,
            status: "failed" as const,
            error: cloneErrorText(error),
          },
          content: [],
        }
      }
    }
  )

  server.registerTool(
    "clone_result",
    {
      title: "Get clone turn status or results",
      description: "Get the status or result of turns returned by clone_self or clone_run. Multiple turn_ids can be retrieved concurrently.",
      inputSchema: z.object({
        turn_ids: z
          .array(
            z
              .string()
              .max(128)
              .refine((value) => value.trim().length > 0, "turn_id cannot be only whitespace.")
              .transform((value) => value.trim())
          )
          .min(1)
          .max(3),
        wait_ms: z
          .int()
          .min(0)
          .max(MCP_CONFIG.chatGpt.maxPollWaitMs)
          .default(MCP_CONFIG.chatGpt.defaultPollWaitMs)
          .describe("How long to wait for clone completion. Use 0 only for an immediate status check."),
      }),
      outputSchema: z.object({ turns: z.array(cloneResultSchema) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: MCP_CONFIG.toolMeta,
    },
    async ({ turn_ids, wait_ms }, ctx) => {
      const turns = await Promise.all(
        turn_ids.map(async (turnId) => {
          try {
            const result = await chatGptAgents.poll(turnId, wait_ms, ctx.mcpReq.signal)
            return {
              turn_id: result.turnId,
              status: result.status,
              activity: result.activity,
              activity_age_ms: result.activityAgeMs,
              response: result.response,
              error:
                result.status === "failed" ? `${result.errorCode ?? "clone_failed"}: ${result.errorMessage ?? "ChatGPT clone turn failed."}` : undefined,
            }
          } catch (error) {
            return {
              turn_id: turnId,
              status: "failed" as const,
              error: cloneErrorText(error),
            }
          }
        })
      )

      return {
        structuredContent: { turns },
        content: [],
      }
    }
  )
}

function cloneErrorText(error: unknown): string {
  return error instanceof ChatGptSubagentError
    ? `${error.code}: ${error.message}`
    : `clone_failed: ${error instanceof Error ? error.message : String(error)}`
}
