import type { Router } from "express"

import type { AgentObserver } from "../agent/observer.js"
import {
  ACCESS_MODES,
  type AccessMode,
  loadOperationalState,
  updateOperationalState,
} from "../recovery/operational-state.js"
import type { RuntimeProcessService } from "./process-service.js"
import type { RuntimeControlService } from "./runtime-control.js"

const TOOL_RISK_KEY_RE = /^(?:builtin:[^:]+|toolbox:[^:]+:.+|mcp:[^:]+:.+)$/u

export function registerRuntimeControlRoutes(
  router: ReturnType<typeof Router>,
  runtimeControl: RuntimeControlService | undefined,
  agentObserver: AgentObserver,
  runtimeProcesses?: RuntimeProcessService
): void {
  registerRuntimeStateRoutes(router, runtimeControl, agentObserver)
  registerApprovalRoutes(router, runtimeControl)
  registerProcessRoutes(router, runtimeProcesses)
}

function registerRuntimeStateRoutes(
  router: ReturnType<typeof Router>,
  runtimeControl: RuntimeControlService | undefined,
  agentObserver: AgentObserver
): void {
  router.get("/api/runtime-control", async (_req, res) => {
    if (!runtimeControl) return res.status(503).json({ error: "Runtime control unavailable." })
    const state = await loadOperationalState()
    res.json({
      accessMode: state.accessMode,
      agentAccess: state.agentAccess,
      dangerousActions: state.dangerousActions,
      toolRiskOverrides: state.toolRiskOverrides,
      notifications: state.notifications,
      capabilityPermissions: state.capabilityPermissions,
      approvals: await runtimeControl.listApprovals(),
    })
  })

  router.post("/api/runtime-control/access-mode", async (req, res) => {
    if (!runtimeControl) return res.status(503).json({ error: "Runtime control unavailable." })
    const mode = req.body?.mode
    if (!isAccessMode(mode)) {
      res.status(400).json({ error: "A valid access mode is required." })
      return
    }
    if (
      mode === "full-access" &&
      !(
        req.body?.firstRiskConfirmation === true &&
        req.body?.secondRiskConfirmation === true &&
        req.body?.confirmationCode === "FULL_ACCESS_TRUST_MODE"
      )
    ) {
      res.status(400).json({
        error: "Enabling Full Access Trust Mode requires two explicit risk confirmations.",
      })
      return
    }
    await runtimeControl.setAccessMode(mode)
    res.json(await loadOperationalState())
  })

  router.post("/api/runtime-control/pause", async (req, res) => {
    if (!runtimeControl) return res.status(503).json({ error: "Runtime control unavailable." })
    const paused = req.body?.paused === true
    await runtimeControl.setAgentAccessPaused(paused)
    const stopped = paused && req.body?.stopRunning === true ? agentObserver.stopAllTools() : 0
    res.json({ state: await loadOperationalState(), stopped })
  })

  router.patch("/api/runtime-control/dangerous-actions", async (req, res) => {
    const category = typeof req.body?.category === "string" ? req.body.category.trim() : ""
    const policy = req.body?.policy
    if (!category || (policy !== "ask" && policy !== "allow" && policy !== "deny")) {
      res.status(400).json({ error: "category and policy (ask/allow/deny) are required." })
      return
    }
    const state = await updateOperationalState((current) => {
      current.dangerousActions[category] = policy
    })
    res.json(state)
  })

  router.patch("/api/runtime-control/tool-risk", async (req, res) => {
    if (!runtimeControl) return res.status(503).json({ error: "Runtime control unavailable." })
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : ""
    const risk = req.body?.risk
    if (!isToolRiskKey(key) || (risk !== null && risk !== "low" && risk !== "approval")) {
      res.status(400).json({ error: "A valid tool key and risk (low/approval/null) are required." })
      return
    }
    await runtimeControl.setToolRiskOverride(key, risk ?? undefined)
    res.json(await loadOperationalState())
  })

  router.patch("/api/runtime-control/notifications", async (req, res) => {
    const state = await updateOperationalState((current) => {
      const incoming = req.body ?? {}
      for (const key of [
        "enabled",
        "agentCompleted",
        "approvalRequired",
        "tunnelDisconnected",
        "updateAvailable",
        "jobFinished",
      ] as const) {
        if (typeof incoming[key] === "boolean") current.notifications[key] = incoming[key]
      }
    })
    res.json(state)
  })
}

function registerProcessRoutes(
  router: ReturnType<typeof Router>,
  processes?: RuntimeProcessService
): void {
  router.get("/api/processes", async (_req, res) => {
    if (!processes) return res.status(503).json({ error: "Process manager unavailable." })
    res.json({ processes: await processes.list() })
  })

  router.post("/api/processes/:id/stop", async (req, res) => {
    if (!processes) return res.status(503).json({ error: "Process manager unavailable." })
    try {
      const stopped = await processes.stop(String(req.params.id ?? ""))
      if (!stopped) return res.status(404).json({ error: "Process cannot be stopped." })
      res.json({ stopped: true })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post("/api/processes/:id/restart", async (req, res) => {
    if (!processes) return res.status(503).json({ error: "Process manager unavailable." })
    try {
      const restarted = await processes.restart(String(req.params.id ?? ""))
      if (!restarted) return res.status(404).json({ error: "Process cannot be restarted." })
      res.json({ restarted: true })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}

function isToolRiskKey(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false
  return TOOL_RISK_KEY_RE.test(value)
}

function isAccessMode(value: unknown): value is AccessMode {
  return value === ACCESS_MODES[0] || value === ACCESS_MODES[1] || value === ACCESS_MODES[2]
}

function registerApprovalRoutes(
  router: ReturnType<typeof Router>,
  runtimeControl: RuntimeControlService | undefined
): void {
  router.get("/api/approvals", async (_req, res) => {
    if (!runtimeControl) return res.status(503).json({ error: "Runtime control unavailable." })
    res.json({ approvals: await runtimeControl.listApprovals() })
  })

  router.post("/api/approvals/:id/decision", async (req, res) => {
    if (!runtimeControl) return res.status(503).json({ error: "Runtime control unavailable." })
    const decision = req.body?.decision
    if (decision !== "approve-once" && decision !== "always-allow" && decision !== "deny") {
      res.status(400).json({ error: "Invalid approval decision." })
      return
    }
    try {
      res.json({
        approval: await runtimeControl.decideApproval(req.params.id, decision),
        state: await loadOperationalState(),
      })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
