import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"

import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import { redactSecrets } from "../security/redact.js"

const approvalSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  toolName: z.string(),
  category: z.string(),
  reason: z.string(),
  createdAt: z.string(),
  status: z.enum(["pending", "approved-once", "denied", "consumed"]),
  input: z.unknown(),
  source: z
    .object({ kind: z.enum(["builtin", "toolbox", "mcp"]), id: z.string().optional() })
    .optional(),
})
export type RuntimeApproval = z.infer<typeof approvalSchema>

const stateSchema = z.object({
  approvals: z.array(approvalSchema).default([]),
})

export class ApprovalStore {
  private readonly path = join(MCP_CONFIG.stateDir, "approvals.json")

  async list(): Promise<RuntimeApproval[]> {
    return (await this.load()).approvals
      .filter((approval) => approval.status !== "consumed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async request(input: {
    toolName: string
    category: string
    reason: string
    argumentsValue: Record<string, unknown>
    source?: { kind: "builtin" | "toolbox" | "mcp"; id?: string }
  }): Promise<RuntimeApproval> {
    const state = await this.load()
    const fingerprint = approvalFingerprint(input.toolName, input.argumentsValue, input.category)
    const existing = state.approvals.find(
      (candidate) => candidate.fingerprint === fingerprint && candidate.status === "pending"
    )
    if (existing) return existing

    const approval: RuntimeApproval = {
      id: randomUUID(),
      fingerprint,
      toolName: input.toolName,
      category: input.category,
      reason: input.reason,
      createdAt: new Date().toISOString(),
      status: "pending",
      input: redactSecrets(input.argumentsValue),
      ...(input.source ? { source: input.source } : {}),
    }
    state.approvals.push(approval)
    await this.save(state)
    return approval
  }

  async decide(
    id: string,
    decision: "approve-once" | "deny" | "dismiss"
  ): Promise<RuntimeApproval> {
    const state = await this.load()
    const approval = state.approvals.find((candidate) => candidate.id === id)
    if (!approval) throw new Error(`Unknown approval ${JSON.stringify(id)}.`)
    if (decision === "approve-once") approval.status = "approved-once"
    else if (decision === "deny") approval.status = "denied"
    else approval.status = "consumed"
    await this.save(state)
    return approval
  }

  async consume(
    toolName: string,
    argumentsValue: Record<string, unknown>,
    category: string
  ): Promise<boolean> {
    const state = await this.load()
    const fingerprint = approvalFingerprint(toolName, argumentsValue, category)
    const approval = state.approvals.find(
      (candidate) => candidate.fingerprint === fingerprint && candidate.status === "approved-once"
    )
    if (!approval) return false
    approval.status = "consumed"
    await this.save(state)
    return true
  }

  async clearSettled(): Promise<void> {
    const state = await this.load()
    state.approvals = state.approvals.filter(
      (approval) => approval.status === "pending" || approval.status === "approved-once"
    )
    await this.save(state)
  }

  private async load(): Promise<z.infer<typeof stateSchema>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"))
      return stateSchema.parse(value)
    } catch (error) {
      if (isEnoent(error)) return stateSchema.parse({})
      throw error
    }
  }

  private async save(state: z.infer<typeof stateSchema>): Promise<void> {
    const validated = stateSchema.parse(state)
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

export function approvalFingerprint(
  toolName: string,
  argumentsValue: Record<string, unknown>,
  category = "default"
): string {
  return createHash("sha256")
    .update(toolName)
    .update("\0")
    .update(category)
    .update("\0")
    .update(stableJson(argumentsValue))
    .digest("hex")
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
