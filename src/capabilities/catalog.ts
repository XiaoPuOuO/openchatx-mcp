import type { ExternalMcpRegistry } from "../external-mcp/registry.js"
import type { SubagentRuntime } from "../subagents/runtime.js"
import type { ToolboxRegistry } from "../toolbox/registry.js"

export type CapabilityKind = "mcp" | "toolbox" | "agent" | "provider"
export type CapabilityInvocation = "tool_search" | "subagent_run" | "provider"

export interface CapabilityDescriptor {
  id: string
  name: string
  description?: string
  kind: CapabilityKind
  invocation: CapabilityInvocation
  available: boolean
  toolCount?: number
  skillCount?: number
  profileCount?: number
}

const WHITESPACE_RE = /\s+/u

export class CapabilityRegistry {
  constructor(
    private readonly externalMcp?: ExternalMcpRegistry,
    private readonly toolboxes?: ToolboxRegistry,
    private readonly subagents?: SubagentRuntime
  ) {}

  list(): CapabilityDescriptor[] {
    return [
      ...this.mcpCapabilities(),
      ...this.toolboxCapabilities(),
      ...this.agentCapabilities(),
      ...this.providerCapabilities(),
    ].sort((left, right) => left.id.localeCompare(right.id))
  }

  search(query: string, limit = 20): CapabilityDescriptor[] {
    const terms = query.toLowerCase().split(WHITESPACE_RE).filter(Boolean)
    if (terms.length === 0) return this.list().slice(0, limit)
    return this.list()
      .map((capability) => ({ capability, score: score(capability, terms) }))
      .filter(({ score: value }) => value > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.capability.id.localeCompare(right.capability.id)
      )
      .slice(0, limit)
      .map(({ capability }) => capability)
  }

  private mcpCapabilities(): CapabilityDescriptor[] {
    return (
      this.externalMcp?.capabilities().map((capability) => ({
        id: capability.id,
        name: capability.name,
        description: capability.description,
        kind: "mcp" as const,
        invocation: "tool_search" as const,
        available: capability.available,
        toolCount: capability.toolCount,
      })) ?? []
    )
  }

  private toolboxCapabilities(): CapabilityDescriptor[] {
    return (
      this.toolboxes
        ?.snapshots()
        .filter((toolbox) => !toolbox.builtin)
        .map((toolbox) => ({
          id: toolbox.id,
          name: toolbox.name,
          description: toolbox.description,
          kind: "toolbox" as const,
          invocation: "tool_search" as const,
          available: toolbox.enabled,
          toolCount: toolbox.tools.filter((tool) => tool.enabled).length,
          skillCount: toolbox.skills.filter((skill) => skill.enabled).length,
        })) ?? []
    )
  }

  private agentCapabilities(): CapabilityDescriptor[] {
    return (
      this.subagents?.profiles().map((profile) => ({
        id: profile.id,
        name: profile.name,
        description: profile.description,
        kind: "agent" as const,
        invocation: "subagent_run" as const,
        available: true,
      })) ?? []
    )
  }

  private providerCapabilities(): CapabilityDescriptor[] {
    return (
      this.subagents?.providerSummaries().map((provider) => ({
        id: `provider:${provider.id}`,
        name: provider.id,
        description: `${provider.profileCount} enabled model profile${provider.profileCount === 1 ? "" : "s"}`,
        kind: "provider" as const,
        invocation: "provider" as const,
        available: provider.enabled,
        profileCount: provider.profileCount,
      })) ?? []
    )
  }
}

function score(capability: CapabilityDescriptor, terms: string[]) {
  const id = capability.id.toLowerCase()
  const name = capability.name.toLowerCase()
  const description = capability.description?.toLowerCase() ?? ""
  let value = 0
  for (const term of terms) {
    if (name === term || id === term) value += 20
    else {
      if (name.includes(term)) value += 10
      if (id.includes(term)) value += 8
    }
    if (description.includes(term)) value += 3
  }
  return value
}
