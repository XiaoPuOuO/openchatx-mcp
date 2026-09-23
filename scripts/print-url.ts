import process from "node:process"
import { MCP_CONFIG } from "../src/config.js"

const optional = process.argv.includes("--optional")
if (!MCP_CONFIG.ngrok.enabled) {
  console.log(`MCP URL: http://${MCP_CONFIG.host}:${MCP_CONFIG.port}/mcp (local only)`)
  printUiUrl()
  process.exit(0)
}
const url = await discoverNgrokUrl(optional ? 1 : 20)

if (url) {
  console.log(`MCP URL: ${url}`)
} else {
  console.error(
    "MCP URL unavailable. Run `npm start` from Terminal.app, then check `npm run status` and `npm run logs` if it is still unavailable."
  )
  if (!optional) process.exitCode = 1
}
printUiUrl()

interface NgrokTunnel {
  proto: string
  public_url: string
  config: {
    addr: string
  }
}

async function discoverNgrokUrl(attempts: number, attempt = 1): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${MCP_CONFIG.ngrok.apiPort}/api/tunnels`, {
      signal: AbortSignal.timeout(500),
    })
    if (response.ok) {
      const payload: unknown = await response.json()
      const tunnel = getNgrokTunnels(payload).find((candidate) => {
        if (candidate.proto !== "https" || !candidate.public_url) return false
        try {
          const upstream = new URL(candidate.config.addr)
          const expectedUrl = MCP_CONFIG.ngrok.url?.replace(/\/+$/u, "")
          return (
            ["localhost", "127.0.0.1"].includes(upstream.hostname) &&
            Number(upstream.port || 80) === MCP_CONFIG.port &&
            (!expectedUrl || candidate.public_url.replace(/\/+$/u, "") === expectedUrl)
          )
        } catch {
          return false
        }
      })
      if (tunnel) return `${tunnel.public_url.replace(/\/+$/u, "")}/mcp`
    }
  } catch {
    // ngrok may still be starting.
  }

  if (attempt >= attempts) return
  await new Promise((resolve) => setTimeout(resolve, 250))
  return discoverNgrokUrl(attempts, attempt + 1)
}

function printUiUrl(): void {
  if (!MCP_CONFIG.ui.enabled) return
  console.log(`UI URL: http://${MCP_CONFIG.host}:${MCP_CONFIG.port}/ui`)
}

function getNgrokTunnels(payload: unknown): NgrokTunnel[] {
  if (!isRecord(payload) || !Array.isArray(payload.tunnels)) return []
  return payload.tunnels.filter(isNgrokTunnel)
}

function isNgrokTunnel(value: unknown): value is NgrokTunnel {
  return (
    isRecord(value) &&
    typeof value.proto === "string" &&
    typeof value.public_url === "string" &&
    isRecord(value.config) &&
    typeof value.config.addr === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
