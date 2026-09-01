import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"

export const DEFAULT_SHELL_ID = "default"

const requestIdInput = z.string().min(3).max(128)
const shellIdInput = z.string().min(3).max(64).default(DEFAULT_SHELL_ID)

const closableShellIdInput = z
  .string()
  .min(3)
  .max(64)
  .describe(`Named shell to close. \`${DEFAULT_SHELL_ID}\` shell is protected and cannot be closed; use shell_reset instead.`)

const maxOutputTokensInput = z.int().min(1).max(MCP_CONFIG.shell.maxOutputTokens).default(MCP_CONFIG.shell.defaultOutputTokens)

const shellBatchCommandInputSchema = z.object({
  command: z.string().min(1).describe("Exact zsh command or multiline script."),
  cwd: z.string().min(1).optional().describe("Omit to inherit the shell_run cwd."),
})

export const shellRunInputSchema = z
  .object({
    shell_id: shellIdInput.describe("Unique persistent shell label such as api-audit. Reuse for command(s) that should share cwd or environment."),
    request_id: requestIdInput.describe("Unique within this shell_id, such as scan-routes-1."),
    cwd: z.string().min(1).optional().describe("Omit to keep the cwd. Parallel `commands` inherit this cwd."),
    command: z.string().min(1).optional().describe("Exact zsh command or multiline script."),
    commands: z.array(shellBatchCommandInputSchema).min(1).optional().describe("Independent zsh commands to run in parallel. Each command may override cwd."),
    wait_ms: z
      .int()
      .min(0)
      .max(MCP_CONFIG.shell.maxWaitMs)
      .default(MCP_CONFIG.shell.defaultWaitMs)
      .describe("Max wait time before returning. Running commands continue; use shell_poll."),
    max_output_tokens: maxOutputTokensInput.describe(
      "Usually omit. Increase only when you need more output in one response; continue retained output with shell_poll."
    ),
  })
  .refine((input) => (input.command === undefined) !== (input.commands === undefined), {
    message: "Provide exactly one of command or commands.",
  })
  .meta({
    oneOf: [{ required: ["command"] }, { required: ["commands"] }],
  })

export type ShellRunInput = z.infer<typeof shellRunInputSchema>

export const shellPollInputSchema = z.object({
  shell_id: shellIdInput.describe("The same shell_id used for the original shell_run call."),
  request_id: requestIdInput.describe("The same request_id used for the original shell_run call."),
  cursor: z.int().nonnegative().describe("Pass the next_cursor returned by the previous shell_run or shell_poll."),
  wait_ms: z
    .int()
    .min(0)
    .max(MCP_CONFIG.shell.maxPollWaitMs)
    .default(MCP_CONFIG.shell.defaultPollWaitMs)
    .describe("Max long-poll wait for completion or enough output to fill the response budget."),
  max_output_tokens: maxOutputTokensInput.describe(
    "Usually omit. Increase only when you need more output in one response; continue retained output with shell_poll."
  ),
})

export type ShellPollInput = z.infer<typeof shellPollInputSchema>

export const shellResetInputSchema = z.object({
  shell_id: shellIdInput.describe("ID of the shell to reset."),
  reason: z.string().max(256).optional(),
})

export type ShellResetInput = z.infer<typeof shellResetInputSchema>

export const shellCloseInputSchema = z.object({
  shell_id: closableShellIdInput,
})

const shellCommandStatusSchema = z.enum(["running", "completed", "shell_exited", "reset"])
const parallelCommandStatusSchema = z.enum(["queued", "running", "completed", "timed_out", "failed", "reset"])

export type ShellCommandStatus = z.infer<typeof shellCommandStatusSchema>
export type ParallelCommandStatus = z.infer<typeof parallelCommandStatusSchema>

const exitCodeSchema = z.int().min(0).max(255)

const shellBatchCommandOutputSchema = z.object({
  run: z.int().positive(),
  command: z.string().describe("First command line, truncated to 20 characters."),
  path: z.string().optional().describe("Present only when this command overrides the inherited cwd."),
  status: parallelCommandStatusSchema,
  exit_code: exitCodeSchema.nullable(),
  dropped_output_bytes: z.int().positive().optional(),
})

export type ShellBatchCommandOutput = z.infer<typeof shellBatchCommandOutputSchema>

export const shellRunOutputSchema = z.object({
  shell_id: z.string().optional(),
  status: shellCommandStatusSchema,
  exit_code: exitCodeSchema.optional().describe("0 only when every command succeeded; otherwise 1."),
  cwd: z.string(),
  output: z.string(),
  request_id: z.string().optional(),
  next_cursor: z.int().nonnegative().optional().describe("Pass to shell_poll to continue."),
  cursor_expired: z.literal(true).optional(),
  output_truncated: z.literal(true).optional().describe("More retained output is available through shell_poll."),
  dropped_output_bytes: z.int().positive().optional().describe("Output permanently discarded."),
  commands: z.array(shellBatchCommandOutputSchema).optional().describe("Per-command results for a parallel run"),
})

export type ShellRunOutput = z.infer<typeof shellRunOutputSchema>

export const shellPollOutputSchema = shellRunOutputSchema.pick({
  status: true,
  exit_code: true,
  output: true,
  next_cursor: true,
  dropped_output_bytes: true,
  commands: true,
})

export type ShellPollOutput = z.infer<typeof shellPollOutputSchema>

export const shellResetOutputSchema = z.object({
  shell_generation: z.int().positive(),
  state_lost: z.literal(true),
  status: z.literal("ready"),
})

export type ShellResetOutput = z.infer<typeof shellResetOutputSchema>

export const shellListOutputSchema = z.object({
  shells: z.array(
    z.object({
      shell_id: z.string(),
      status: z.enum(["idle", "active"]),
      can_close: z.boolean(),
      idle_ms: z.int().nonnegative(),
    })
  ),
  count: z.int().nonnegative(),
  limit: z.int().positive(),
  idle_timeout_ms: z.int().nonnegative(),
})

export type ShellListOutput = z.infer<typeof shellListOutputSchema>

export const shellCloseOutputSchema = z.object({
  shell_id: z.string(),
  closed: z.literal(true),
})
