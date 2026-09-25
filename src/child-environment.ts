import process from "node:process"

const INTERNAL_ENV_KEYS = [
  "OPENCHATX_PUBLIC_CONFIG",
  "OPENCHATX_EXTERNAL_MCP_CONFIG",
  "OPENCHATX_SUBAGENT_CONFIG",
  "OPENCHATX_TOOLBOX_ROOT",
  "OPENCHATX_AUDIT_LOG",
  "OPENCHATX_DESKTOP",
] as const

export function childProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...source }
  for (const key of INTERNAL_ENV_KEYS) environment[key] = undefined
  return environment
}

export function childStringEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(childProcessEnvironment(source)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
}
