import type {
  Agent,
  AgentEvent,
  AgentInstruction,
  CapabilityHealthSnapshot,
  CapabilityStoreEntry,
  CapabilityStoreReview,
  CapabilityStoreSourceTree,
  GoalRecord,
  GoalStatus,
  LoadedRule,
  McpServerMap,
  PlatformOverview,
  ProjectRecord,
  RecommendedMcp,
  RuleMode,
  RuleSummary,
  SubagentConfig,
  ToolboxSnapshot,
} from "../types"
import {
  cancelMockSteer,
  deleteMockAgent,
  fetchMockAgents,
  fetchMockMcpServers,
  fetchMockSubagentConfig,
  fetchMockToolboxes,
  mutateMockToolboxes,
  saveMockMcpServers,
  saveMockSubagentConfig,
  steerMockAgent,
  subscribeToMockAgents,
} from "./mock-api"

const MOCK_DASHBOARD = import.meta.env.VITE_MOCK_DASHBOARD === "1"

export async function fetchAgents(): Promise<Agent[]> {
  if (MOCK_DASHBOARD) return fetchMockAgents()
  const response = await fetch("/ui/api/agents")
  if (!response.ok) throw new Error(`Failed to load agents (${response.status})`)
  const body = (await response.json()) as { agents?: Agent[] }
  return body.agents ?? []
}

export async function deleteAgent(agentId: string): Promise<void> {
  if (MOCK_DASHBOARD) return deleteMockAgent(agentId)
  const response = await fetch(`/ui/api/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to delete agent (${response.status})`)
  }
}

export async function fetchCapabilityHealth(): Promise<CapabilityHealthSnapshot> {
  if (MOCK_DASHBOARD) {
    return {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      components: [
        { id: "openchatx", kind: "runtime", name: "OpenChatX Runtime", status: "healthy" },
        {
          id: "tunnel",
          kind: "tunnel",
          name: "OpenAI Secure MCP Tunnel",
          status: "healthy",
          detail: "profile openchatx",
        },
      ],
    }
  }
  const response = await fetch("/ui/api/health")
  if (!response.ok) throw new Error(`Failed to load capability health (${response.status})`)
  return (await response.json()) as CapabilityHealthSnapshot
}

export async function fetchPlatformOverview(): Promise<PlatformOverview> {
  if (MOCK_DASHBOARD) {
    return {
      counts: {
        capabilities: 8,
        projects: 2,
        providers: 2,
        modelProfiles: 3,
        teams: 1,
        workflows: 2,
        nodes: 1,
        storeAvailable: 1,
      },
      projects: [
        {
          id: "openchatx",
          name: "OpenChatX",
          path: "/mock/openchatx-mcp",
          permissions: { read: true, write: true, shell: true },
          activeAgents: 1,
          runningJobs: 0,
        },
      ],
      currentWork: [],
      needsAttention: [],
    }
  }
  const response = await fetch("/ui/api/platform")
  if (!response.ok) throw new Error(`Failed to load platform overview (${response.status})`)
  return (await response.json()) as PlatformOverview
}

export type UpdateCheck = {
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  releaseUrl?: string
  checkedAt?: string
  error?: string
}

export async function fetchUpdateCheck(force = false): Promise<UpdateCheck> {
  if (MOCK_DASHBOARD) {
    return { currentVersion: "0.2.0", updateAvailable: false }
  }
  const response = await fetch(`/ui/api/update${force ? "?force=1" : ""}`)
  const body = (await response.json().catch(() => undefined)) as UpdateCheck | undefined
  if (!response.ok && !body) throw new Error(`Failed to check for updates (${response.status})`)
  return body ?? { currentVersion: "unknown", updateAvailable: false }
}

export async function fetchProjects(): Promise<ProjectRecord[]> {
  if (MOCK_DASHBOARD) return []
  const response = await fetch("/ui/api/projects")
  if (!response.ok) throw new Error(`Failed to load projects (${response.status})`)
  const body = (await response.json()) as { projects?: ProjectRecord[] }
  return body.projects ?? []
}

