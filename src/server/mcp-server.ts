import { McpServer } from "@modelcontextprotocol/server"

import { buildMcpInstructions, MCP_CONFIG } from "../config.js"
import { registerApplyPatchTool } from "../tools/apply-patch/apply-patch.js"
import { registerComputerUseTools } from "../tools/computer/computer-tools.js"
import { PeekabooClient } from "../tools/computer/peekaboo.js"
import { registerImageTools } from "../tools/image/image-tools.js"
import { registerReviewTool, type ReviewPromptTracker } from "../tools/review/review-tool.js"
// import { registerIosShellTool } from "../tools/ios/ios-shell.js"
import { registerShellExecutionTools, registerShellManagementTools } from "../tools/shell/shell-tools.js"
import type { ShellSessionManager } from "../tools/shell/session-manager.js"
import { registerStartHereTool } from "../tools/start-here/start-here.js"
import { registerSkillTools } from "../tools/skills.js"
import { registerCloneTools } from "../tools/subagent/clone-tools.js"
import type { ChatGptSubagentService } from "../tools/subagent/chatgpt-subagent-contracts.js"
import { registerSubagentTools } from "../tools/subagent/subagent-tools.js"
import { WebPageOpener } from "../tools/web/web-open.js"
import { registerWebTool } from "../tools/web/web-tool.js"
import type { McpAuditRequest } from "./audit/audit-log.js"
import { installToolRegistrationBoundary } from "./tool-registration-boundary.js"

export interface CreateMcpServerOptions {
  shellManager?: ShellSessionManager
  chatGptSubagents?: ChatGptSubagentService
  peekaboo?: PeekabooClient
  webPageOpener?: WebPageOpener
  sessionId?: string
  startedSessions?: Set<string>
  reviewPromptTracker?: ReviewPromptTracker
  auditRequest?: McpAuditRequest
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const workspace = MCP_CONFIG.workspace
  const server = new McpServer(MCP_CONFIG.server, {
    instructions: buildMcpInstructions(workspace),
  })
  installToolRegistrationBoundary(server, {
    drainPendingEvents: options.chatGptSubagents ? () => options.chatGptSubagents!.drainEvents(options.sessionId) : undefined,
    sessionId: options.sessionId,
    startedSessions: options.startedSessions,
    reviewPromptTracker: options.reviewPromptTracker,
    auditRequest: options.auditRequest,
  })

  registerStartHereTool(server)
  const shells = MCP_CONFIG.tools.shell ? requireCapabilityService(options.shellManager, "shell") : undefined
  if (shells) registerShellExecutionTools(server, shells, workspace)
  // iOS shell is experimental and intentionally disabled until the bridge is revisited.
  // registerIosShellTool(server)
  if (MCP_CONFIG.tools.applyPatch) registerApplyPatchTool(server)
  if (shells) registerShellManagementTools(server, shells)
  if (MCP_CONFIG.tools.subagents) registerSubagentTools(server, requireCapabilityService(options.chatGptSubagents, "subagent"), options.sessionId)
  if (MCP_CONFIG.tools.web) registerWebTool(server, requireCapabilityService(options.webPageOpener, "web"))
  if (MCP_CONFIG.tools.skills) registerSkillTools(server, workspace)
  if (MCP_CONFIG.tools.image) registerImageTools(server, workspace)
  if (MCP_CONFIG.tools.computer) registerComputerUseTools(server, requireCapabilityService(options.peekaboo, "computer"))
  if (MCP_CONFIG.tools.clones) registerCloneTools(server, requireCapabilityService(options.chatGptSubagents, "clone"), options.sessionId)

  if (MCP_CONFIG.tools.review) registerReviewTool(server)

  return server
}

function requireCapabilityService<T>(service: T | undefined, capability: string): T {
  if (service === undefined) throw new Error(`${capability} tools are enabled but their runtime service was not created.`)
  return service
}
