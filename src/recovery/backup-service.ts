import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import { redactSecrets, redactText } from "../security/redact.js"
import { loadOperationalState, OPERATIONAL_STATE_VERSION } from "./operational-state.js"

const backupSchema = z.object({
  format: z.literal("openchatx-backup"),
  formatVersion: z.literal(1),
  createdAt: z.string(),
  appVersion: z.string(),
  operationalSchemaVersion: z.number().int().positive(),
  files: z.record(z.string(), z.string()),
})
export type OpenChatXBackup = z.infer<typeof backupSchema>

export class BackupService {
  private readonly backupDir = join(MCP_CONFIG.stateDir, "backups")

  async create(destination?: string): Promise<{ path: string; backup: OpenChatXBackup }> {
    const files: Record<string, string> = {}
    for (const entry of this.backupEntries()) {
      try {
        const content = await readFile(entry.path, "utf8")
        files[entry.name] = redactFileContent(content)
      } catch (error) {
        if (!isEnoent(error)) throw error
      }
    }
    files["operational-state.json"] = JSON.stringify(redactSecrets(await loadOperationalState()))

    const backup = backupSchema.parse({
      format: "openchatx-backup",
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      appVersion: MCP_CONFIG.server.version,
      operationalSchemaVersion: OPERATIONAL_STATE_VERSION,
      files,
    })
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 })
    const path =
      destination ??
      join(
        this.backupDir,
        `openchatx-${backup.createdAt.replace(/[:.]/gu, "-")}.openchatx-backup.json`
      )
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 })
    return { path, backup }
  }

  async verify(path: string): Promise<OpenChatXBackup> {
    return backupSchema.parse(JSON.parse(await readFile(path, "utf8")))
  }

  async restore(path: string): Promise<{ restored: string[]; safetyBackupPath: string }> {
    const backup = await this.verify(path)
    if (backup.operationalSchemaVersion > OPERATIONAL_STATE_VERSION) {
      throw new Error("Backup was created by a newer OpenChatX state schema.")
    }
    const safety = await this.create()
    const allowed = new Map(this.backupEntries().map((entry) => [entry.name, entry.path]))
    allowed.set("operational-state.json", join(MCP_CONFIG.stateDir, "operational-state.json"))
    const restored: string[] = []
    for (const [name, serialized] of Object.entries(backup.files)) {
      const destination = allowed.get(name)
      if (!destination) continue
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, serialized.endsWith("\n") ? serialized : `${serialized}\n`, {
        mode: 0o600,
      })
      restored.push(name)
    }
    return { restored, safetyBackupPath: safety.path }
  }

  private backupEntries(): Array<{ name: string; path: string }> {
    return [
      { name: "mcp-servers.json", path: MCP_CONFIG.externalMcp.configFile },
      { name: "subagents.json", path: MCP_CONFIG.subagents.configFile },
      { name: "openchatx.toml.json", path: MCP_CONFIG.publicConfigFile },
    ]
  }
}

function redactFileContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    return JSON.stringify(redactSecrets(parsed), null, 2)
  } catch {
    return redactText(content)
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export function backupDisplayName(path: string): string {
  return basename(path)
}
