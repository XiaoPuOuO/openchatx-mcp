export type AgentCallStatus = "running" | "completed" | "failed"

export interface AgentCall {
  id: string
  tool: string
  summary: string
  detail?: string
  detailLanguage?: string
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
