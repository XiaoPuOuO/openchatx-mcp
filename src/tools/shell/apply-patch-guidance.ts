const APPLY_PATCH_TOOL_GUIDANCE =
  "File editing is provided by dedicated MCP tools and should not be done through `bash`. Use `file_edit` for a precise oldString/newString replacement in one existing file; use `apply_patch` for structural edits, multiple files, creation, deletion, moves, or renames."

const SHELL_FILE_EDIT_NOTICE =
  "Use `file_edit` for precise single-file replacements or `apply_patch` for structural/multi-file changes instead of `bash`."
const APPLY_PATCH_COMMAND_NOT_FOUND_LINE =
  /(^|\n)[^\n]*command not found:\s*apply_patch[^\n]*(?=\n|$)/giu
const SHELL_FILE_WRITE_PATTERN =
  /\b(?:cat|echo|printf)\b[^\n]*(?:\s|[;&|])>{1,2}\s*[^\s&|;]+|\btee\b(?:\s+-[A-Za-z]+)*\s+[^|;&\n]+|\bsed\b[^\n]*\s-i(?:\s|['".]|$)|\bperl\b[^\n]*\s-[A-Za-z]*i[A-Za-z]*\b|\.(?:write_text|write_bytes)\s*\(|\bopen\s*\([^)]*,\s*["'][wax](?:\+)?["']|\bwriteFile(?:Sync)?\s*\(/mu

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
      ? input.commands.flatMap((entry) =>
          isRecord(entry) && typeof entry.command === "string" ? [entry.command] : []
        )
      : []),
  ]

  return commands.some((command) => SHELL_FILE_WRITE_PATTERN.test(command))
    ? [SHELL_FILE_EDIT_NOTICE]
    : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
