import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"
import {
  ChatGptDelegationError,
  type ChatGptDelegationService,
  chatGptDelegationActivitySchema,
  chatGptDelegationStatusSchema,
} from "./contracts.js"
import { pollDelegatedTurns } from "./turn-results.js"

const SUBAGENT_RUN_DELAYS_MS = [1_000, 5_000, 7_000] as const
const SUBAGENT_UNAVAILABLE_ERROR =
  "SUBAGENT_UNAVAILABLE: The subagent service is temporarily unavailable. Retry the same subagent call once. If it fails again, continue without delegation. Do not change the task or prompt as a workaround."
const SUBAGENT_FAILED_ERROR =
  "subagent_failed: The subagent failed unexpectedly. Continue the task without delegation."

const subagentInputSchema = z.object({
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > 0, "agent_id cannot be only whitespace.")
    .transform((value) => value.trim())
    .describe(
      "Stable subagent conversation ID. Reuse to continue it; use a new ID for independent work."
    ),
  prompt: z
    .string()
    .refine((value) => value.trim().length > 0, "prompt cannot be only whitespace.")
    .transform((value) => value.trim())
    .describe("Task or follow-up instruction. Include enough context for the subagent to act."),
  memory: z
    .boolean()
    .default(true)
    .describe(
      "Allow a new agent to access memory outside its conversation. Turn history is always preserved."
    ),
})

const subagentRunResultSchema = z.object({
  agent_id: z.string(),
  turn_id: z
    .string()
    .optional()
    .describe(
      "Unique ID for one submitted turn. Pass it to subagent_result to retrieve that turn."
    ),
  status: z.enum(["running", "failed"]),
  error: z.string().optional(),
})

const subagentResultSchema = z.object({
  turn_id: z.string(),
  status: chatGptDelegationStatusSchema,
  activity: chatGptDelegationActivitySchema
    .optional()
    .describe("Current coarse activity while status is running."),
  activity_age_ms: z
    .int()
    .nonnegative()
    .optional()
    .describe("Time since the last observable subagent progress while status is running."),
  response: z.string().optional(),
  error: z.string().optional(),
})

export function registerSubagentTools(
  server: McpServer,
  chatGptDelegation: ChatGptDelegationService
): void {
  server.registerTool(
    "subagent_run",
    {
      description:
        "Submit 1-3 subagent tasks and continue working. Retrieve returned turn_id values with subagent_result.",
      inputSchema: z.object({
        agents: z
          .array(subagentInputSchema)
          .min(1)
          .max(3)
          .refine(
            (agents) => new Set(agents.map((agent) => agent.agent_id)).size === agents.length,
            "agent_id values must be unique within a batch."
          ),
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
            const delayMs = SUBAGENT_RUN_DELAYS_MS[index]
            if (delayMs !== undefined) await delay(delayMs, ctx.mcpReq.signal)
          } catch (error) {
            turns.push(runFailure(agent.agent_id, error))
            break
          }
        }

        try {
          const turnId = await chatGptDelegation.ask(
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
      description:
        "Retrieve status or results for 1-3 submitted subagent turns. Be patient, subagents may take up to 30 minutes to complete.",
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
      const results = await pollDelegatedTurns({
        service: chatGptDelegation,
        turnIds: turn_ids,
        waitMs: wait_ms,
        signal: ctx.mcpReq.signal,
        formatFailure: (result) => subagentFailureText(result.errorCode, result.errorMessage),
        formatError: subagentErrorText,
      })

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
  return error instanceof ChatGptDelegationError
    ? subagentFailureText(error.code, error.message)
    : SUBAGENT_FAILED_ERROR
}

function subagentFailureText(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "BROWSER_UNAVAILABLE":
    case "CHATGPT_NOT_AUTHENTICATED":
    case "CHATGPT_UI_CHANGED":
      return SUBAGENT_UNAVAILABLE_ERROR
    case "SUBAGENT_RATE_LIMITED":
      return "SUBAGENT_RATE_LIMITED: New subagent turns are temporarily rate limited. Existing turns remain available through subagent_result. Do not retry automatically."
    case "AGENT_TARGET_LOST":
      return "AGENT_TARGET_LOST: The subagent's execution state is no longer available. Start a new subagent with a new agent_id if delegation is still needed."
    case "REQUEST_ABORTED":
      return "REQUEST_ABORTED: The subagent request was cancelled. A submitted turn will not be retried automatically."
    case undefined:
    case "subagent_failed":
      return SUBAGENT_FAILED_ERROR
    default:
      return `${code}: ${message ?? "Subagent turn failed."}`
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted)
    return Promise.reject(
      new ChatGptDelegationError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled.")
    )

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(
        new ChatGptDelegationError("REQUEST_ABORTED", "The ChatGPT subagent request was cancelled.")
      )
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
