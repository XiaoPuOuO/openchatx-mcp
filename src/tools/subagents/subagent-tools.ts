import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { getAgentIdentity } from "../../agent/context.js"
import { toToolError } from "../../mcp/tool-error.js"
import type { SmartModelRouter } from "../../subagents/router.js"
import type { SubagentRuntime } from "../../subagents/runtime.js"

export function registerSubagentTools(
  server: McpServer,
  runtime: SubagentRuntime,
  router?: SmartModelRouter
): void {
  server.registerTool(
    "subagent_list",
    {
      description:
        "List the curated subagent model profiles configured by the user, including what each model is best used for.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      structuredContent: { models: runtime.profiles(), limits: runtime.limits() },
      content: [],
    })
  )

  server.registerTool(
    "subagent_run",
    {
      description:
        "Run a configured subagent synchronously, start an asynchronous subagent job, or select a model without running. Use subagent_get(job_id) after an async run.",
      inputSchema: z.object({
        action: z.enum(["run", "route"]).default("run"),
        mode: z.enum(["sync", "async"]).optional(),
        model: z.string().min(1).optional(),
        task: z.string().min(1),
        preferred_tags: z.array(z.string().min(1)).optional(),
        local_only: z.boolean().default(false),
        max_cost_tier: z.enum(["low", "medium", "high"]).optional(),
        min_context_window: z.int().positive().optional(),
        system: z.string().min(1).optional(),
        thinking: z.boolean().optional(),
        thinking_effort: z.string().min(1).optional(),
        max_output_tokens: z.int().positive().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        if (input.action === "route") {
          if (!router) throw new Error("Smart model routing is unavailable.")
          return {
            structuredContent: {
              selection: router.select({
                task: input.task,
                preferredTags: input.preferred_tags,
                localOnly: input.local_only,
                maxCostTier: input.max_cost_tier,
                minContextWindow: input.min_context_window,
              }),
            },
            content: [],
          }
        }

        const selectedProfile =
          input.model ??
          router?.select({
            task: input.task,
            preferredTags: input.preferred_tags,
            localOnly: input.local_only,
            maxCostTier: input.max_cost_tier,
            minContextWindow: input.min_context_window,
          }).profile
        if (!selectedProfile)
          throw new Error("model is required when smart routing is unavailable.")
        if ((input.mode ?? runtime.executionMode(selectedProfile)) === "async") {
          const job = runtime.startAsync(
            {
              profileId: selectedProfile,
              task: input.task,
              system: input.system,
              thinking: input.thinking,
              thinkingEffort: input.thinking_effort,
              maxOutputTokens: input.max_output_tokens,
            },
            getAgentIdentity()?.sessionId ?? "unscoped"
          )
          return {
            structuredContent: job,
            content: [
              {
                type: "text" as const,
                text: `Subagent started: ${job.job_id}. Continue other work; use subagent_get with this job_id to retrieve its result.`,
              },
            ],
          }
        }
        if (!input.model) {
          if (!router) throw new Error("model is required when smart routing is unavailable.")
          const routed = await router.run(
            {
              task: input.task,
              preferredTags: input.preferred_tags,
              localOnly: input.local_only,
              maxCostTier: input.max_cost_tier,
              minContextWindow: input.min_context_window,
              system: input.system,
              thinking: input.thinking,
              thinkingEffort: input.thinking_effort,
              maxOutputTokens: input.max_output_tokens,
            },
            context.mcpReq.signal
          )
          return {
            structuredContent: routed,
            content: [{ type: "text" as const, text: routed.result.content }],
          }
        }

        const result = await runtime.run(
          {
            profileId: input.model,
            task: input.task,
            system: input.system,
            thinking: input.thinking,
            thinkingEffort: input.thinking_effort,
            maxOutputTokens: input.max_output_tokens,
          },
          context.mcpReq.signal
        )
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: result.content }],
        }
      } catch (error) {
        throw toToolError(error, "SUBAGENT_FAILED")
      }
    }
  )

  server.registerTool(
    "subagent_steer",
    {
      description:
        "Queue guidance for a running subagent, or resume a completed subagent with new instructions. The guidance is delivered before the next model turn without interrupting ongoing tool calls.",
      inputSchema: z.object({
        job_id: z.string().min(1),
        message: z.string().trim().min(1).max(8000),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ job_id, message }) => {
      try {
        const session = runtime.steerSession(
          job_id,
          message,
          getAgentIdentity()?.sessionId ?? "unscoped"
        )
        return {
          structuredContent: {
            job_id: session.job_id,
            status: session.status,
            pending_guidance: session.pending_guidance,
          },
          content: [{ type: "text" as const, text: `Guidance queued for ${job_id}.` }],
        }
      } catch (error) {
        throw toToolError(error, "SUBAGENT_STEER_FAILED")
      }
    }
  )

  server.registerTool(
    "subagent_delete",
    {
      description:
        "Permanently delete a subagent job and all of its descendants, including saved conversation, events, and tool results. Frees the job's parent slot. Only the owner or an ancestor agent may delete it.",
      inputSchema: z.object({ job_id: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      try {
        const deleted = runtime.deleteSession(job_id, getAgentIdentity()?.sessionId ?? "unscoped")
        return {
          structuredContent: { job_id, deleted },
          content: [
            {
              type: "text" as const,
              text: `Deleted ${deleted} subagent session(s), releasing the slot.`,
            },
          ],
        }
      } catch (error) {
        throw toToolError(error, "SUBAGENT_DELETE_FAILED")
      }
    }
  )

  server.registerTool(
    "subagent_get",
    {
      description: "Read the status and result of a subagent async job owned by this conversation.",
      inputSchema: z.object({ job_id: z.string().min(1) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      try {
        const job = runtime.getJob(job_id, getAgentIdentity()?.sessionId ?? "unscoped")
        return {
          structuredContent: job,
          content: [
            {
              type: "text" as const,
              text: job.result?.content ?? job.error ?? `Subagent job is ${job.status}.`,
            },
          ],
        }
      } catch (error) {
        throw toToolError(error, "SUBAGENT_JOB_FAILED")
      }
    }
  )
}
