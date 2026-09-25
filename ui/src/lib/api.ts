import type {
  Agent,
  AgentChangedEvent,
  AgentInstruction,
  CapabilityHealthSnapshot,
  CapabilityStoreEntry,
  CapabilityStoreReview,
  CapabilityStoreSourceTree,
  McpServerMap,
  PlatformOverview,
  SubagentConfig,
  ToolboxSnapshot,
} from "../types"
import {
  cancelMockSteer,
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

export async function fetchStoreEntries(
  query = "",
  source: "all" | "builtin" | "community" = "all"
): Promise<{ entries: CapabilityStoreEntry[]; communityError?: string }> {
  if (MOCK_DASHBOARD) {
    return {
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
  onEvent: (event: AgentChangedEvent) => void,
  onConnection: (connected: boolean) => void
): () => void {
  if (MOCK_DASHBOARD) return subscribeToMockAgents(onEvent, onConnection)
  const source = new EventSource("/ui/api/events")
  source.onopen = () => onConnection(true)
  source.onerror = () => onConnection(false)
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as AgentChangedEvent
    if (event.type === "agent_changed") onEvent(event)
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
      { id, name: id, enabled: true, path: `/mock/toolboxes/${id}`, tools: [], skills: [] },
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
