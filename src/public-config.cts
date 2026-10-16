import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import process from "node:process"

import { parse, stringify } from "smol-toml"
import { z } from "zod"

// CommonJS lets the built loader serve PM2's ecosystem file as well as the ESM runtime.
const defaultConfigPath =
  process.env.OPENCHATX_PUBLIC_CONFIG?.trim() || resolve(__dirname, "../.openchatx/config.toml")
const publicConfigSchema = z.object({
  state_dir: z.string().trim().min(1).default("~/.openchatx-mcp"),
  port: z.number().int().min(1).max(65535).default(8001),
  shell: z.object({
    path: z
      .string()
      .trim()
      .min(1)
      .default(process.platform === "win32" ? "pwsh.exe" : "/bin/zsh"),
    rtk: z.boolean().default(false),
  }),
  tunnel: z.object({
    profile: z.string().trim().min(1).default("openchatx"),
    health_port: z.number().int().min(1).max(65535).default(8080),
  }),
  dot: z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(8002),
    health_port: z.number().int().min(1).max(65535).default(8081),
    profile: z.string().trim().min(1).default("openchatx-dot"),
    external_servers: z.array(z.string().trim().min(1)).default([]),
  }),
  context: z.object({
    warning_threshold: z.number().int().positive().default(400_000),
  }),
  mcp: z.object({ tool_output: z.enum(["compact", "structured"]).default("compact") }),
  tools: z.object({
    shell: z.boolean().default(true),
    apply_patch: z.boolean().default(true),
    file_read: z.boolean().default(true),
    file_write: z.boolean().default(true),
    web: z.boolean().default(true),
    skills: z.boolean().default(true),
    image: z.boolean().default(true),
  }),
})

export type OpenChatXPublicConfig = z.infer<typeof publicConfigSchema>
export const DEFAULT_PUBLIC_CONFIG = publicConfigSchema.parse(
  resolveConfigObject(publicConfigSchema, {}, "", () => undefined)
)

export function loadPublicConfig(path = defaultConfigPath): OpenChatXPublicConfig {
  if (!existsSync(path))
    throw new Error(`openchatx-mcp config is missing at ${path}. Run \`npm run setup\` first.`)

  const source = readFileSync(path, "utf8")
  let value: unknown
  try {
    value = parse(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Invalid openchatx-mcp config syntax at ${path}: ${message}. Fix the TOML syntax; the file has not been changed.`,
      { cause: error }
    )
  }

  const warn = (message: string) =>
    console.warn(`openchatx-mcp config warning (${path}): ${message}`)
  return publicConfigSchema.parse(resolveConfigObject(publicConfigSchema, value, "", warn))
}

export function getPublicConfigPath(): string {
  return defaultConfigPath
}

export function savePublicConfig(value: unknown, path = defaultConfigPath): OpenChatXPublicConfig {
  const parsed = publicConfigSchema.parse(
    resolveConfigObject(publicConfigSchema, value, "", () => undefined)
  )
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.tmp`
  writeFileSync(
    tempPath,
    `# openchatx-mcp configuration.\n# All supported settings are shown below. Edit active values to customize this installation.\n\n${stringify(parsed)}\n`,
    { encoding: "utf8", mode: 0o600 }
  )
  renameSync(tempPath, path)
  return parsed
}

function resolveConfigObject(
  schema: z.ZodObject,
  value: unknown,
  prefix: string,
  warn: (message: string) => void
): Record<string, unknown> {
  const input = resolveConfigInput(value, prefix, warn)
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.shape, key))
      warn(`Unknown setting ${prefix ? `${prefix}.` : ""}${key}; ignoring it.`)
  }

  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    const path = prefix ? `${prefix}.${key}` : key
    const supplied = Object.hasOwn(input, key) ? input[key] : undefined
    const resolved = resolveConfigValue(field, supplied, path, warn)
    if (resolved !== undefined) result[key] = resolved
  }
  return result
}

function resolveConfigInput(
  value: unknown,
  prefix: string,
  warn: (message: string) => void
): Record<string, unknown> {
  if (value === undefined) return {}
  if (isRecord(value)) return value
  warn(`${prefix} must be a TOML table; using defaults for this section.`)
  return {}
}

function resolveConfigValue(
  field: z.ZodType,
  supplied: unknown,
  path: string,
  warn: (message: string) => void
): unknown {
  if (field instanceof z.ZodObject) return resolveConfigObject(field, supplied, path, warn)

  const parsed = field.safeParse(supplied)
  const resolved = parsed.success ? parsed.data : field.parse(undefined)
  if (!parsed.success) {
    const fallback =
      resolved === undefined
        ? "ignoring this optional setting"
        : `using default ${JSON.stringify(resolved)}`
    warn(`${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}; ${fallback}.`)
  }
  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
