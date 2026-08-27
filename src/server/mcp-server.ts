import { McpServer } from "@modelcontextprotocol/server"

import { buildMcpInstructions, MCP_CONFIG, type ToolOutputStructuredMode } from "../config.js"
import { registerApplyPatchTool } from "../tools/apply-patch/apply-patch.js"
import { registerComputerUseTools } from "../tools/computer/computer-tools.js"
import { PeekabooClient } from "../tools/computer/peekaboo.js"
import { registerImageTools } from "../tools/image/image-tools.js"
// import { registerIosShellTool } from "../tools/ios/ios-shell.js"
import { registerShellExecutionTools, registerShellManagementTools } from "../tools/shell/shell-tools.js"
import type { ShellSessionManager } from "../tools/shell/session-manager.js"
import { registerSkillTools } from "../tools/skills.js"
import type { ChatGptSubagentService } from "../tools/subagent/chatgpt-subagent-contracts.js"
import { registerSubagentTools } from "../tools/subagent/subagent-tools.js"
import { WebPageOpener } from "../tools/web/web-open.js"
import { registerWebTool } from "../tools/web/web-tool.js"
import { installToolRegistrationBoundary } from "./tool-registration-boundary.js"

export interface CreateMcpServerOptions {
  chatGptSubagents: ChatGptSubagentService
  peekaboo: PeekabooClient
  webPageOpener: WebPageOpener
  applyPatchExecutable?: string
  toolOutputStructured?: ToolOutputStructuredMode
  sessionId?: string
}

export function createMcpServer(shells: ShellSessionManager, options: CreateMcpServerOptions): McpServer {
  const workspace = shells.initialCwd
  const server = new McpServer(MCP_CONFIG.server, {
    instructions: buildMcpInstructions(workspace),
  })
  installToolRegistrationBoundary(server, {
    toolOutputStructured: options.toolOutputStructured ?? MCP_CONFIG.toolOutputStructured,
    drainPendingEvents: () => options.chatGptSubagents.drainEvents?.(options.sessionId) ?? [],
  })

  registerShellExecutionTools(server, shells, workspace)
  // iOS shell is experimental and intentionally disabled until the bridge is revisited.
  // registerIosShellTool(server)
  registerApplyPatchTool(server, options.applyPatchExecutable)
  registerShellManagementTools(server, shells)
  registerSubagentTools(server, options.chatGptSubagents, options.sessionId)
  registerWebTool(server, options.webPageOpener)
  registerSkillTools(server, workspace)
  registerImageTools(server, workspace)
  registerComputerUseTools(server, options.peekaboo)

  return server
}
