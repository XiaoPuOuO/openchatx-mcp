type AgentCallStatus = "running" | "completed" | "failed"

export interface AgentCall {
  id: string
  tool: string
  summary: string
  detail?: string
  detailLanguage?: string
  resultDetail?: string
  resultDetailLanguage?: string
  error?: string
  startedAt: number
  finishedAt?: number
  status: AgentCallStatus
}

export interface AgentInstruction {
  id: string
  message: string
  createdAt: number
  deliveredAt?: number
}

export interface Agent {
  id: string
  taskSlug?: string
  firstSeenAt: number
  lastSeenAt: number
  current?: AgentCall
  recent: AgentCall[]
  instructions: AgentInstruction[]
}

export interface AgentChangedEvent {
  type: "agent_changed"
  agent: Agent
}

export type CapabilityHealthStatus = "healthy" | "degraded" | "unavailable" | "disabled"

export interface CapabilityHealthComponent {
  id: string
  kind: "runtime" | "tunnel" | "mcp" | "toolbox" | "provider"
  name: string
  status: CapabilityHealthStatus
  detail?: string
}

export interface CapabilityHealthSnapshot {
  status: "healthy" | "degraded"
  checkedAt: string
  components: CapabilityHealthComponent[]
}

export interface CapabilityStoreEntry {
  id: string
  source: "builtin" | "github"
  name: string
  description: string
  kind: "toolbox"
  bundle?: string
  tags: string[]
  installed: boolean
  installedAt?: string
  repository?: string
  owner?: string
  htmlUrl?: string
  defaultBranch?: string
  stars?: number
  updatedAt?: string
  revision?: string
  manifest?: {
    schema_version: 1
    name: string
    description: string
    tags: string[]
    toolbox_path: string
    permissions: {
      shell: boolean
      network: boolean
      filesystem: boolean
      secrets: boolean
    }
  }
}

export interface RecommendedMcp {
  id: string
  name: string
  description: string
  publisher: string
  repository: string
  repositoryUrl: string
  tags: string[]
}

export interface CapabilityStoreSourceTree {
  capability: CapabilityStoreEntry
  revision?: string
  files: Array<{ path: string; size?: number }>
}

export interface CapabilityStoreReview {
  capability: CapabilityStoreEntry
  revision?: string
  summary: string
  declaredPermissions?: {
    shell: boolean
    network: boolean
    filesystem: boolean
    secrets: boolean
  }
  observedPermissions: {
    shell: boolean
    network: boolean
    filesystem: boolean
    secrets: boolean
  }
  findings: Array<{
    severity: "info" | "warning" | "high"
    category: string
    path: string
    detail: string
  }>
  reviewedFiles: number
  reviewedBytes: number
  note: string
}

export interface PlatformOverview {
  counts: {
    capabilities: number
    projects: number
    providers: number
    modelProfiles: number
    teams: number
    workflows: number
    nodes: number
    storeAvailable: number
  }
  projects: Array<{
    id: string
    name: string
    path: string
    permissions: {
      read: boolean
      write: boolean
      shell: boolean
    }
  }>
  currentWork: Array<{
    id: string
    label: string
    status: string
    cwd: string
    updatedAt: string
  }>
  needsAttention: Array<{
    id: string
    source: "health" | "job"
    label: string
    detail: string
  }>
}

interface McpServerBase {
  enabled: boolean
  description?: string
  timeout?: number
}

export interface LocalMcpServer extends McpServerBase {
  type: "local"
  command: string[]
  cwd?: string
  environment?: Record<string, string>
}

export interface RemoteMcpServer extends McpServerBase {
  type: "remote"
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = LocalMcpServer | RemoteMcpServer
export type McpServerMap = Record<string, McpServerConfig>

export interface ToolboxItem {
  name: string
  enabled: boolean
  required: boolean
  description?: string
  path?: string
  error?: string
}

export interface ToolboxSnapshot {
  id: string
  name: string
  description?: string
  enabled: boolean
  builtin?: string
  path: string
  tools: ToolboxItem[]
  skills: ToolboxItem[]
}

export interface SubagentProviderConfig {
  type: "openai-compatible"
  base_url: string
  enabled: boolean
  api_key?: string
  headers?: Record<string, string>
  timeout: number
  description?: string
}

export type SubagentThinkingConfig =
  | { mode: "none" }
  | {
      mode: "boolean"
      request_field: string
      default_enabled: boolean
    }
  | {
      mode: "effort"
      request_field: string
      levels: string[]
      default: string
      enabled_field?: string
      default_enabled: boolean
    }

export interface SubagentModelProfile {
  provider: string
  model: string
  name: string
  description: string
  enabled: boolean
  context_window: number
  max_output_tokens?: number
  thinking: SubagentThinkingConfig
  temperature?: number
  extra_body?: Record<string, unknown>
}

export interface SubagentConfig {
  providers: Record<string, SubagentProviderConfig>
  models: Record<string, SubagentModelProfile>
}
