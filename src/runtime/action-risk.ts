import type { CapabilityPermission, RuntimeAuthorizationInput } from "./runtime-control.js"

export interface ActionRisk {
  level: "low" | "approval"
  category?: string
  reason?: string
}

const LOW_RISK_BUILTINS = new Set([
  "file_read",
  "file_write",
  "file_edit",
  "glob",
  "grep",
  "image_view",
  "start_here",
  "summarize",
])

const LOW_RISK_ACTIONS = new Set([
  "list",
  "read",
  "get",
  "search",
  "find",
  "show",
  "status",
  "inspect",
  "preview",
  "resolve",
  "load",
  "probe",
  "create",
  "edit",
  "update",
  "upsert",
  "add",
  "enable",
  "disable",
  "import",
  "export",
  "use",
])

const HIGH_RISK_ACTIONS = new Set([
  "delete",
  "remove",
  "uninstall",
  "purge",
  "reset",
  "kill",
  "terminate",
  "stop",
  "cancel",
  "clear",
  "install",
])

const READ_NAME_RE =
  /(?:^|[_-])(read|get|list|search|find|show|status|inspect|preview|check)(?:$|[_-])/iu
const FILE_MUTATION_NAME_RE =
  /(?:^|[_-])(create|write|edit|update|upsert|add|generate|render)(?:$|[_-])/iu
const DESTRUCTIVE_NAME_RE =
  /(?:^|[_-])(delete|remove|destroy|purge|erase|wipe|uninstall|kill|terminate|reset)(?:$|[_-])/iu
const PATCH_DELETE_RE = /^\*\*\* Delete File:/gmu
const REDIRECTION_RE = /(?:^|[^<])>{1,2}|<</u
const SHELL_PIPE_RE = /[|;]/u
const SAFE_GIT_RE = /^git\s+(?:status|diff|log|show|rev-parse|ls-files|describe|add)(?:\s|$)/iu
const SAFE_GIT_COMMIT_RE = /^git\s+commit(?:\s|$)/iu
const SAFE_BUILD_RE =
  /^(?:npm|pnpm|yarn)\s+(?:test|build|lint|typecheck|check)(?:\s|$)|^npx\s+(?:tsc|biome\s+check|tsx\s+--test|vitest|jest)(?:\s|$)|^(?:dotnet|cargo|go|swift)\s+(?:build|test|check|vet)(?:\s|$)|^xcodebuild(?:\s|$)/iu
const PACKAGE_SCRIPT_RE = /^(?:npm|pnpm|yarn)\s+run\s+([A-Za-z0-9._:-]+)(?:\s|$)/iu
const LOW_RISK_SCRIPT_TOKEN_RE =
  /(?:^|[:._-])(?:test|build|lint|typecheck|check|smoke)(?:$|[:._-])/iu
const HIGH_RISK_SCRIPT_TOKEN_RE =
  /(?:^|[:._-])(?:release|publish|deploy|upload|push|install|uninstall|remove|delete|clean|reset)(?:$|[:._-])/iu
const SAFE_SHELL_UTILITY_RE =
  /^(?:cd|pwd|which|command\s+-v|uname|printf|echo|sleep|mkdir|touch|node\s+--version|python(?:3)?\s+--version)(?:\s|$)/iu

const COMMAND_RISKS: ReadonlyArray<{ pattern: RegExp; category: string; reason: string }> = [
  {
    pattern: /(?:^|[\s;&|])(?:rm\b|unlink\b|rmdir\b|remove-item\b|del\b|erase\b)(?:\s|$)/iu,
    category: "filesystem-destructive",
    reason: "This command deletes files or directories.",
  },
  {
    pattern: /git\s+(?:push\b|reset\s+--hard\b|clean\s+-[^\n]*f|branch\s+(?:-[dD]|--delete)\b)/iu,
    category: "git-destructive",
    reason: "This Git command pushes remotely, rewrites state, or deletes local work.",
  },
  {
    pattern: /(?:kill\b|pkill\b|killall\b|taskkill\b|stop-process\b)/iu,
    category: "process-control",
    reason: "This command terminates one or more processes.",
  },
  {
    pattern:
      /(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)\b|pip(?:3)?\s+(?:install|uninstall)\b|brew\s+(?:install|uninstall)\b|winget\s+(?:install|uninstall)\b|apt(?:-get)?\s+(?:install|remove|purge)\b/iu,
    category: "package-removal",
    reason: "This command installs or removes software or packages.",
  },
  {
    pattern:
      /(?:^|[\s;&|])(?:sudo\b|chmod\b|chown\b|defaults\s+write\b|reg\s+(?:add|delete)\b|netsh\b|ufw\b|firewall-cmd\b)/iu,
    category: "system-change",
    reason: "This command changes system settings, permissions, or privileged configuration.",
  },
  {
    pattern:
      /(?:security\s+find-(?:generic|internet)-password|cmdkey\b|credential|keychain|password|api[_-]?key|token)/iu,
    category: "credential-access",
    reason: "This command may read or modify credentials or secrets.",
  },
  {
    pattern: /(?:\bformat\b|\bdiskpart\b|\bdiskutil\s+(?:erase|partition|apfs\s+delete)\b)/iu,
    category: "disk-destructive",
    reason: "This command may modify or erase disk structures.",
  },
]

