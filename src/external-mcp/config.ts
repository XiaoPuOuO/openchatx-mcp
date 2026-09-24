import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { z } from "zod"

const baseServer = z.object({
  enabled: z.boolean().default(true),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  timeout: z.number().int().positive().optional(),
})

const localServer = baseServer.extend({
  type: z.literal("local"),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional(),
  environment: z.record(z.string(), z.string()).optional(),
})

const remoteServer = baseServer.extend({
  type: z.literal("remote"),
  url: z
    .url()
    .refine(
      (value) => value.startsWith("http://") || value.startsWith("https://"),
      "URL must use http or https"
    ),
  headers: z.record(z.string(), z.string()).optional(),
})

export const externalMcpConfigSchema = z.record(
  z.string().min(1),
  z.discriminatedUnion("type", [localServer, remoteServer])
)

export type ExternalMcpServerConfig = z.infer<typeof externalMcpConfigSchema>[string]
export type ExternalMcpConfig = z.infer<typeof externalMcpConfigSchema>

export function loadExternalMcpConfig(path: string): ExternalMcpConfig {
  if (!existsSync(path)) return {}

  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid external MCP JSON at ${path}: ${message}`, { cause: error })
  }

  const parsed = externalMcpConfigSchema.safeParse(value)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid external MCP config at ${path}: ${details}`)
  }
  return parsed.data
}

export function saveExternalMcpConfig(path: string, value: unknown): ExternalMcpConfig {
  const parsed = externalMcpConfigSchema.safeParse(value)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid external MCP config: ${details}`)
  }
  writeFileSync(path, `${JSON.stringify(parsed.data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  return parsed.data
}
