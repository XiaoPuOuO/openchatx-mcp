import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import { toToolError } from "../../mcp/tool-error.js"
import type { WorkflowService } from "../../workflows/workflow-service.js"

const workflowStepInput = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("tool"),
    tool: z.string().min(1),
    arguments_json: z.string().default("{}"),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("subagent"),
    profile: z.string().min(1),
    task: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("team"),
    team: z.string().min(1),
    task: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("job"),
    label: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    project_id: z.string().min(1).optional(),
  }),
])

export function registerWorkflowTools(server: McpServer, workflows: WorkflowService): void {
  server.registerTool(
    "workflow_list",
    {
      description: "List reusable cross-capability workflows composed in OpenChatX.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ structuredContent: { workflows: await workflows.list() }, content: [] })
  )

  server.registerTool(
    "workflow_manage",
    {
      description:
        "Create, update, or remove a reusable workflow made from lazy tools, subagents, agent teams, and durable jobs.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("upsert"),
          id: z.string().min(1),
          name: z.string().min(1),
          description: z.string().min(1).optional(),
          steps: z.array(workflowStepInput).min(1).max(40),
        }),
        z.object({ action: z.literal("remove"), id: z.string().min(1) }),
      ]),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        if (input.action === "remove") {
          await workflows.remove(input.id)
          return { structuredContent: { removed: input.id }, content: [] }
        }
        return { structuredContent: { workflow: await workflows.upsert(input) }, content: [] }
      } catch (error) {
        throw toToolError(error, "WORKFLOW_MANAGE_FAILED")
      }
    }
  )

  server.registerTool(
    "workflow_run",
    {
      description:
        "Run a composed workflow. Use {{input}} and {{steps.<step-id>}} templates in step fields to pass data forward.",
      inputSchema: z.object({
        workflow: z.string().min(1),
        input: z.string().default(""),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workflow, input }, context) => {
      try {
        const result = await workflows.run(workflow, input, context, context.mcpReq.signal)
        return { structuredContent: result, content: [] }
      } catch (error) {
        throw toToolError(error, "WORKFLOW_RUN_FAILED")
      }
    }
  )
}