const NETWORK_CLIENT_RE = /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/iu
const NETWORK_MUTATION_RE =
  /(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|-Method\s+(?:POST|PUT|PATCH|DELETE))/iu

export function classifyAction(
  input: RuntimeAuthorizationInput,
  permissions: CapabilityPermission[]
): ActionRisk {
  const effective = resolveEffectiveCall(input) ?? input

  if (permissions.includes("secrets")) {
    return approval("credential-access", "This action can access credentials or secrets.")
  }

  const direct = classifyDirectTool(effective.toolName, effective.argumentsValue)
  if (direct) return direct

  return classifyCapabilityAction(effective, permissions)
}

function classifyDirectTool(
  toolName: string,
  args: Record<string, unknown>
): ActionRisk | undefined {
  if (toolName === "apply_patch") return classifyPatch(args)
  if (toolName === "bash") return classifyShellValue(args.command)
  if (toolName === "terminal") return classifyTerminal(args)
  if (toolName === "job_manage") return classifyJobManage(args)

  const action = typeof args.action === "string" ? args.action.toLowerCase() : undefined
  if (action && HIGH_RISK_ACTIONS.has(action)) {
    return approval(actionCategory(action), `This action performs ${action} and requires approval.`)
  }
  if (LOW_RISK_BUILTINS.has(toolName) || (action && LOW_RISK_ACTIONS.has(action))) {
    return { level: "low" }
  }
  return undefined
}

function classifyCapabilityAction(
  input: RuntimeAuthorizationInput,
  permissions: CapabilityPermission[]
): ActionRisk {
  const source = input.source
  const toolName = input.toolName

  if (source?.destructiveHint === true) {
    return approval("capability-destructive", "This capability marks the action as destructive.")
  }
  if (source?.readOnlyHint === true || !source || source.kind === "builtin") {
    return { level: "low" }
  }

  if (source.kind === "mcp") {
    if (READ_NAME_RE.test(toolName)) return { level: "low" }
    return approval(
      "unknown-mcp-mutation",
      "This MCP action is not reliably identified as read-only."
    )
  }

  if (DESTRUCTIVE_NAME_RE.test(toolName)) {
    return approval("capability-destructive", "This capability action appears destructive.")
  }
  if (READ_NAME_RE.test(toolName)) return { level: "low" }
  if (isLowRiskFilesystemMutation(toolName, permissions)) return { level: "low" }
  return approval(
    "unknown-capability-action",
    "This capability action cannot be reliably classified as low-risk."
  )
}

function isLowRiskFilesystemMutation(
  toolName: string,
  permissions: CapabilityPermission[]
): boolean {
  return (
    FILE_MUTATION_NAME_RE.test(toolName) &&
    permissions.includes("filesystem") &&
    !permissions.includes("shell") &&
    !permissions.includes("network")
  )
}

function classifyPatch(args: Record<string, unknown>): ActionRisk {
  const patch = typeof args.patch === "string" ? args.patch : ""
  PATCH_DELETE_RE.lastIndex = 0
  if (PATCH_DELETE_RE.test(patch)) {
    PATCH_DELETE_RE.lastIndex = 0
    return approval("filesystem-destructive", "This patch deletes one or more files.")
  }
  PATCH_DELETE_RE.lastIndex = 0
  return { level: "low" }
}

