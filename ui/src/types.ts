type AgentCallStatus = "running" | "completed" | "failed"

export interface AgentCall {
  id: string
  tool: string
  summary: string
  detail?: string
  detailLanguage?: string
  resultDetail?: string
  resultDetailLanguage?: string
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