export async function createProject(input: {
  id: string
  name: string
  path: string
  additionalPaths?: string[]
  description?: string
  permissions: ProjectRecord["permissions"]
}): Promise<ProjectRecord> {
  if (MOCK_DASHBOARD) {
    const now = new Date().toISOString()
    return {
      ...input,
      additionalPaths: input.additionalPaths ?? [],
      createdAt: now,
      updatedAt: now,
    }
  }
  const response = await fetch("/ui/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { project?: ProjectRecord; error?: string }
    | undefined
  if (!response.ok) throw new Error(body?.error ?? `Failed to create project (${response.status})`)
  if (!body?.project) throw new Error("Project response was missing the created project.")
  return body.project
}

export async function updateProject(
  id: string,
  input: Partial<
    Pick<ProjectRecord, "name" | "path" | "additionalPaths" | "description" | "permissions">
  >
): Promise<ProjectRecord> {
  if (MOCK_DASHBOARD) {
    const now = new Date().toISOString()
    return {
      id,
      name: input.name ?? id,
      path: input.path ?? "/mock/project",
      additionalPaths: input.additionalPaths ?? [],
      description: input.description,
      permissions: input.permissions ?? { read: true, write: true, shell: true },
      createdAt: now,
      updatedAt: now,
    }
  }
  const response = await fetch(`/ui/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { project?: ProjectRecord; error?: string }
    | undefined
  if (!response.ok) throw new Error(body?.error ?? `Failed to update project (${response.status})`)
  if (!body?.project) throw new Error("Project response was missing the updated project.")
  return body.project
}

export async function deleteProject(id: string): Promise<void> {
  if (MOCK_DASHBOARD) return
  const response = await fetch(`/ui/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to delete project (${response.status})`)
  }
}

export async function fetchGoals(
  filter: { projectId?: string; status?: GoalStatus } = {}
): Promise<GoalRecord[]> {
  if (MOCK_DASHBOARD) return []
  const params = new URLSearchParams()
  if (filter.projectId) params.set("project_id", filter.projectId)
  if (filter.status) params.set("status", filter.status)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  const response = await fetch(`/ui/api/goals${suffix}`)
  if (!response.ok) throw new Error(`Failed to load goals (${response.status})`)
  const body = (await response.json()) as { goals?: GoalRecord[] }
  return body.goals ?? []
}

export async function createGoal(input: {
  id: string
  title: string
  description?: string
  projectId?: string
}): Promise<GoalRecord> {
  if (MOCK_DASHBOARD) {
    const now = new Date().toISOString()
    return { ...input, status: "pending", createdAt: now, updatedAt: now }
  }
  const response = await fetch("/ui/api/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { goal?: GoalRecord; error?: string }
    | undefined
  if (!response.ok) throw new Error(body?.error ?? `Failed to create goal (${response.status})`)
  if (!body?.goal) throw new Error("Goal response was missing the created goal.")
  return body.goal
}

export async function updateGoal(
  id: string,
  input: Partial<Pick<GoalRecord, "title" | "description" | "projectId" | "status">> & {
    description?: string | null
    projectId?: string | null
  }
): Promise<GoalRecord> {
  if (MOCK_DASHBOARD) {
    const now = new Date().toISOString()
    return {
      id,
      title: input.title ?? id,
      description: input.description ?? undefined,
      projectId: input.projectId ?? undefined,
      status: input.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    }
  }
  const response = await fetch(`/ui/api/goals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { goal?: GoalRecord; error?: string }
    | undefined
  if (!response.ok) throw new Error(body?.error ?? `Failed to update goal (${response.status})`)
  if (!body?.goal) throw new Error("Goal response was missing the updated goal.")
  return body.goal
}

export async function deleteGoal(id: string): Promise<void> {
  if (MOCK_DASHBOARD) return
  const response = await fetch(`/ui/api/goals/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to delete goal (${response.status})`)
  }
}

export async function fetchStoreEntries(
  query = "",
  source: "all" | "builtin" | "community" = "all"
): Promise<{
  entries: CapabilityStoreEntry[]
  recommendedMcps: RecommendedMcp[]
  communityError?: string
}> {
  if (MOCK_DASHBOARD) {
    return {
      recommendedMcps: [],
      entries: [
        {
          id: "system-info",
          source: "builtin",
          name: "System Info",
          description: "Local machine diagnostics.",
          kind: "toolbox",
          bundle: "system-info",
          tags: ["system", "diagnostics"],
          installed: false,
        },
        {
          id: "github:example/openchatx-demo",
          source: "github",
          repository: "example/openchatx-demo",
          owner: "example",
          name: "openchatx-demo",
          description: "Community capability example",
          kind: "toolbox",
          tags: [],
          installed: false,
          htmlUrl: "https://github.com/example/openchatx-demo",
          defaultBranch: "main",
          stars: 42,
          updatedAt: new Date().toISOString(),
        },
      ],
    }
  }
  const params = new URLSearchParams()
  if (query) params.set("q", query)
  if (source !== "all") params.set("source", source)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  const response = await fetch(`/ui/api/store${suffix}`)
  if (!response.ok) throw new Error(`Failed to load Capability Store (${response.status})`)
  return (await response.json()) as {
    entries: CapabilityStoreEntry[]
    recommendedMcps: RecommendedMcp[]
    communityError?: string
  }
}

export async function fetchStoreSourceTree(
  id: string,
  revision?: string
): Promise<CapabilityStoreSourceTree> {
  if (MOCK_DASHBOARD) {
    const community = id.startsWith("github:")
    return {
      capability: {
        id,
        source: community ? "github" : "builtin",
        name: community ? "openchatx-demo" : "System Info",
        description: community ? "Community capability example" : "Local machine diagnostics.",
        kind: "toolbox",
        tags: community ? ["demo"] : ["system"],
        installed: false,
        ...(community
          ? {
              repository: "example/openchatx-demo",
              owner: "example",
              htmlUrl: "https://github.com/example/openchatx-demo",
              defaultBranch: "main",
              stars: 42,
              updatedAt: new Date().toISOString(),
              revision: revision ?? "abc123",
            }
          : { bundle: "system-info" }),
      },
      ...(community ? { revision: revision ?? "abc123" } : {}),
      files: [
        { path: community ? "capability.json" : "toolbox.json", size: 120 },
        { path: "tools/example.ts", size: 180 },
      ],
    }
  }
  const params = new URLSearchParams()
  if (revision) params.set("revision", revision)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  const response = await fetch(`/ui/api/store/${encodeURIComponent(id)}/source-tree${suffix}`)
  if (!response.ok) throw new Error(`Failed to load capability source tree (${response.status})`)
  return (await response.json()) as CapabilityStoreSourceTree
}

export async function fetchStoreSourceFile(
  id: string,
  path: string,
  revision?: string
): Promise<{ path: string; content: string; revision?: string }> {
  if (MOCK_DASHBOARD) {
    return {
      path,
      content: `// Mock source for ${id}\nexport const example = true\n`,
      ...(revision ? { revision } : {}),
    }
  }
  const params = new URLSearchParams({ path })
  if (revision) params.set("revision", revision)
  const response = await fetch(
    `/ui/api/store/${encodeURIComponent(id)}/source?${params.toString()}`
  )
  if (!response.ok) throw new Error(`Failed to load capability source (${response.status})`)
  return (await response.json()) as { path: string; content: string; revision?: string }
}

export async function fetchStoreReview(
  id: string,
  revision?: string
): Promise<CapabilityStoreReview> {
  if (MOCK_DASHBOARD) {
    const tree = await fetchStoreSourceTree(id, revision)
    return {
      capability: tree.capability,
      ...(tree.revision ? { revision: tree.revision } : {}),
      summary: "No obvious high-risk patterns were found in the reviewed text files.",
      observedPermissions: {
        shell: false,
        network: false,
        filesystem: false,
        secrets: false,
      },
      findings: [],
      reviewedFiles: tree.files.length,
      reviewedBytes: 300,
      note: "Mock static analysis result.",
    }
  }
  const params = new URLSearchParams()
  if (revision) params.set("revision", revision)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  const response = await fetch(`/ui/api/store/${encodeURIComponent(id)}/review${suffix}`)
  if (!response.ok) throw new Error(`Failed to review capability (${response.status})`)
  return (await response.json()) as CapabilityStoreReview
}

export async function installStoreEntry(id: string, revision?: string): Promise<void> {
  if (MOCK_DASHBOARD) return
  const response = await fetch(`/ui/api/store/${encodeURIComponent(id)}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Capability install failed (${response.status})`)
  }
}

