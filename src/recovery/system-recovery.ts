import { constants } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"

import type { CapabilityHealthService } from "../capabilities/health.js"
import { MCP_CONFIG } from "../config.js"
import { redactText } from "../security/redact.js"
import { loadOperationalState, updateOperationalState } from "./operational-state.js"

export interface DoctorCheck {
  id: string
  label: string
  status: "ok" | "warning" | "error"
  detail: string
  repairable: boolean
}

export class SystemRecoveryService {
  constructor(private readonly health?: CapabilityHealthService) {}

  async diagnostics(): Promise<{
    version: string
    platform: string
    arch: string
    safeMode: boolean
    checks: DoctorCheck[]
  }> {
    const state = await loadOperationalState()
    return {
      version: MCP_CONFIG.server.version,
      platform: process.platform,
      arch: process.arch,
      safeMode: state.safeMode.enabled,
      checks: await this.checks(),
    }
  }

  async checks(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = []
    checks.push(await this.directoryCheck())
    try {
      await loadOperationalState()
      checks.push({
        id: "state-schema",
        label: "Operational state",
        status: "ok",
        detail: "State schema is readable and supported.",
        repairable: false,
      })
    } catch (error) {
      checks.push({
        id: "state-schema",
        label: "Operational state",
        status: "error",
        detail: redactText(describeError(error)),
        repairable: true,
      })
    }
    const health = await this.health?.snapshot()
    for (const component of health?.components ?? []) {
      let status: DoctorCheck["status"] = "error"
      if (component.status === "healthy" || component.status === "disabled") status = "ok"
      else if (component.status === "degraded" || component.status === "starting")
        status = "warning"
      checks.push({
        id: `health:${component.id}`,
        label: component.name,
        status,
        detail: component.detail ?? component.status,
        repairable: component.status === "unavailable" || component.status === "degraded",
      })
    }
    return checks
  }

  async repair(id: string): Promise<{ repaired: boolean; detail: string }> {
    if (id === "state-directory") {
      await mkdir(MCP_CONFIG.stateDir, { recursive: true, mode: 0o700 })
      return { repaired: true, detail: "State directory recreated." }
    }
    if (id === "state-schema") {
      const path = join(MCP_CONFIG.stateDir, "operational-state.json")
      try {
        const content = await readFile(path, "utf8")
        await writeFile(`${path}.invalid-${Date.now()}`, content, { mode: 0o600 })
      } catch {
        // Missing/unreadable state is replaced with defaults.
      }
      await updateOperationalState((state) => state)
      return { repaired: true, detail: "Operational state reset to a supported schema." }
    }
    if (id.startsWith("health:")) {
      return {
        repaired: false,
        detail: "Component repair requires a runtime restart or its own configuration action.",
      }
    }
    throw new Error(`Unknown doctor check ${JSON.stringify(id)}.`)
  }

  async setSafeMode(enabled: boolean, reason?: string) {
    return updateOperationalState((state) => {
      state.safeMode = enabled
        ? {
            enabled: true,
            reason: reason?.trim() || "Enabled by user",
            enabledAt: new Date().toISOString(),
          }
        : { enabled: false }
    })
  }

  async recordCrash(error: unknown): Promise<void> {
    const summary = redactText(
      error instanceof Error ? (error.stack ?? error.message) : describeError(error)
    ).slice(0, 8000)
    await updateOperationalState((state) => {
      state.crash.consecutiveStartupFailures += 1
      state.crash.lastCrashAt = new Date().toISOString()
      state.crash.lastCrashSummary = summary
      if (state.update.pendingHealthCheck) {
        state.update.phase = "failed"
        state.update.progress = 100
      }
      if (state.update.pendingHealthCheck || state.crash.consecutiveStartupFailures >= 2) {
        state.safeMode = {
          enabled: true,
          reason: "OpenChatX detected repeated startup failures.",
          enabledAt: new Date().toISOString(),
        }
      }
    })
  }

  async recordHealthyStartup(): Promise<void> {
    await updateOperationalState((state) => {
      state.crash.consecutiveStartupFailures = 0
      if (state.update.pendingHealthCheck) {
        state.update.lastInstalledVersion = state.update.pendingHealthCheck
        state.update.pendingHealthCheck = undefined
        state.update.phase = "completed"
        state.update.progress = 100
      }
    })
  }

  private async directoryCheck(): Promise<DoctorCheck> {
    try {
      await mkdir(MCP_CONFIG.stateDir, { recursive: true, mode: 0o700 })
      await access(MCP_CONFIG.stateDir, constants.R_OK | constants.W_OK)
      return {
        id: "state-directory",
        label: "State directory",
        status: "ok",
        detail: "OpenChatX state directory is readable and writable.",
        repairable: false,
      }
    } catch (error) {
      return {
        id: "state-directory",
        label: "State directory",
        status: "error",
        detail: redactText(describeError(error)),
        repairable: true,
      }
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean")
    return String(error)
  try {
    return JSON.stringify(error)
  } catch {
    return "Unknown error"
  }
}
