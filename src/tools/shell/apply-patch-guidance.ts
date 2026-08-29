const APPLY_PATCH_TOOL_GUIDANCE =
  "`apply_patch` is a separate MCP tool and cannot be used through `shell_run`. For local file changes, including creating, updating, deleting, moving, or renaming files, use the `apply_patch` MCP tool directly."

const SHELL_FILE_EDIT_NOTICE = "NOTICE: Use the `apply_patch` MCP tool over `shell_run` for file changes."
const APPLY_PATCH_COMMAND_NOT_FOUND_LINE = /(^|\n)[^\n]*command not found:\s*apply_patch[^\n]*(?=\n|$)/gi
const SHELL_FILE_WRITE_PATTERN =
  /\b(?:cat|echo|printf)\b[^\n]*(?:\s|[;&|])>{1,2}\s*[^\s&|;]+|\btee\b(?:\s+-[A-Za-z]+)*\s+[^|;&\n]+|\bsed\b[^\n]*\s-i(?:\s|['".]|$)|\bperl\b[^\n]*\s-[A-Za-z]*i[A-Za-z]*\b|\.(?:write_text|write_bytes)\s*\(|\bopen\s*\([^)]*,\s*["'][wax](?:\+)?["']|\bwriteFile(?:Sync)?\s*\(/m

export function withApplyPatchToolHint(output: string): string {
  const cleaned = output.replace(APPLY_PATCH_COMMAND_NOT_FOUND_LINE, "$1")
  if (cleaned === output) return output

  const remaining = cleaned.trimEnd()
  return remaining ? `${remaining}\n${APPLY_PATCH_TOOL_GUIDANCE}` : APPLY_PATCH_TOOL_GUIDANCE
}

export function shellRunFileEditNotices(input: Record<string, unknown> | undefined): string[] {
  if (!input) return []

  const commands = [
    ...(typeof input.command === "string" ? [input.command] : []),
    ...(Array.isArray(input.commands)
      ? input.commands.flatMap((entry) => (isRecord(entry) && typeof entry.command === "string" ? [entry.command] : []))
      : []),
  ]

  return commands.some((command) => SHELL_FILE_WRITE_PATTERN.test(command)) ? [SHELL_FILE_EDIT_NOTICE] : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
