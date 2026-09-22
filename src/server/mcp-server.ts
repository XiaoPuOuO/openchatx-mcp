import { McpServer } from "@modelcontextprotocol/server"

import { buildMcpInstructions, MCP_CONFIG } from "../config.js"
import { registerApplyPatchTool } from "../tools/apply-patch/apply-patch.js"
import { registerComputerUseTools } from "../tools/computer/computer-tools.js"
import type { PeekabooClient } from "../tools/computer/peekaboo.js"
import { registerImageTools } from "../tools/image/image-tools.js"
import { type ReviewPromptTracker, registerReviewTool } from "../tools/review/review-tool.js"
import type { ShellSessionManager } from "../tools/shell/session-manager.js"
// import { registerIosShellTool } from "../tools/ios/ios-shell.js"
import {
  registerShellExecutionTools,
  registerShellManagementTools,
} from "../tools/shell/shell-tools.js"
import { registerSkillTools } from "../tools/skills.js"
import { registerStartHereTool } from "../tools/start-here/start-here.js"
import type { ChatGptSubagentService } from "../tools/subagent/chatgpt-subagent-contracts.js"
import { registerCloneTools } from "../tools/subagent/clone-tools.js"
import { registerSubagentTools } from "../tools/subagent/subagent-tools.js"
import type { WebPageOpener } from "../tools/web/web-open.js"
import { registerWebTool } from "../tools/web/web-tool.js"
import type { AgentObserver } from "./agent-observer.js"
import type { McpAuditRequest } from "./audit/audit-log.js"
import { installToolRegistrationBoundary } from "./tool-registration-boundary.js"

export interface CreateMcpServerOptions {
  shellManager?: ShellSessionManager
  chatGptSubagents?: ChatGptSubagentService
  peekaboo?: PeekabooClient
  webPageOpener?: WebPageOpener
  reviewPromptTracker?: ReviewPromptTracker
  auditRequest?: McpAuditRequest
  agentObserver?: AgentObserver
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const server = new McpServer(MCP_CONFIG.server, {
    instructions: buildMcpInstructions(),
  })
  const chatGptSubagents = options.chatGptSubagents
  installToolRegistrationBoundary(server, {
    drainPendingEvents: chatGptSubagents ? () => chatGptSubagents.drainEvents() : undefined,
    agentObserver: options.agentObserver,
    reviewPromptTracker: options.reviewPromptTracker,
    auditRequest: options.auditRequest,
  })

  registerStartHereTool(server)
  const shells = MCP_CONFIG.tools.shell
    ? requireCapabilityService(options.shellManager, "shell")
    : undefined
  if (shells) registerShellExecutionTools(server, shells)
  if (MCP_CONFIG.tools.applyPatch) registerApplyPatchTool(server)
  if (shells) registerShellManagementTools(server, shells)
  if (MCP_CONFIG.tools.subagents)
    registerSubagentTools(server, requireCapabilityService(options.chatGptSubagents, "subagent"))
  if (MCP_CONFIG.tools.web)
    registerWebTool(server, requireCapabilityService(options.webPageOpener, "web"))
  if (MCP_CONFIG.tools.skills) registerSkillTools(server)
  if (MCP_CONFIG.tools.image) registerImageTools(server)
  if (MCP_CONFIG.tools.computer)
    registerComputerUseTools(server, requireCapabilityService(options.peekaboo, "computer"))
  if (MCP_CONFIG.tools.clones)
    registerCloneTools(server, requireCapabilityService(options.chatGptSubagents, "clone"))
  if (MCP_CONFIG.tools.review) registerReviewTool(server)

  return server
}

function requireCapabilityService<T>(service: T | undefined, capability: string): T {
  if (service === undefined)
    throw new Error(`${capability} tools are enabled but their runtime service was not created.`)
  return service
}