function classifyTerminal(args: Record<string, unknown>): ActionRisk {
  const action = typeof args.action === "string" ? args.action.toLowerCase() : ""
  if (action === "read" || action === "resize") return { level: "low" }
  if (action === "close") {
    return approval("process-control", "This action closes an interactive terminal process.")
  }
  if (action === "create") return classifyShellValue(args.command)
  if (action === "write") {
    return approval(
      "interactive-shell-input",
      "Interactive terminal input cannot be reliably classified before execution."
    )
  }
  return approval("unknown-shell-action", "This terminal action cannot be reliably classified.")
}

function classifyJobManage(args: Record<string, unknown>): ActionRisk {
  const action = typeof args.action === "string" ? args.action.toLowerCase() : ""
  if (action === "list" || action === "read" || action === "wait") return { level: "low" }
  if (action === "cancel") {
    return approval("process-control", "This action terminates a durable job.")
  }
  if (action === "start") return classifyShellValue(args.command)
  return approval("unknown-shell-action", "This job action cannot be reliably classified.")
}

function classifyShellValue(value: unknown): ActionRisk {
  if (typeof value !== "string" || !value.trim()) {
    return approval("unknown-shell-command", "This shell action has no classifiable command.")
  }
  return classifyShellCommand(value)
}

export function classifyShellCommand(command: string): ActionRisk {
  for (const risk of COMMAND_RISKS) {
    if (risk.pattern.test(command)) return approval(risk.category, risk.reason)
  }
  if (NETWORK_CLIENT_RE.test(command) && NETWORK_MUTATION_RE.test(command)) {
    return approval("network-write", "This command performs a remote network mutation.")
  }
  if (SHELL_PIPE_RE.test(command) || REDIRECTION_RE.test(command)) {
    return approval(
      "unknown-shell-command",
      "This compound shell command cannot be reliably classified as low-risk."
    )
  }

  const parts = command
    .split("&&")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length > 0 && parts.every(isKnownLowRiskShellSegment)) return { level: "low" }

  return approval(
    "unknown-shell-command",
    "This shell command cannot be reliably classified as low-risk."
  )
}

function isKnownLowRiskShellSegment(command: string): boolean {
  return (
    SAFE_GIT_RE.test(command) ||
    SAFE_GIT_COMMIT_RE.test(command) ||
    SAFE_BUILD_RE.test(command) ||
    isLowRiskPackageScript(command) ||
    SAFE_SHELL_UTILITY_RE.test(command)
  )
}

function isLowRiskPackageScript(command: string): boolean {
  const match = PACKAGE_SCRIPT_RE.exec(command)
  // biome-ignore lint/suspicious/noUnnecessaryConditions: RegExp.exec can return null for arbitrary shell input at runtime.
  if (match === null) return false
  const script = match[1]
  if (!script) return false
  if (HIGH_RISK_SCRIPT_TOKEN_RE.test(script)) return false
  return LOW_RISK_SCRIPT_TOKEN_RE.test(script)
}

function resolveEffectiveCall(
  input: RuntimeAuthorizationInput
): RuntimeAuthorizationInput | undefined {
  if (input.toolName !== "tool_call") return undefined
  const tool = input.argumentsValue.tool
  if (typeof tool !== "string") return undefined
  const argumentsJson = input.argumentsValue.arguments_json
  let argumentsValue: Record<string, unknown> = {}
  if (typeof argumentsJson === "string") {
    try {
      const parsed: unknown = JSON.parse(argumentsJson)
      if (isRecord(parsed)) argumentsValue = parsed
    } catch {
      return {
        toolName: lazyToolName(tool),
        argumentsValue,
        source: input.source,
      }
    }
  }
  return {
    toolName: lazyToolName(tool),
    argumentsValue,
    source: input.source,
  }
}

function lazyToolName(value: string): string {
  const parts = value.split(":")
  return parts.length >= 3 ? parts.slice(2).join(":") : value
}

function actionCategory(
  action: string
):
  | "filesystem-destructive"
  | "process-control"
  | "package-removal"
  | "system-change"
  | "dangerous-action" {
  if (action === "delete" || action === "remove" || action === "purge" || action === "clear") {
    return "filesystem-destructive"
  }
  if (action === "stop" || action === "cancel" || action === "kill" || action === "terminate") {
    return "process-control"
  }
  if (action === "install" || action === "uninstall") return "package-removal"
  if (action === "reset") return "system-change"
  return "dangerous-action"
}

function approval(category: string, reason: string): ActionRisk {
  return { level: "approval", category, reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
