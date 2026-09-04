import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import { ChatGptSubagentError, chatGptSubagentActivitySchema, chatGptSubagentStatusSchema, type ChatGptSubagentService } from "./chatgpt-subagent-contracts.js"

const SUBAGENT_RUN_DELAYS_MS = [0, 5_000, 7_000] as const

const subagentInputSchema = z.object({
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > 0, "agent_id cannot be only whitespace.")
    .transform((value) => value.trim())
    .describe("Stable subagent conversation ID. Reuse to continue it; use a new ID for independent work."),
  prompt: z
    .string()
    .refine((value) => value.trim().length > 0, "prompt cannot be only whitespace.")
    .transform((value) => value.trim())
    .describe("Task or follow-up instruction. Include enough context for the subagent to act."),
  memory: z.boolean().default(true).describe("Allow a new agent to access memory outside its conversation. Turn history is always preserved."),
})

const subagentRunResultSchema = z.object({
  agent_id: z.string(),
  turn_id: z.string().optional().describe("Unique ID for one submitted turn. Pass it to subagent_result to retrieve that turn."),
  status: z.enum(["running", "failed"]),
  error: z.string().optional(),
})

const subagentResultSchema = z.object({
  turn_id: z.string(),
  status: chatGptSubagentStatusSchema,
  activity: chatGptSubagentActivitySchema.optional().describe("Current coarse activity while status is running."),
  activity_age_ms: z.int().nonnegative().optional().describe("Time since the last observable subagent progress while status is running."),
  response: z.string().optional(),
  error: z.string().optional(),
})

export function registerSubagentTools(server: McpServer, chatGptSubagents: ChatGptSubagentService): void {
  server.registerTool(
    "subagent_run",
    {
      description: "Submit 1-3 subagent tasks and continue working. Retrieve returned turn_id values with subagent_result.",
      inputSchema: z.object({
        agents: z
          .array(subagentInputSchema)
          .min(1)
          .max(3)
          .refine((agents) => new Set(agents.map((agent) => agent.agent_id)).size === agents.length, "agent_id values must be unique within a batch."),
      }),
      outputSchema: z.object({
        turns: z.array(subagentRunResultSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ agents }, ctx) => {
      const turns: Array<z.infer<typeof subagentRunResultSchema>> = []

      for (let index = 0; index < agents.length; index += 1) {
        const agent = agents[index]
        if (!agent) continue

        if (index > 0) {
          try {
            await delay(SUBAGENT_RUN_DELAYS_MS[index]!, ctx.mcpReq.signal)
          } catch (error) {
            turns.push(runFailure(agent.agent_id, error))
            break
          }
        }

        try {
          const turnId = await chatGptSubagents.ask(
            {
              agentId: agent.agent_id,
              prompt: agent.prompt,
              memory: agent.memory,
            },
            { signal: ctx.mcpReq.signal }
          )
          turns.push({
            agent_id: agent.agent_id,
            turn_id: turnId,
            status: "running",
          })
        } catch (error) {
          turns.push(runFailure(agent.agent_id, error))
        }
      }

      return {
        structuredContent: { turns },
        content: [],
      }
    }
  )

  server.registerTool(
    "subagent_result",
    {
      description: "Retrieve status or results for 1-3 submitted subagent turns. Be patient, subagents may take up to 30 minutes to complete.",
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
          .max(3)
          .describe("turn_id values returned by subagent_run."),
        wait_ms: z
          .int()
          .min(0)
          .max(MCP_CONFIG.chatGpt.maxPollWaitMs)
          .default(MCP_CONFIG.chatGpt.defaultPollWaitMs)
          .describe("Returns immediately if completed."),
      }),
      outputSchema: z.object({
        turns: z.array(subagentResultSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ turn_ids, wait_ms }, ctx) => {
      const results = await Promise.all(
        turn_ids.map(async (turnId) => {
          try {
            const result = await chatGptSubagents.poll(turnId, wait_ms, ctx.mcpReq.signal)
            return {
              turn_id: turnId,
              status: result.status,
              activity: result.activity,
              activity_age_ms: result.activityAgeMs,
              response: result.response,
              error:
                result.status === "failed" ? `${result.errorCode ?? "subagent_failed"}: ${result.errorMessage ?? "ChatGPT subagent turn failed."}` : undefined,
            }
          } catch (error) {
            return {
              turn_id: turnId,
              status: "failed" as const,
              error: subagentErrorText(error),
            }
          }
        })
      )

      return {
        structuredContent: { turns: results },
        content: [],
      }
    }
  )
}

function runFailure(agentId: string, error: unknown): z.infer<typeof subagentRunResultSchema> {
  return {
    agent_id: agentId,
    status: "failed",
    error: subagentErrorText(error),
  }
}

function subagentErrorText(error: unknown): string {
  return error instanceof ChatGptSubagentError
    ? `${error.code}: ${error.message}`
    : `subagent_failed: ${error instanceof Error ? error.message : String(error)}`
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(new ChatGptSubagentError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled."))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ChatGptSubagentError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled."))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
