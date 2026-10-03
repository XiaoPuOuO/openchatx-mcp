import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"
import { z } from "zod"
import { MCP_CONFIG } from "../config.js"

export const OPERATIONAL_STATE_VERSION = 4
export const ACCESS_MODES = ["always-question", "allow-low-risk", "full-access"] as const
export type AccessMode = (typeof ACCESS_MODES)[number]

const stateSchema = z.object({
  schemaVersion: z.literal(OPERATIONAL_STATE_VERSION),
  onboardingCompleted: z.boolean().default(false),
  safeMode: z
    .object({
      enabled: z.boolean().default(false),
      reason: z.string().optional(),
      enabledAt: z.string().optional(),
    })
    .default({ enabled: false }),
  update: z
    .object({
      channel: z.enum(["stable", "beta"]).default("beta"),
      autoCheck: z.boolean().default(true),
      lastCheckAt: z.string().optional(),
      lastInstalledVersion: z.string().optional(),
      pendingHealthCheck: z.string().optional(),
      phase: z
        .enum(["idle", "downloading", "installing", "health-check", "completed", "failed"])
        .default("idle"),
      progress: z.number().int().min(0).max(100).default(0),
    })
    .default({ channel: "beta", autoCheck: true, phase: "idle", progress: 0 }),
  capabilityPermissions: z
    .record(z.string(), z.record(z.string(), z.enum(["ask", "allow", "deny"])))
    .default({}),
  accessMode: z.enum(ACCESS_MODES).default("allow-low-risk"),
  agentAccess: z
    .object({
      paused: z.boolean().default(false),
      pausedAt: z.string().optional(),
    })
    .default({ paused: false }),
  dangerousActions: z.record(z.string(), z.enum(["ask", "allow", "deny"])).default({}),
  toolRiskOverrides: z.record(z.string(), z.enum(["low", "approval"])).default({}),
  desktop: z
    .object({
      closeToTray: z.boolean().default(true),
      startMinimized: z.boolean().default(false),
    })
    .default({ closeToTray: true, startMinimized: false }),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      agentCompleted: z.boolean().default(true),
      approvalRequired: z.boolean().default(true),
      tunnelDisconnected: z.boolean().default(true),
      updateAvailable: z.boolean().default(true),
      jobFinished: z.boolean().default(true),
    })
    .default({
      enabled: true,
      agentCompleted: true,
      approvalRequired: true,
      tunnelDisconnected: true,
      updateAvailable: true,
      jobFinished: true,
    }),
  crash: z
    .object({
      consecutiveStartupFailures: z.number().int().nonnegative().default(0),
      lastCrashAt: z.string().optional(),
      lastCrashSummary: z.string().optional(),
    })
    .default({ consecutiveStartupFailures: 0 }),
})
export type OperationalState = z.infer<typeof stateSchema>

const statePath = join(MCP_CONFIG.stateDir, "operational-state.json")

export async function loadOperationalState(): Promise<OperationalState> {
  try {
    const raw: unknown = JSON.parse(await readFile(statePath, "utf8"))
    return migrateOperationalState(raw)
  } catch (error) {
    if (isEnoent(error)) {
      const existingInstall =
        existsSync(MCP_CONFIG.publicConfigFile) || existsSync(MCP_CONFIG.externalMcp.configFile)
      return stateSchema.parse({
        schemaVersion: OPERATIONAL_STATE_VERSION,
        onboardingCompleted: existingInstall,
      })
    }
    throw error
  }
}

export async function saveOperationalState(state: OperationalState): Promise<OperationalState> {
  const validated = stateSchema.parse(state)
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, statePath)
  return validated
}

export async function updateOperationalState(
  update: (state: OperationalState) => OperationalState | undefined
): Promise<OperationalState> {
  const state = await loadOperationalState()
  const next = update(state) ?? state
  return saveOperationalState(next)
}

export function migrateOperationalState(raw: unknown): OperationalState {
  if (!raw || typeof raw !== "object") {
    return stateSchema.parse({ schemaVersion: OPERATIONAL_STATE_VERSION })
  }
  const version =
    "schemaVersion" in raw && typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0
  if (version > OPERATIONAL_STATE_VERSION) {
    throw new Error(
      `Operational state schema ${version} is newer than supported schema ${OPERATIONAL_STATE_VERSION}.`
    )
  }
  if (version < OPERATIONAL_STATE_VERSION) {
    const legacyTrustMode =
      version <= 2 &&
      "trustMode" in raw &&
      raw.trustMode !== null &&
      typeof raw.trustMode === "object" &&
      "enabled" in raw.trustMode &&
      raw.trustMode.enabled === true
    return stateSchema.parse({
      ...raw,
      schemaVersion: OPERATIONAL_STATE_VERSION,
      ...(version <= 2 ? { accessMode: legacyTrustMode ? "full-access" : "allow-low-risk" } : {}),
    })
  }
  return stateSchema.parse(raw)
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