export async function uninstallStoreEntry(id: string): Promise<void> {
  if (MOCK_DASHBOARD) return
  const response = await fetch(`/ui/api/store/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Capability uninstall failed (${response.status})`)
  }
}

export function subscribeToAgents(
  onEvent: (event: AgentEvent) => void,
  onConnection: (connected: boolean) => void
): () => void {
  if (MOCK_DASHBOARD) return subscribeToMockAgents(onEvent, onConnection)
  const source = new EventSource("/ui/api/events")
  source.onopen = () => onConnection(true)
  source.onerror = () => onConnection(false)
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as AgentEvent
    if (event.type === "agent_changed" || event.type === "agent_removed") onEvent(event)
  }
  return () => source.close()
}

export async function steerAgent(agentId: string, message: string): Promise<AgentInstruction> {
  if (MOCK_DASHBOARD) return steerMockAgent(agentId, message)
  const response = await fetch(`/ui/api/agents/${encodeURIComponent(agentId)}/steer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to steer agent (${response.status})`)
  }
  const body = (await response.json()) as { instruction: AgentInstruction }
  return body.instruction
}

export async function cancelSteer(agentId: string, instructionId: string): Promise<void> {
  if (MOCK_DASHBOARD) return cancelMockSteer(agentId, instructionId)
  const response = await fetch(
    `/ui/api/agents/${encodeURIComponent(agentId)}/instructions/${encodeURIComponent(instructionId)}`,
    { method: "DELETE" }
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to cancel steer (${response.status})`)
  }
}

export async function fetchMcpServers(): Promise<McpServerMap> {
  if (MOCK_DASHBOARD) return fetchMockMcpServers()
  const response = await fetch("/ui/api/mcp-servers")
  if (!response.ok) throw new Error(`Failed to load MCP servers (${response.status})`)
  const body = (await response.json()) as { servers?: McpServerMap }
  return body.servers ?? {}
}

export async function saveMcpServers(
  servers: McpServerMap
): Promise<{ servers: McpServerMap; restartRequired: boolean }> {
  if (MOCK_DASHBOARD) {
    return { servers: await saveMockMcpServers(servers), restartRequired: false }
  }
  const response = await fetch("/ui/api/mcp-servers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ servers }),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { servers?: McpServerMap; restartRequired?: boolean; error?: string }
    | undefined
  if (!response.ok)
    throw new Error(body?.error ?? `Failed to save MCP servers (${response.status})`)
  return {
    servers: body?.servers ?? servers,
    restartRequired: body?.restartRequired ?? false,
  }
}

export async function openMcpConfigInFinder(): Promise<boolean> {
  if (MOCK_DASHBOARD) return false
  const response = await fetch("/ui/api/mcp-servers/open-in-finder", { method: "POST" })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to open Finder (${response.status})`)
  }
  return true
}

