import type {
  Agent,
  AgentChangedEvent,
  AgentInstruction,
  McpServerMap,
  SubagentConfig,
  ToolboxSnapshot,
} from "../types"

const now = Date.now()
let instructionCounter = 3

let agents: Agent[] = [
  {
    id: "agent-1",
    taskSlug: "redesign-shellby-dashboard",
    firstSeenAt: now - 28 * 60_000,
    lastSeenAt: now - 1_100,
    current: {
      id: "call-live-1",
      tool: "shell_run",
      summary: "npm run test",
      detail: "npm run test",
      detailLanguage: "bash",
      startedAt: now - 23_000,
      status: "running",
    },
    recent: [
      {
        id: "call-1",
        tool: "apply_patch",
        summary: "/Users/xiaopu/MyProject/openchatx-mcp",
        detail: "*** Begin Patch\n*** Update File: ui/src/App.tsx\n...\n*** End Patch",
        detailLanguage: "diff",
        startedAt: now - 58_000,
        finishedAt: now - 53_000,
        status: "completed",
      },
      {
        id: "call-2",
        tool: "shell_run",
        summary: "npm run lint",
        detail: "npm run lint",
        detailLanguage: "bash",
        startedAt: now - 92_000,
        finishedAt: now - 87_000,
        status: "completed",
      },
    ],
    instructions: [
      {
        id: "instruction-1",
        message: "先把 agent 狀態做清楚，再處理版面細節。",
        createdAt: now - 75_000,
        deliveredAt: now - 69_000,
      },
    ],
  },
  {
    id: "agent-2",
    taskSlug: "vdine-learning-loop-contract-fixes",
    firstSeenAt: now - 42 * 60_000,
    lastSeenAt: now - 6_500,
    current: {
      id: "call-live-2",
      tool: "mcp_api__generate_image",
      summary: "Generating product visual",
      startedAt: now - 41_000,
      status: "running",
    },
    recent: [
      {
        id: "call-3",
        tool: "shell_run",
        summary: "pnpm test contract",
        startedAt: now - 180_000,
        finishedAt: now - 173_000,
        status: "failed",
      },
      {
        id: "call-4",
        tool: "file_read",
        summary: "src/translation/fallback.ts",
        startedAt: now - 230_000,
        finishedAt: now - 229_000,
        status: "completed",
      },
    ],
    instructions: [
      {
        id: "instruction-2",
        message: "不要動 production DB。",
        createdAt: now - 30_000,
      },
    ],
  },
  {
    id: "agent-3",
    taskSlug: "fix-sword-back-socket",
    firstSeenAt: now - 2 * 60 * 60_000,
    lastSeenAt: now - 8 * 60_000,
    recent: [
      {
        id: "call-5",
        tool: "unreal_engine__execute_editor_command",
        summary: "Attach sword to spine socket",
        startedAt: now - 9 * 60_000,
        finishedAt: now - 8 * 60_000,
        status: "completed",
      },
      {
        id: "call-6",
        tool: "unreal_engine__get_selected_actors",
        summary: "BP_PlayerCharacter",
        startedAt: now - 10 * 60_000,
        finishedAt: now - 10 * 60_000 + 1_200,
        status: "completed",
      },
    ],
    instructions: [],
  },
]

const listeners = new Set<(event: AgentChangedEvent) => void>()

let mcpServers: McpServerMap = {
  blender: {
    type: "local",
    command: ["/opt/homebrew/bin/uvx", "blender-mcp"],
    enabled: true,
    description: "Blender control",
  },
  "unreal-engine": {
    type: "remote",
    url: "http://127.0.0.1:8000/mcp",
    enabled: true,
    timeout: 300000,
    description: "Unreal Engine MCP",
  },
  "open-computer-use": {
    type: "local",
    command: ["/opt/homebrew/bin/open-computer-use", "mcp"],
    enabled: true,
  },
  "mcp-api": {
    type: "remote",
    url: "https://mcp-api.vdineapp.com/mcp",
    enabled: true,
    headers: { Authorization: "Bearer ••••••••••••" },
    timeout: 900000,
    description: "VDine image / video / music tools",
  },
}

let subagentConfig: SubagentConfig = {
  providers: {},
  models: {},
}

