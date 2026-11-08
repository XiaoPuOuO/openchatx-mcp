import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"

import type { OpenChatXPublicConfig } from "../public-config.cjs"

export type TailnetUiSettings = OpenChatXPublicConfig["tailnet_ui"]

interface OwnedForward {
  port: number
  target: string
  ip: string
  cli_path: string
  socket_path: string
}

interface ActiveForward {
  server: Server
  settings: TailnetUiSettings
  record: OwnedForward
}

export interface TailnetCli {
  run(settings: Pick<TailnetUiSettings, "cli_path" | "socket_path">, args: string[]): string
}

const OCTET_PATTERN = /^(?:0|[1-9][0-9]{0,2})$/u
const UI_PATH_PATTERN = /^\/ui(?:\/|$)/u
const LOCAL_TARGET_PATTERN = /^127\.0\.0\.1:[0-9]{1,5}$/u

const defaultCli: TailnetCli = {
  run(settings, args) {
    let candidates: string[]
    if (settings.cli_path) candidates = [expandHome(settings.cli_path)]
    else if (process.platform === "win32")
      candidates = ["tailscale.exe", "C:\\Program Files\\Tailscale\\tailscale.exe"]
    else candidates = ["tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
    for (const binary of candidates) {
      try {
        return execFileSync(
          binary,
          [
            ...(settings.socket_path ? [`--socket=${expandHome(settings.socket_path)}`] : []),
            ...args,
          ],
          { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }
        ).trim()
      } catch (error) {
        if (
          !settings.cli_path &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Tailscale CLI failed: ${message}`, { cause: error })
      }
    }
    throw new Error("Tailscale CLI not found. Install and connect Tailscale first.")
  },
}

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isTailnetIPv4(ip: string): boolean {
  const parts = ip.split(".")
  if (parts.length !== 4 || parts.some((part) => !OCTET_PATTERN.test(part))) return false
  const octets = parts.map(Number)
  return (
    octets.every((octet) => octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    (octets[1] ?? 0) >= 64 &&
    (octets[1] ?? 0) <= 127
  )
}

function remotePath(raw: string | undefined, ip: string, port: number): string | undefined {
  try {
    const requestUrl = new URL(raw ?? "/", `http://${ip}:${port}`)
    if (requestUrl.host !== `${ip}:${port}`) return
    return UI_PATH_PATTERN.test(requestUrl.pathname) ? (raw ?? "/") : undefined
  } catch {
    // Malformed URLs must not reach the local MCP service.
  }
}

export function createTailnetUiProxy(ip: string, port: number): Server {
  const remoteHost = `${ip}:${port}`
  const remoteOrigin = `http://${remoteHost}`
  const localHost = `127.0.0.1:${port}`
  return createServer((req, res) => {
    const path = remotePath(req.url, ip, port)
    const origin = req.headers.origin
    const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(req.method ?? "")
    if (
      req.headers.host !== remoteHost ||
      path === undefined ||
      (origin !== undefined && origin !== remoteOrigin) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      (!safeMethod && origin !== remoteOrigin)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
      res.end("Forbidden")
      return
    }
    const headers: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (!name.startsWith("x-forwarded-")) headers[name] = value
    }
    headers.host = localHost
    if (origin) headers.origin = `http://${localHost}`
    const upstream = httpRequest(
      { hostname: "127.0.0.1", port, method: req.method, path, headers },
      (upstreamResponse) => {
        const responseHeaders: IncomingHttpHeaders = {}
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (name !== "access-control-allow-origin") responseHeaders[name] = value
        }
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.pipe(res)
      }
    )
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" })
      res.end("OpenChatX unavailable")
    })
    res.on("close", () => upstream.destroy())
    req.pipe(upstream)
  })
}