export async function fetchSubagentConfig(): Promise<SubagentConfig> {
  if (MOCK_DASHBOARD) return fetchMockSubagentConfig()
  const response = await fetch("/ui/api/subagents")
  if (!response.ok) throw new Error(`Failed to load subagent config (${response.status})`)
  const body = (await response.json()) as { config?: SubagentConfig }
  return body.config ?? { providers: {}, models: {} }
}

export async function saveSubagentConfig(
  config: SubagentConfig
): Promise<{ config: SubagentConfig; restartRequired: boolean }> {
  if (MOCK_DASHBOARD) {
    return { config: await saveMockSubagentConfig(config), restartRequired: false }
  }
  const response = await fetch("/ui/api/subagents", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { config?: SubagentConfig; restartRequired?: boolean; error?: string }
    | undefined
  if (!response.ok)
    throw new Error(body?.error ?? `Failed to save subagent config (${response.status})`)
  return {
    config: body?.config ?? config,
    restartRequired: body?.restartRequired ?? false,
  }
}

export async function openSubagentConfigInFinder(): Promise<boolean> {
  if (MOCK_DASHBOARD) return false
  const response = await fetch("/ui/api/subagents/open-in-finder", { method: "POST" })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to open Finder (${response.status})`)
  }
  return true
}

export async function fetchAgentInstructions(): Promise<{ path: string; content: string }> {
  if (MOCK_DASHBOARD) {
    return {
      path: "/mock/AGENTS.md",
      content:
        "# OpenChatX Agent Instructions\n\n{{MODE_INSTRUCTIONS}}\n\n{{PROJECT_CONTEXT}}\n\n{{CAPABILITY_CATALOG}}\n\n{{ALWAYS_RULES}}\n",
    }
  }
  const response = await fetch("/ui/api/agent-instructions")
  const body = (await response.json().catch(() => undefined)) as
    | { path?: string; content?: string; error?: string }
    | undefined
  if (!response.ok || body?.content === undefined || !body.path) {
    throw new Error(body?.error ?? `Failed to load AGENTS.md (${response.status})`)
  }
  return { path: body.path, content: body.content }
}

export async function saveAgentInstructions(
  content: string
): Promise<{ path: string; content: string }> {
  if (MOCK_DASHBOARD) return { path: "/mock/AGENTS.md", content }
  const response = await fetch("/ui/api/agent-instructions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { path?: string; content?: string; error?: string }
    | undefined
  if (!response.ok || body?.content === undefined || !body.path) {
    throw new Error(body?.error ?? `Failed to save AGENTS.md (${response.status})`)
  }
  return { path: body.path, content: body.content }
}

export async function openAgentInstructionsInFinder(): Promise<boolean> {
  if (MOCK_DASHBOARD) return false
  const response = await fetch("/ui/api/agent-instructions/open-in-finder", { method: "POST" })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to open Finder (${response.status})`)
  }
  return true
}

