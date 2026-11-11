import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { z } from "zod"

const sharedProviderFields = {
  enabled: z.boolean().default(true),
  description: z.string().optional(),
}

const providerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai-compatible"),
    base_url: z.url(),
    api_key: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    ...sharedProviderFields,
  }),
  z.object({
    type: z.literal("anthropic"),
    base_url: z.url().default("https://api.anthropic.com/v1"),
    api_key: z.string().optional(),
    ...sharedProviderFields,
  }),
  z.object({
    type: z.literal("google"),
    base_url: z.url().default("https://generativelanguage.googleapis.com/v1beta"),
    api_key: z.string().optional(),
    ...sharedProviderFields,
  }),
  z.object({ type: z.literal("openai-chatgpt"), ...sharedProviderFields }),
])

const thinkingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("boolean"),
    request_field: z.string().min(1).default("enable_thinking"),
    default_enabled: z.boolean().default(true),
  }),
  z.object({
    mode: z.literal("effort"),
    request_field: z.string().min(1).default("reasoning_effort"),
    levels: z.array(z.string().min(1)).min(1),
    default: z.string().min(1),
    enabled_field: z.string().min(1).optional(),
    default_enabled: z.boolean().default(true),
  }),
])

export const subagentToolDecisionSchema = z.enum(["allow", "ask", "deny"])

const modelProfileSchema = z.object({
  agent_mode: z.enum(["build", "plan", "explore", "review", "custom"]).default("build"),
  system_prompt: z.string().max(32_000).optional(),
  permissions: z.record(z.string().min(1), subagentToolDecisionSchema).default({}),
  read_only: z.boolean().default(false),
  allowed_paths: z.array(z.string().trim().min(1)).max(32).optional(),
  fallback_models: z.array(z.string().min(1)).max(8).default([]),
  max_steps: z.number().int().min(1).max(2048).default(512),
  provider: z.string().min(1),
  model: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  enabled: z.boolean().default(true),
  execution_mode: z.enum(["sync", "async"]).default("sync"),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  tags: z.array(z.string().min(1)).default([]),
  cost_tier: z.enum(["low", "medium", "high"]).default("medium"),
  thinking: thinkingSchema.default({ mode: "none" }),
  temperature: z.number().min(0).max(2).optional(),
  extra_body: z.record(z.string(), z.unknown()).optional(),
})

export const subagentConfigSchema = z.object({
  limits: z
    .object({
      max_depth: z.number().int().min(1).max(20).default(5),
      max_children_per_agent: z.number().int().min(1).max(100).default(12),
    })
    .default({ max_depth: 5, max_children_per_agent: 12 }),
  providers: z.record(z.string().min(1), providerSchema).default({}),
  models: z.record(z.string().min(1), modelProfileSchema).default({}),
})

export type SubagentConfig = z.infer<typeof subagentConfigSchema>
export type SubagentProviderConfig = SubagentConfig["providers"][string]
export type SubagentModelProfile = SubagentConfig["models"][string]

export function loadSubagentConfig(path: string): SubagentConfig {
  if (!existsSync(path)) return subagentConfigSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(
      `Invalid subagent JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  const parsed = subagentConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid subagent config at ${path}: ${details}`)
  }
  validateModelReferences(parsed.data)
  return parsed.data
}

export function saveSubagentConfig(path: string, value: unknown): SubagentConfig {
  const parsed = subagentConfigSchema.safeParse(value)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid subagent config: ${details}`)
  }
  validateModelReferences(parsed.data)
  writeFileSync(path, `${JSON.stringify(parsed.data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  return parsed.data
}

export function redactSubagentConfig(config: SubagentConfig): SubagentConfig {
  return {
    limits: config.limits,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, provider]) => [
        id,
        {
          ...provider,
          ...("api_key" in provider && provider.api_key ? { api_key: "<redacted>" } : {}),
          ...("headers" in provider && provider.headers
            ? {
                headers: Object.fromEntries(
                  Object.keys(provider.headers).map((key) => [key, "<redacted>"])
                ),
              }
            : {}),
        },
      ])
    ),
    models: config.models,
  }
}

function validateModelReferences(config: SubagentConfig): void {
  for (const [id, model] of Object.entries(config.models)) {
    if (model.fallback_models.includes(id))
      throw new Error(`Model profile ${JSON.stringify(id)} cannot fall back to itself.`)
    for (const fallback of model.fallback_models)
      if (!config.models[fallback])
        throw new Error(
          `Model profile ${JSON.stringify(id)} references unknown fallback ${JSON.stringify(fallback)}.`
        )
    if (!config.providers[model.provider]) {
      throw new Error(
        `Model profile ${JSON.stringify(id)} references unknown provider ${JSON.stringify(model.provider)}.`
      )
    }
    if (
      model.thinking.mode === "effort" &&
      !model.thinking.levels.includes(model.thinking.default)
    ) {
      throw new Error(
        `Model profile ${JSON.stringify(id)} has a thinking default not present in levels.`
      )
    }
  }
}