/** An optional, app-owned Tailscale Serve route. Never installs or logs in to Tailscale. */
export class TailnetUiManager {
  private readonly stateFile: string
  private active?: ActiveForward
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly port: number,
    stateDir: string,
    private readonly cli: TailnetCli = defaultCli
  ) {
    this.stateFile = join(stateDir, "tailnet-ui-forward.json")
  }

  async apply(settings: TailnetUiSettings): Promise<void> {
    // A settings save and the periodic reconnect check can happen at the same time.
    // Serialize them so a stale check cannot replace a newly created forward.
    const next = this.pending.then(() => this.applyOnce(settings))
    this.pending = next.catch(() => undefined)
    await next
  }

  private async applyOnce(settings: TailnetUiSettings): Promise<void> {
    if (!settings.enabled) {
      await this.disable()
      return
    }
    if (!isTailnetIPv4(settings.ip))
      throw new Error("Enter this Mac's Tailscale IPv4 address (100.64.0.0/10).")
    const ownIP = this.cli.run(settings, ["ip", "-4"]).trim()
    if (ownIP !== settings.ip)
      throw new Error(`Tailscale IP mismatch: this Mac has ${ownIP}, not ${settings.ip}.`)

    const stored = this.active?.record ?? this.readRecord()
    const forward = this.currentForward(settings)
    if (forward && (stored?.port !== this.port || stored.target !== forward))
      throw new Error(
        `Tailscale Serve port ${this.port} is already used by another service. No changes made.`
      )
    if (
      this.active &&
      JSON.stringify(this.active.settings) === JSON.stringify(settings) &&
      forward === this.active.record.target
    )
      return

    const server = createTailnetUiProxy(settings.ip, this.port)
    try {
      const localPort = await new Promise<number>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject)
          const address = server.address()
          if (!address || typeof address === "string") reject(new Error("No proxy TCP address"))
          else resolve(address.port)
        })
      })
      const target = `127.0.0.1:${localPort}`
      if (forward) this.cli.run(settings, ["serve", `--tcp=${this.port}`, "off"])
      try {
        this.cli.run(settings, ["serve", "--bg", `--tcp=${this.port}`, `tcp://${target}`])
        if (this.currentForward(settings) !== target)
          throw new Error("Tailscale Serve did not activate")
        const record: OwnedForward = {
          port: this.port,
          target,
          ip: settings.ip,
          cli_path: settings.cli_path,
          socket_path: settings.socket_path,
        }
        mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 })
        writeFileSync(this.stateFile, JSON.stringify(record), { encoding: "utf8", mode: 0o600 })
        const old = this.active
        this.active = { server, settings: { ...settings }, record }
        old?.server.close()
      } catch (error) {
        try {
          this.cli.run(settings, ["serve", `--tcp=${this.port}`, "off"])
          if (forward)
            this.cli.run(settings, ["serve", "--bg", `--tcp=${this.port}`, `tcp://${forward}`])
        } catch (rollbackError) {
          console.error("Could not restore previous Tailscale Serve rule:", rollbackError)
        }
        throw error
      }
    } catch (error) {
      server.close()
      throw error
    }
  }

  async close(): Promise<void> {
    await this.pending
    // Preserve the owned Tailscale Serve entry across normal runtime restarts.
    // The next instance will verify ownership and replace the now-stale target.
    // Only an explicit 'enabled = false' removes the tailnet entry.
    this.active?.server.close()
    this.active = undefined
  }

  private async disable(): Promise<void> {
    const record = this.active?.record ?? this.readRecord()
    if (record) {
      const settings = { cli_path: record.cli_path, socket_path: record.socket_path }
      const existing = this.currentForward(settings, record.port)
      if (existing === record.target)
        this.cli.run(settings, ["serve", `--tcp=${record.port}`, "off"])
      if (existsSync(this.stateFile)) unlinkSync(this.stateFile)
    }
    if (this.active) this.active.server.close()
    this.active = undefined
  }

  private currentForward(
    settings: Pick<TailnetUiSettings, "cli_path" | "socket_path">,
    port = this.port
  ): string | undefined {
    const status: unknown = JSON.parse(this.cli.run(settings, ["serve", "status", "--json"]))
    if (!isRecord(status) || !isRecord(status.TCP)) return
    const entry = status.TCP[String(port)]
    return isRecord(entry) && typeof entry.TCPForward === "string" ? entry.TCPForward : undefined
  }

  private readRecord(): OwnedForward | undefined {
    if (!existsSync(this.stateFile)) return
    try {
      const value: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"))
      if (
        !isRecord(value) ||
        typeof value.port !== "number" ||
        !Number.isInteger(value.port) ||
        typeof value.target !== "string" ||
        !LOCAL_TARGET_PATTERN.test(value.target) ||
        typeof value.cli_path !== "string" ||
        typeof value.socket_path !== "string" ||
        typeof value.ip !== "string" ||
        !isTailnetIPv4(value.ip)
      )
        throw new Error("Invalid Tailscale forward record")
      return {
        port: value.port,
        target: value.target,
        ip: value.ip,
        cli_path: value.cli_path,
        socket_path: value.socket_path,
      }
    } catch (error) {
      throw new Error("OpenChatX Tailscale ownership state is invalid; refusing to modify Serve", {
        cause: error,
      })
    }
  }
}
