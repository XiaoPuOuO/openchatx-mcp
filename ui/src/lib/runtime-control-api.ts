export type PermissionPolicy = "ask" | "allow" | "deny"
export type AccessMode = "always-question" | "allow-low-risk" | "full-access"
export type ToolRiskOverride = "low" | "approval"

export type RuntimeApproval = {
  id: string
  fingerprint: string
  toolName: string
  category: string
  reason: string
  createdAt: string
  status: "pending" | "approved-once" | "denied" | "consumed"
  input: unknown
  source?: { kind: "builtin" | "toolbox" | "mcp"; id?: string }
}

export type RuntimeControlState = {
  accessMode: AccessMode
  agentAccess: { paused: boolean; pausedAt?: string }
  dangerousActions: Record<string, PermissionPolicy>
  toolRiskOverrides: Record<string, ToolRiskOverride>
  notifications: {
    enabled: boolean
    agentCompleted: boolean
    approvalRequired: boolean
    tunnelDisconnected: boolean
    updateAvailable: boolean
    jobFinished: boolean
  }
  capabilityPermissions: Record<string, Record<string, PermissionPolicy>>
  approvals: RuntimeApproval[]
}

export type UnifiedProcess = {
  id: string
  kind: "runtime" | "mcp" | "sandbox" | "job" | "bash" | "terminal" | "shell" | "tunnel"
  label: string
  status: string
  startedAt?: string
  updatedAt?: string
  pid?: number
  threadId?: number
  restartCount?: number
  detail?: string
  canStop: boolean
  canRestart: boolean
}

export type RecentWorkItem = {
  id: string
  projectId?: string
  projectName?: string
  agentId?: string
  title: string
  lastActivityAt: string
  activeGoals: Array<{ id: string; title: string; status: string }>
  recentEvents: TimelineEvent[]
}

export type TimelineEvent = {
  id: string
  timestamp: string
  type:
    | "tool-started"
    | "tool-completed"
    | "tool-failed"
    | "tool-interrupted"
    | "approval"
    | "system"
    | "project"
  label: string
  detail?: string
  projectId?: string
  agentId?: string
  toolName?: string
  input?: unknown
}

export async function fetchRuntimeControl(): Promise<RuntimeControlState> {
  return fetchJson("/ui/api/runtime-control")
}

export async function setAccessMode(mode: AccessMode): Promise<void> {
  const body =
    mode === "full-access"
      ? {
          mode,
          firstRiskConfirmation: true,
          secondRiskConfirmation: true,
          confirmationCode: "FULL_ACCESS_TRUST_MODE",
        }
      : { mode }
  await fetchJson("/ui/api/runtime-control/access-mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

export async function setAgentAccessPaused(
  paused: boolean,
  stopRunning = paused
): Promise<{ stopped: number }> {
  return fetchJson("/ui/api/runtime-control/pause", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused, stopRunning }),
  })
}

export async function updateDangerousActionPolicy(
  category: string,
  policy: PermissionPolicy
): Promise<void> {
  await fetchJson("/ui/api/runtime-control/dangerous-actions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, policy }),
  })
}

export async function updateToolRiskOverride(
  key: string,
  risk: ToolRiskOverride | undefined
): Promise<void> {
  await fetchJson("/ui/api/runtime-control/tool-risk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, risk: risk ?? null }),
  })
}

export async function updateNotificationSettings(
  settings: Partial<RuntimeControlState["notifications"]>
): Promise<void> {
  await fetchJson("/ui/api/runtime-control/notifications", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })
}

export async function decideApproval(
  id: string,
  decision: "approve-once" | "always-allow" | "deny"
): Promise<void> {
  await fetchJson(`/ui/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  })
}

export async function fetchProcesses(): Promise<UnifiedProcess[]> {
  const body = await fetchJson<{ processes?: UnifiedProcess[] }>("/ui/api/processes")
  return body.processes ?? []
}

export async function stopProcess(id: string): Promise<void> {
  await fetchJson(`/ui/api/processes/${encodeURIComponent(id)}/stop`, { method: "POST" })
}

export async function restartProcess(id: string): Promise<void> {
  await fetchJson(`/ui/api/processes/${encodeURIComponent(id)}/restart`, { method: "POST" })
}

export async function fetchRecentWork(): Promise<RecentWorkItem[]> {
  const body = await fetchJson<{ items?: RecentWorkItem[] }>("/ui/api/recent-work")
  return body.items ?? []
}

export async function resumeRecentWork(input: {
  projectId?: string
  agentId?: string
}): Promise<{ uuid: string; content: string }> {
  return fetchJson("/ui/api/recent-work/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export async function fetchTimeline(
  input: { projectId?: string; agentId?: string; type?: TimelineEvent["type"]; limit?: number } = {}
): Promise<TimelineEvent[]> {
  const params = new URLSearchParams()
  if (input.projectId) params.set("projectId", input.projectId)
  if (input.agentId) params.set("agentId", input.agentId)
  if (input.type) params.set("type", input.type)
  if (input.limit) params.set("limit", String(input.limit))
  const suffix = params.size ? `?${params.toString()}` : ""
  const body = await fetchJson<{ events?: TimelineEvent[] }>(`/ui/api/timeline${suffix}`)
  return body.events ?? []
}

async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => undefined)) as
    | (T & { error?: string })
    | undefined
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed (${response.status})`)
  }
  return body as T
}
