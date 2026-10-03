import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { parentPort, workerData } from "node:worker_threads"

import { z } from "zod"

const workerDataSchema = z.object({
  runtimePath: z.string().min(1),
  name: z.string().min(1),
  toolboxId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  allowNetwork: z.boolean(),
})

const data = workerDataSchema.parse(workerData)
const blockedNetworkModules = new Set([
  "http",
  "https",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
  "http2",
  "undici",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:dgram",
  "node:dns",
  "node:dns/promises",
  "node:http2",
])
const toolboxSdkUrl = new URL(
  import.meta.url.endsWith(".ts") ? "./tool.ts" : "./tool.js",
  import.meta.url
).href
const zodUrl = import.meta.resolve("zod")

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "openchatx-mcp/toolbox") return { shortCircuit: true, url: toolboxSdkUrl }
    if (specifier === "zod") return { shortCircuit: true, url: zodUrl }
    if (!data.allowNetwork && blockedNetworkModules.has(specifier)) {
      throw new Error(`OPENCHATX_SANDBOX_NETWORK_DENIED: ${specifier}`)
    }
    return nextResolve(specifier, context)
  },
})

if (!data.allowNetwork) {
  globalThis.fetch = async () => {
    throw new Error("OPENCHATX_SANDBOX_NETWORK_DENIED: fetch")
  }
  const deniedNetworkConstructor = class {
    constructor() {
      throw new Error("OPENCHATX_SANDBOX_NETWORK_DENIED: network API")
    }
  }
  Reflect.set(globalThis, "WebSocket", deniedNetworkConstructor)
  Reflect.set(globalThis, "EventSource", deniedNetworkConstructor)
}

void execute().catch((error: unknown) => {
  parentPort?.postMessage({
    ok: false,
    error: describeSandboxError(error),
  })
})

function describeSandboxError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const details: string[] = [error.stack ?? error.message]
  if ("permission" in error && typeof error.permission === "string") {
    details.push(`permission=${error.permission}`)
  }
  if ("resource" in error && typeof error.resource === "string") {
    details.push(`resource=${error.resource}`)
  }
  return details.join("\n")
}

async function execute(): Promise<void> {
  const moduleValue: unknown = await import(
    `${pathToFileURL(data.runtimePath).href}?sandbox=${Date.now()}`
  )
  const tool = defaultExport(moduleValue)
  if (!isToolLike(tool)) throw new Error("Sandbox tool module does not export a valid Tool.")

  const controller = new AbortController()
  const mcp = { mcpReq: { signal: controller.signal } }
  const result = await tool.execute(data.input, {
    name: data.name,
    toolboxId: data.toolboxId,
    signal: controller.signal,
    mcp,
  })
  parentPort?.postMessage({ ok: true, result })
}

function defaultExport(moduleValue: unknown): unknown {
  return typeof moduleValue === "object" && moduleValue !== null && "default" in moduleValue
    ? moduleValue.default
    : undefined
}

function isToolLike(
  value: unknown
): value is { execute: (input: unknown, context: Record<string, unknown>) => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  )
}
