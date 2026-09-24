import type {
  Agent,
  AgentChangedEvent,
  AgentInstruction,
  CapabilityHealthSnapshot,
  CapabilityStoreEntry,
  McpServerMap,
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

export async function fetchStoreEntries(): Promise<CapabilityStoreEntry[]> {
  if (MOCK_DASHBOARD) {
    return [
      {
        id: "system-info",
        name: "System Info",
        description: "Local machine diagnostics.",
        kind: "toolbox",
        bundle: "system-info",
        tags: ["system", "diagnostics"],
        installed: false,
      },
    ]
  }
  const response = await fetch("/ui/api/store")
  if (!response.ok) throw new Error(`Failed to load Capability Store (${response.status})`)
  const body = (await response.json()) as { entries?: CapabilityStoreEntry[] }
  return body.entries ?? []
}

export async function installStoreEntry(id: string): Promise<void> {
  if (MOCK_DASHBOARD) return
  const response = await fetch(`/ui/api/store/${encodeURIComponent(id)}/install`, {
    method: "POST",
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