export async function fetchToolboxes(): Promise<ToolboxSnapshot[]> {
  if (MOCK_DASHBOARD) return fetchMockToolboxes()
  const response = await fetch("/ui/api/toolboxes")
  if (!response.ok) throw new Error(`Failed to load toolboxes (${response.status})`)
  const body = (await response.json()) as { toolboxes?: ToolboxSnapshot[] }
  return body.toolboxes ?? []
}

async function toolboxRequest(
  url: string,
  options: RequestInit,
  mockMutation?: (current: ToolboxSnapshot[]) => ToolboxSnapshot[]
): Promise<ToolboxSnapshot[]> {
  if (MOCK_DASHBOARD) {
    return mockMutation ? mutateMockToolboxes(mockMutation) : fetchMockToolboxes()
  }
  const response = await fetch(url, options)
  const body = (await response.json().catch(() => undefined)) as
    | { toolboxes?: ToolboxSnapshot[]; error?: string }
    | undefined
  if (!response.ok) throw new Error(body?.error ?? `Toolbox request failed (${response.status})`)
  return body?.toolboxes ?? []
}

export function reloadToolboxes(): Promise<ToolboxSnapshot[]> {
  return toolboxRequest("/ui/api/toolboxes/reload", { method: "POST" })
}

export function createToolbox(id: string): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    "/ui/api/toolboxes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: id }),
    },
    (current) => [
      ...current,
      {
        id,
        name: id,
        enabled: true,
        dynamic: true,
        path: `/mock/toolboxes/${id}`,
        tools: [],
        skills: [],
      },
    ]
  )
}

export function setToolboxEnabled(id: string, enabled: boolean): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
    (current) => current.map((box) => (box.id === id ? { ...box, enabled } : box))
  )
}

export function setToolboxDynamic(id: string, dynamic: boolean): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dynamic }),
    },
    (current) => current.map((box) => (box.id === id ? { ...box, dynamic } : box))
  )
}

export function deleteToolbox(id: string): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    (current) => current.filter((box) => box.id !== id)
  )
}

export function setToolEnabled(
  toolboxId: string,
  toolName: string,
  enabled: boolean
): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/tools/${encodeURIComponent(toolName)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
    (current) =>
      current.map((box) =>
        box.id === toolboxId
          ? {
              ...box,
              tools: box.tools.map((tool) =>
                tool.name === toolName ? { ...tool, enabled } : tool
              ),
            }
          : box
      )
  )
}

export function setToolboxSkillEnabled(
  toolboxId: string,
  skillName: string,
  enabled: boolean
): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/skills/${encodeURIComponent(skillName)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
    (current) =>
      current.map((box) =>
        box.id === toolboxId
          ? {
              ...box,
              skills: box.skills.map((skill) =>
                skill.name === skillName ? { ...skill, enabled } : skill
              ),
            }
          : box
      )
  )
}