let toolboxes: ToolboxSnapshot[] = [
  {
    id: "system",
    name: "System",
    description: "Required platform initialization tools.",
    enabled: true,
    builtin: "system",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/system",
    tools: [
      {
        name: "start_here",
        enabled: true,
        required: true,
        description: "Initialize the agent session.",
      },
    ],
    skills: [],
  },
  {
    id: "shell",
    name: "Shell",
    description: "Non-interactive commands and interactive terminal sessions.",
    enabled: true,
    builtin: "shell",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/shell",
    tools: ["bash", "terminal"].map((name) => ({ name, enabled: true, required: false })),
    skills: [],
  },
  {
    id: "files",
    name: "Files",
    description: "Local file reading, writing, and patch editing.",
    enabled: true,
    builtin: "files",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/files",
    tools: ["apply_patch", "file_read", "file_write", "file_edit"].map((name) => ({
      name,
      enabled: true,
      required: false,
    })),
    skills: [],
  },
  {
    id: "search",
    name: "Search",
    description: "Fast project file and content search without shell command construction.",
    enabled: true,
    builtin: "search",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/search",
    tools: ["glob", "grep"].map((name) => ({ name, enabled: true, required: false })),
    skills: [],
  },
  {
    id: "web",
    name: "Web",
    description: "HTTP and document fetching.",
    enabled: true,
    builtin: "web",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/web",
    tools: [{ name: "fetch_url", enabled: true, required: false }],
    skills: [],
  },
  {
    id: "media",
    name: "Media",
    description: "Local media inspection tools.",
    enabled: true,
    builtin: "media",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/media",
    tools: [{ name: "image_view", enabled: true, required: false }],
    skills: [],
  },
  {
    id: "skills",
    name: "Skills",
    description: "Reusable instruction bundles from the workspace and toolboxes.",
    enabled: true,
    builtin: "skills",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/skills",
    tools: ["skill_list", "skill_use"].map((name) => ({
      name,
      enabled: true,
      required: false,
    })),
    skills: [],
  },
  {
    id: "toolbox-manager",
    name: "Toolbox Manager",
    description: "Agent-facing management for plugins, TypeScript tools, and skills.",
    enabled: true,
    builtin: "toolbox-manager",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/toolbox-manager",
    tools: ["toolbox_list", "toolbox_manage"].map((name) => ({
      name,
      enabled: true,
      required: false,
    })),
    skills: [
      {
        name: "plugin-authoring",
        enabled: true,
        required: false,
        description: "Create plugins from natural-language user requests.",
        path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/toolbox-manager/skills/plugin-authoring/SKILL.md",
      },
    ],
  },
  {
    id: "mcp-manager",
    name: "MCP Manager",
    description: "Agent-facing management for external MCP server connections.",
    enabled: true,
    builtin: "mcp-manager",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/mcp-manager",
    tools: ["mcp_server_list", "mcp_server_manage"].map((name) => ({
      name,
      enabled: true,
      required: false,
    })),
    skills: [],
  },
  {
    id: "subagents",
    name: "Subagents",
    description: "Delegate work to curated provider-backed model profiles.",
    enabled: true,
    builtin: "subagents",
    path: "/Users/xiaopu/MyProject/openchatx-mcp/toolboxes/subagents",
    tools: ["subagent_list", "subagent_run"].map((name) => ({
      name,
      enabled: true,
      required: false,
    })),
    skills: [],
  },
]

export async function fetchMockAgents(): Promise<Agent[]> {
  return structuredClone(agents)
}

export function subscribeToMockAgents(
  onEvent: (event: AgentChangedEvent) => void,
  onConnection: (connected: boolean) => void
): () => void {
  listeners.add(onEvent)
  onConnection(true)
  return () => listeners.delete(onEvent)
}

export async function steerMockAgent(agentId: string, message: string): Promise<AgentInstruction> {
  const instruction: AgentInstruction = {
    id: `instruction-${instructionCounter++}`,
    message,
    createdAt: Date.now(),
  }
  updateAgent(agentId, (agent) => ({
    ...agent,
    instructions: [instruction, ...agent.instructions],
  }))
  return instruction
}

export async function cancelMockSteer(agentId: string, instructionId: string): Promise<void> {
  updateAgent(agentId, (agent) => ({
    ...agent,
    instructions: agent.instructions.filter((instruction) => instruction.id !== instructionId),
  }))
}

export async function fetchMockMcpServers(): Promise<McpServerMap> {
  return structuredClone(mcpServers)
}

export async function saveMockMcpServers(servers: McpServerMap): Promise<McpServerMap> {
  mcpServers = structuredClone(servers)
  return structuredClone(mcpServers)
}

export async function fetchMockSubagentConfig(): Promise<SubagentConfig> {
  return structuredClone(subagentConfig)
}

export async function saveMockSubagentConfig(config: SubagentConfig): Promise<SubagentConfig> {
  subagentConfig = structuredClone(config)
  return structuredClone(subagentConfig)
}

export async function fetchMockToolboxes(): Promise<ToolboxSnapshot[]> {
  return structuredClone(toolboxes)
}

export async function mutateMockToolboxes(
  mutate: (current: ToolboxSnapshot[]) => ToolboxSnapshot[]
): Promise<ToolboxSnapshot[]> {
  toolboxes = mutate(structuredClone(toolboxes))
  return structuredClone(toolboxes)
}

function updateAgent(agentId: string, update: (agent: Agent) => Agent): void {
  const index = agents.findIndex((agent) => agent.id === agentId)
  if (index === -1) throw new Error(`Unknown mock agent: ${agentId}`)
  const next = update(agents[index])
  agents = agents.map((agent, agentIndex) => (agentIndex === index ? next : agent))
  const event: AgentChangedEvent = { type: "agent_changed", agent: structuredClone(next) }
  for (const listener of listeners) listener(event)
}
