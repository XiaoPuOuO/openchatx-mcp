import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parse } from "smol-toml"
import { z } from "zod"

// CommonJS lets the built loader serve PM2's ecosystem file as well as the ESM runtime.
const defaultConfigPath = resolve(__dirname, "../.shellby/config.toml")
const httpUrl = z
  .url()
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "URL must use http or https"
  )
const cdpEndpoint = httpUrl.refine((value) => {
  const url = new URL(value)
  const managedLocal =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  return !managedLocal || url.port.length > 0
}, "Local CDP endpoint must include an explicit port")

const publicConfigSchema = z.object({
  state_dir: z.string().trim().min(1).default("~/.shellby"),
  port: z.number().int().min(1).max(65535).default(3333),
  workspace: z.string().trim().min(1).default("~/Desktop/agent-workspace"),
  shell: z.object({
    path: z.string().trim().min(1).default("/bin/zsh"),
    rtk: z.boolean().default(false),
  }),
  chatgpt: z.object({
    cdp_endpoint: cdpEndpoint.default("http://127.0.0.1:9222"),
    project_url: httpUrl.default("https://chatgpt.com/"),
    max_delegated_agents: z.number().int().positive().default(3),
  }),
  ngrok: z.object({
    enabled: z.boolean().default(true),
    api_port: z.number().int().min(1).max(65535).default(4040),
    url: httpUrl.optional(),
    pooling_enabled: z.boolean().default(false),
  }),
  mcp: z.object({ tool_output: z.enum(["compact", "structured"]).default("compact") }),
  ui: z.object({ enabled: z.boolean().default(false) }),
  tools: z.object({
    review: z.boolean().default(true),
    shell: z.boolean().default(true),
    apply_patch: z.boolean().default(true),
    clones: z.boolean().default(true),
    subagents: z.boolean().default(true),
    web: z.boolean().default(true),
    skills: z.boolean().default(true),
    image: z.boolean().default(true),
    computer: z.boolean().default(true),
  }),
})

export type ShellbyPublicConfig = z.infer<typeof publicConfigSchema>
export type ToolOutputFormat = ShellbyPublicConfig["mcp"]["tool_output"]
export const DEFAULT_PUBLIC_CONFIG = publicConfigSchema.parse(
  resolveConfigObject(publicConfigSchema, {}, "", () => undefined)
)

export function loadPublicConfig(path = defaultConfigPath): ShellbyPublicConfig {
  if (!existsSync(path))
    throw new Error(`Shellby config is missing at ${path}. Run \`npm run setup\` first.`)

  const source = readFileSync(path, "utf8")
  let value: unknown
  try {
    value = parse(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Invalid Shellby config syntax at ${path}: ${message}. Fix the TOML syntax; the file has not been changed.`,
      { cause: error }
    )
  }

  const warn = (message: string) => console.warn(`Shellby config warning (${path}): ${message}`)
  const config = publicConfigSchema.parse(resolveConfigObject(publicConfigSchema, value, "", warn))
  if (config.ngrok.pooling_enabled && !config.ngrok.url) {
    warn("ngrok.pooling_enabled requires a valid ngrok.url; using default false.")
    config.ngrok.pooling_enabled = false
  }
  return config
}

function resolveConfigObject(
  schema: z.ZodObject,
  value: unknown,
  prefix: string,
  warn: (message: string) => void
): Record<string, unknown> {
  let input: Record<string, unknown> = {}
  if (value !== undefined) {
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      input = value as Record<string, unknown>
    else warn(`${prefix} must be a TOML table; using defaults for this section.`)
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.shape, key))
      warn(`Unknown setting ${prefix ? `${prefix}.` : ""}${key}; ignoring it.`)
  }

  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape) as Array<[string, z.ZodType]>) {
    const path = prefix ? `${prefix}.${key}` : key
    const supplied = Object.hasOwn(input, key) ? input[key] : undefined
    if (field instanceof z.ZodObject) {
      result[key] = resolveConfigObject(field, supplied, path, warn)
      continue
    }
    const parsed = field.safeParse(supplied)
    const resolved = parsed.success ? parsed.data : field.parse(undefined)
    if (!parsed.success) {
      warn(
        `${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}; ${resolved === undefined ? "ignoring this optional setting" : `using default ${JSON.stringify(resolved)}`}.`
      )
    }
    if (resolved !== undefined) result[key] = resolved
  }
  return result
}
