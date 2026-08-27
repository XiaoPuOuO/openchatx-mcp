import { McpServer } from "@modelcontextprotocol/server"

import { MCP_CONFIG } from "../../config.js"
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
import { ShellSessionError, type ShellSnapshot } from "./session.js"
import type { ShellSessionManager } from "./session-manager.js"

const APPLY_PATCH_TOOL_GUIDANCE =
  "`apply_patch` is a separate MCP tool and cannot be used through `shell_run`. For local file changes, including creating, updating, deleting, moving, or renaming files, use the `apply_patch` MCP tool directly."
const APPLY_PATCH_COMMAND_NOT_FOUND_LINE = /(^|\n)[^\n]*command not found:\s*apply_patch[^\n]*(?=\n|$)/gi

export function registerShellExecutionTools(server: McpServer, shells: ShellSessionManager, workspace: string): void {
  const workspaceDescription = JSON.stringify(workspace)

  server.registerTool(
    "shell_run",
    {
      title: "Run a local shell command",
      description: `Run zsh in a persistent macOS shell. Reuse shell_id to keep cwd or environment. For independent commands that can run in parallel, use multiple *** Run: blocks. Use *** Run: <directory> to change cwd for that command. Relative directories resolve from cwd; absolute paths are allowed. New shells start in ${workspaceDescription}.\n- Use the apply_patch tool over shell_run for file changes.`,
      inputSchema: shellRunInputSchema,
      outputSchema: shellRunOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: MCP_CONFIG.toolMeta,
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
      title: "Poll local shell output",
      description:
        "Continue a shell_run that is still running or has retained output. Reuse the same shell_id and request_id and pass the previous next_cursor. Repeat while status is running, or while next_cursor is present and more output is needed.",
      inputSchema: shellPollInputSchema,
      outputSchema: shellPollOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
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
      title: "Reset the local shell",
      description:
        "Attempt to terminate the persistent shell process group, discard its working directory and environment state, and start a clean shell. Use this to recover from a stuck foreground command. Process-group cleanup is best effort if signaling is denied.",
      inputSchema: shellResetInputSchema,
      outputSchema: shellResetOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
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
      title: "List local shells",
      description: "List currently open persistent shells, their activity state, idle duration, and whether they may be closed.",
      outputSchema: shellListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
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
      title: "Close a local shell",
      description: `Terminate a named shell, discard its state and retained records, and immediately free its slot. The ${DEFAULT_SHELL_ID} shell is protected; use shell_reset if it freezes.`,
      inputSchema: shellCloseInputSchema,
      outputSchema: shellCloseOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: MCP_CONFIG.toolMeta,
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

function withApplyPatchToolHint(output: string): string {
  const replaced = output.replace(APPLY_PATCH_COMMAND_NOT_FOUND_LINE, (_, prefix: string) => `${prefix}${APPLY_PATCH_TOOL_GUIDANCE}`)
  return replaced === `${APPLY_PATCH_TOOL_GUIDANCE}\n` ? APPLY_PATCH_TOOL_GUIDANCE : replaced
}

function toolError(error: unknown) {
  const text =
    error instanceof ShellSessionError ? `${error.code}: ${error.message}` : `internal_error: ${error instanceof Error ? error.message : String(error)}`
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}
