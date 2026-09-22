import process from "node:process"
import { MCP_CONFIG } from "../src/config.ts"

const optional = process.argv.includes("--optional")
if (!MCP_CONFIG.ngrok.enabled) {
  console.log(`MCP URL: http://${MCP_CONFIG.host}:${MCP_CONFIG.port}/mcp (local only)`)
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

async function discoverNgrokUrl(attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_CONFIG.ngrok.apiPort}/api/tunnels`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) {
        const payload = await response.json()
        const tunnel = payload.tunnels?.find((candidate) => {
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

    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