export function createTool(toolboxId: string, name: string): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/tools`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
    (current) =>
      current.map((box) =>
        box.id === toolboxId
          ? {
              ...box,
              tools: [
                ...box.tools,
                {
                  name,
                  enabled: true,
                  required: false,
                  path: `/mock/${toolboxId}/tools/${name}.ts`,
                },
              ],
            }
          : box
      )
  )
}

export function deleteTool(toolboxId: string, name: string): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/tools/${encodeURIComponent(name)}`,
    { method: "DELETE" },
    (current) =>
      current.map((box) =>
        box.id === toolboxId
          ? { ...box, tools: box.tools.filter((tool) => tool.name !== name) }
          : box
      )
  )
}

export function createToolboxSkill(toolboxId: string, name: string): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/skills`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
    (current) =>
      current.map((box) =>
        box.id === toolboxId
          ? {
              ...box,
              skills: [
                ...box.skills,
                {
                  name,
                  enabled: true,
                  required: false,
                  path: `/mock/${toolboxId}/skills/${name}/SKILL.md`,
                },
              ],
            }
          : box
      )
  )
}

export function deleteToolboxSkill(toolboxId: string, name: string): Promise<ToolboxSnapshot[]> {
  return toolboxRequest(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/skills/${encodeURIComponent(name)}`,
    { method: "DELETE" },
    (current) =>
      current.map((box) =>
        box.id === toolboxId
          ? { ...box, skills: box.skills.filter((skill) => skill.name !== name) }
          : box
      )
  )
}

export async function openToolboxInFinder(
  toolboxId: string,
  kind?: "tool" | "skill",
  name?: string
): Promise<boolean> {
  if (MOCK_DASHBOARD) return false
  const response = await fetch(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/open-in-finder`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name }),
    }
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    throw new Error(body?.error ?? `Failed to open Finder (${response.status})`)
  }
  return true
}

export async function fetchRules(toolboxId: string): Promise<RuleSummary[]> {
  if (MOCK_DASHBOARD) return []
  const response = await fetch(`/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/rules`)
  if (!response.ok) throw new Error(`Failed to load rules (${response.status})`)
  const body = (await response.json()) as { rules?: RuleSummary[] }
  return body.rules ?? []
}

export async function fetchRule(toolboxId: string, name: string): Promise<LoadedRule> {
  const response = await fetch(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/rules/${encodeURIComponent(name)}`
  )
  const body = (await response.json().catch(() => undefined)) as
    | { rule?: LoadedRule; error?: string }
    | undefined
  if (!response.ok || !body?.rule) {
    throw new Error(body?.error ?? `Failed to load rule (${response.status})`)
  }
  return body.rule
}

export async function saveRule(input: {
  toolboxId: string
  originalName?: string
  name: string
  mode: RuleMode
  description?: string
  globs?: string[]
  markdown: string
}): Promise<RuleSummary[]> {
  const response = await fetch(
    input.originalName
      ? `/ui/api/toolboxes/${encodeURIComponent(input.toolboxId)}/rules/${encodeURIComponent(input.originalName)}`
      : `/ui/api/toolboxes/${encodeURIComponent(input.toolboxId)}/rules`,
    {
      method: input.originalName ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        description:
          input.mode === "agent_requested" ? (input.description ?? "") : input.description,
        globs: input.mode === "auto_attached" ? (input.globs ?? []) : [],
        alwaysApply: input.mode === "always",
        markdown: input.markdown,
      }),
    }
  )
  const body = (await response.json().catch(() => undefined)) as
    | { rules?: RuleSummary[]; error?: string }
    | undefined
  if (!response.ok) throw new Error(body?.error ?? `Rule save failed (${response.status})`)
  return body?.rules ?? []
}

export async function deleteRule(toolboxId: string, name: string): Promise<RuleSummary[]> {
  const response = await fetch(
    `/ui/api/toolboxes/${encodeURIComponent(toolboxId)}/rules/${encodeURIComponent(name)}`,
    { method: "DELETE" }
  )
  const body = (await response.json().catch(() => undefined)) as
    | { rules?: RuleSummary[]; error?: string }
    | undefined
  if (!response.ok) throw new Error(body?.error ?? `Rule delete failed (${response.status})`)
  return body?.rules ?? []
}
