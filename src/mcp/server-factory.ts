import { McpServer } from "@modelcontextprotocol/server"
import type { AgentObserver } from "../agent/observer.js"
import { buildMcpInstructions, MCP_CONFIG } from "../config.js"
import type { McpAuditRequest } from "../server/audit/audit-log.js"
import { registerApplyPatchTool } from "../tools/apply-patch/apply-patch.js"
import { registerComputerUseTools } from "../tools/computer/computer-tools.js"
import type { PeekabooClient } from "../tools/computer/peekaboo.js"
import { registerCloneTools } from "../tools/delegation/clone-tools.js"
import type { ChatGptDelegationService } from "../tools/delegation/contracts.js"
import { registerSubagentTools } from "../tools/delegation/subagent-tools.js"
import { registerImageTools } from "../tools/image/image-tools.js"
import {
  createReviewPromptTracker,
  type ReviewPromptTracker,
  registerReviewTool,
} from "../tools/review/review-tool.js"
import type { ShellSessionManager } from "../tools/shell/session-manager.js"
// import { registerIosShellTool } from "../tools/ios/ios-shell.js"
import {
  registerShellExecutionTools,
  registerShellManagementTools,
} from "../tools/shell/shell-tools.js"
import { registerSkillTools } from "../tools/skills/skill-tools.js"
import { registerStartHereTool } from "../tools/start-here/start-here.js"
import type { WebPageOpener } from "../tools/web/web-open.js"
import { registerWebTool } from "../tools/web/web-tool.js"
import { installToolRegistrationBoundary } from "./tool-registration-boundary.js"

export interface CreateMcpServerOptions {
  shellManager?: ShellSessionManager
  chatGptDelegation?: ChatGptDelegationService
  peekaboo?: PeekabooClient
  webPageOpener?: WebPageOpener
  reviewPromptTracker?: ReviewPromptTracker
  auditRequest?: McpAuditRequest
  agentObserver?: AgentObserver
}

export interface McpCapabilityServices {
  shellManager?: ShellSessionManager
  chatGptDelegation?: ChatGptDelegationService
  peekaboo?: PeekabooClient
  webPageOpener?: WebPageOpener
}

export interface McpRuntimeProfile {
  readonly server: Readonly<typeof MCP_CONFIG.server>
  readonly tools: Readonly<typeof MCP_CONFIG.tools>
  readonly toolOutput: (typeof MCP_CONFIG.mcp)["toolOutput"]
}

export interface McpRuntimeProfileOverrides {
  server?: Partial<McpRuntimeProfile["server"]>
  tools?: Partial<McpRuntimeProfile["tools"]>
  toolOutput?: McpRuntimeProfile["toolOutput"]
}

export interface McpServerRequestContext {
  auditRequest?: McpAuditRequest
  agentObserver?: AgentObserver
}

export type McpServerFactory = (context?: McpServerRequestContext) => McpServer

/**
 * Bind process-level capability services once and create short-lived MCP servers on demand.
 * Tool-group enablement, required service checks, review state, and capability registration stay
 * on the MCP side of the transport boundary.
 */
export function createMcpServerFactory(
  services: McpCapabilityServices,
  profileOverrides: McpRuntimeProfileOverrides = {}
): McpServerFactory {
  const profile = snapshotMcpRuntimeProfile(profileOverrides)
  const reviewPromptTracker = profile.tools.review ? createReviewPromptTracker() : undefined
  return (context = {}) =>
    createMcpServer(
      {
        ...services,
        reviewPromptTracker,
        auditRequest: context.auditRequest,
        agentObserver: context.agentObserver,
      },
      profile
    )
}

function createMcpServer(options: CreateMcpServerOptions, profile: McpRuntimeProfile): McpServer {
  const server = new McpServer(profile.server, {
    instructions: buildMcpInstructions(),
  })
  const chatGptDelegation = options.chatGptDelegation
  installToolRegistrationBoundary(server, {
    structuredOutput: profile.toolOutput === "structured",
    drainPendingEvents: chatGptDelegation ? () => chatGptDelegation.drainEvents() : undefined,
    agentObserver: options.agentObserver,
    reviewPromptTracker: options.reviewPromptTracker,
    auditRequest: options.auditRequest,
  })

  registerStartHereTool(server)
  const shells = profile.tools.shell
    ? requireCapabilityService(options.shellManager, "shell")
    : undefined
  if (shells) registerShellExecutionTools(server, shells)
  if (profile.tools.applyPatch) registerApplyPatchTool(server)
  if (shells) registerShellManagementTools(server, shells)
  if (profile.tools.subagents)
    registerSubagentTools(server, requireCapabilityService(options.chatGptDelegation, "subagent"))
  if (profile.tools.web)
    registerWebTool(server, requireCapabilityService(options.webPageOpener, "web"))
  if (profile.tools.skills) registerSkillTools(server)
  if (profile.tools.image) registerImageTools(server)
  if (profile.tools.computer)
    registerComputerUseTools(server, requireCapabilityService(options.peekaboo, "computer"))
  if (profile.tools.clones)
    registerCloneTools(server, requireCapabilityService(options.chatGptDelegation, "clone"))
  if (profile.tools.review) registerReviewTool(server)

  return server
}

function snapshotMcpRuntimeProfile(overrides: McpRuntimeProfileOverrides): McpRuntimeProfile {
  return Object.freeze({
    server: Object.freeze({ ...MCP_CONFIG.server, ...overrides.server }),
    tools: Object.freeze({ ...MCP_CONFIG.tools, ...overrides.tools }),
    toolOutput: overrides.toolOutput ?? MCP_CONFIG.mcp.toolOutput,
  })
}

function requireCapabilityService<T>(service: T | undefined, capability: string): T {
  if (service === undefined)
    throw new Error(`${capability} tools are enabled but their runtime service was not created.`)
  return service
}
