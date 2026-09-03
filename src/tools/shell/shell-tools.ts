import { McpServer } from "@modelcontextprotocol/server"

import {
  DEFAULT_SHELL_ID,
  shellCloseInputSchema,
  shellCloseOutputSchema,
  shellListOutputSchema,
  shellPollInputSchema,
  shellPollOutputSchema,
  shellResetInputSchema,
  shellResetOutputSchema,
  shellRunInputSchema,
  shellRunOutputSchema,
  type ShellBatchCommandOutput,
  type ShellPollOutput,
  type ShellRunOutput,
} from "./shell-contracts.js"
import { withApplyPatchToolHint } from "./apply-patch-guidance.js"
import { ShellSessionError, type ShellSnapshot } from "./session.js"
import type { ShellSessionManager } from "./session-manager.js"

export function registerShellExecutionTools(server: McpServer, shells: ShellSessionManager, workspace: string): void {
  const workspaceDescription = JSON.stringify(workspace)

  server.registerTool(
    "shell_run",
    {
      description: `Run commands in a persistent zsh shell. Provide exactly one of command or commands. Shells cwd start in ${workspaceDescription}.`,
      inputSchema: shellRunInputSchema,
      outputSchema: shellRunOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, ctx) => {
      try {
        const { shell_id, ...commandInput } = input
        const snapshot = await shells.withShell(shell_id, (shell) => shell.runCommand({ ...commandInput, signal: ctx.mcpReq.signal }))
        return snapshotResult(snapshot, shell_id)
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    "shell_poll",
    {
      description: "Continue a shell_run from next_cursor. Returns on completion, wait expiry, or output budget; poll again while next_cursor is returned.",
      inputSchema: shellPollInputSchema,
      outputSchema: shellPollOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      try {
        const { shell_id, ...pollInput } = input
        const snapshot = await shells.withExistingShell(shell_id, (shell) => shell.pollCommand({ ...pollInput, signal: ctx.mcpReq.signal }))
        return pollSnapshotResult(snapshot)
      } catch (error) {
        return toolError(error)
      }
    }
  )
}

export function registerShellManagementTools(server: McpServer, shells: ShellSessionManager): void {
  server.registerTool(
    "shell_reset",
    {
      description: "Reset a stuck shell, discarding its process, cwd, environment, and retained state before starting clean.",
      inputSchema: shellResetInputSchema,
      outputSchema: shellResetOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { shell_id, ...resetInput } = input
        const result = await shells.withShell(shell_id, (shell) => shell.reset(resetInput), { restoreCached: false })
        return {
          structuredContent: result,
          content: [],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    "shell_list",
    {
      description: "List open persistent shells.",
      outputSchema: shellListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const result = {
          shells: shells.listShells(),
          count: shells.shellCount,
          limit: shells.maximumShells,
          idle_timeout_ms: shells.idleTimeoutMilliseconds,
        }
        return {
          structuredContent: result,
          content: [],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    "shell_close",
    {
      description: `Close a named shell and discard its state. The ${DEFAULT_SHELL_ID} shell must be reset instead.`,
      inputSchema: shellCloseInputSchema,
      outputSchema: shellCloseOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ shell_id }) => {
      try {
        await shells.closeShell(shell_id)
        const result = { shell_id, closed: true as const }
        return {
          structuredContent: result,
          content: [],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )
}

function snapshotResult(snapshot: ShellSnapshot, shellId: string) {
  const structuredContent = compactShellSnapshot(snapshot, shellId)
  return {
    structuredContent,
    content: [],
  }
}

function pollSnapshotResult(snapshot: ShellSnapshot) {
  if (snapshot.cursor_expired) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "cursor_expired: Output before the requested cursor is no longer retained. Rerun the command if complete output is required.",
        },
      ],
    }
  }

  const structuredContent: ShellPollOutput = {
    status: snapshot.status,
    ...(snapshot.exit_code !== null ? { exit_code: snapshot.exit_code } : {}),
    output: withApplyPatchToolHint(snapshot.output),
  }
  if (snapshot.status === "running" || snapshot.output_truncated) structuredContent.next_cursor = snapshot.next_cursor
  if (snapshot.dropped_output_bytes > 0) structuredContent.dropped_output_bytes = snapshot.dropped_output_bytes
  if (snapshot.commands) structuredContent.commands = compactBatchCommands(snapshot.commands)

  return {
    structuredContent,
    content: [],
  }
}

function compactBatchCommands(commands: NonNullable<ShellSnapshot["commands"]>): ShellBatchCommandOutput[] {
  return commands.map((command) => ({
    run: command.run,
    command: command.command,
    ...(command.path === "." ? {} : { path: command.path }),
    status: command.status,
    exit_code: command.exit_code,
    ...(command.dropped_output_bytes ? { dropped_output_bytes: command.dropped_output_bytes } : {}),
  }))
}

function compactShellSnapshot(snapshot: ShellSnapshot, shellId: string): ShellRunOutput {
  const compact: ShellRunOutput = {
    status: snapshot.status,
    ...(snapshot.exit_code !== null ? { exit_code: snapshot.exit_code } : {}),
    cwd: snapshot.cwd,
    output: withApplyPatchToolHint(snapshot.output),
  }
  if (shellId !== DEFAULT_SHELL_ID) compact.shell_id = shellId
  if (snapshot.status === "running" || snapshot.output_truncated) {
    compact.request_id = snapshot.request_id
    compact.next_cursor = snapshot.next_cursor
  }
  if (snapshot.cursor_expired) compact.cursor_expired = true
  if (snapshot.output_truncated) compact.output_truncated = true
  if (snapshot.dropped_output_bytes > 0) compact.dropped_output_bytes = snapshot.dropped_output_bytes
  if (snapshot.commands) compact.commands = compactBatchCommands(snapshot.commands)
  return compact
}

function toolError(error: unknown) {
  const text =
    error instanceof ShellSessionError ? `${error.code}: ${error.message}` : `internal_error: ${error instanceof Error ? error.message : String(error)}`
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}
