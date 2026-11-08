import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createTailnetUiProxy,
  isTailnetIPv4,
  type TailnetCli,
  TailnetUiManager,
  type TailnetUiSettings,
} from "../src/server/tailnet-ui.js"

const baseConfig: TailnetUiSettings = {
  enabled: true,
  ip: "100.82.192.72",
  cli_path: "",
  socket_path: "",
}

function mockTailscale(existing?: string) {
  let forward = existing
  const cli: TailnetCli = {
    run(_settings, args) {
      if (args.join(" ") === "ip -4") return baseConfig.ip
      if (args.join(" ") === "serve status --json")
        return JSON.stringify(forward ? { TCP: { 8001: { TCPForward: forward } } } : {})
      if (args[0] === "serve" && args[1] === "--tcp=8001" && args[2] === "off") {
        forward = undefined
        return ""
      }
      if (args[0] === "serve" && args[1] === "--bg" && args[2] === "--tcp=8001") {
        forward = args[3]?.replace(/^tcp:\/\//u, "")
        return ""
      }
      throw new Error(`Unexpected Tailscale invocation: ${args.join(" ")}`)
    },
  }
  return {
    cli,
    current: () => forward,
    drop: () => {
      forward = undefined
    },
  }
}

function probe(url: string, host: string, method = "GET", origin?: string) {
  return new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method,
        headers: { host, ...(origin ? { origin } : {}) },
      },
      (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          data += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data }))
      }
    )
    req.on("error", reject)
    req.end()
  })
}

test("Tailnet UI validates an actual Tailscale IPv4 address", () => {
  assert.equal(isTailnetIPv4("100.82.192.72"), true)
  for (const ip of ["", "192.168.1.1", "100.63.1.1", "100.128.1.1", "100.82.999.1", "100.082.1.1"])
    assert.equal(isTailnetIPv4(ip), false, ip)
})

test("private UI proxy allows its own UI but denies MCP, other Hosts, and cross-origin changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-tailnet-ui-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ path: req.url, host: req.headers.host, origin: req.headers.origin }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("No upstream port")
  const port = upstreamAddress.port
  const proxy = createTailnetUiProxy(baseConfig.ip, port)
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    proxy.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ])
  })
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("No proxy port")
  const endpoint = `http://127.0.0.1:${proxyAddress.port}`
  const host = `${baseConfig.ip}:${port}`

  const allowed = await probe(`${endpoint}/ui/api/settings`, host)
  assert.equal(allowed.status, 200, allowed.data)
  const body = JSON.parse(allowed.data) as { host: string }
  assert.equal(body.host, `127.0.0.1:${port}`)
  for (const path of ["/mcp", "/healthz", "/", "/ui/%2e%2e/mcp"]) {
    const denied = await probe(`${endpoint}${path}`, host)
    assert.equal(denied.status, 403, path)
  }
  assert.equal((await probe(`${endpoint}/ui/`, "evil.example")).status, 403)
  assert.equal(
    (await probe(`${endpoint}/ui/api/settings`, host, "PUT", "https://attacker.example")).status,
    403
  )
  assert.equal((await probe(`${endpoint}/ui/api/settings`, host, "PUT")).status, 403)
  const legitimate = await probe(`${endpoint}/ui/api/settings`, host, "PUT", `http://${host}`)
  assert.equal(legitimate.status, 200, legitimate.data)
  assert.equal(
    (JSON.parse(legitimate.data) as { origin: string }).origin,
    `http://127.0.0.1:${port}`
  )
})

test("manager owns only its Tailscale forward and removes it when switched off", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-tailnet-manager-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tailscale = mockTailscale()
  const manager = new TailnetUiManager(8001, root, tailscale.cli)
  await manager.apply(baseConfig)
  assert.match(tailscale.current() ?? "", /^127\.0\.0\.1:\d+$/u)
  assert.equal(JSON.parse(await readFile(join(root, "tailnet-ui-forward.json"), "utf8")).port, 8001)
  await manager.apply({ ...baseConfig, enabled: false })
  assert.equal(tailscale.current(), undefined)
  await assert.rejects(readFile(join(root, "tailnet-ui-forward.json"), "utf8"), /ENOENT/u)
  await manager.close()
})

test("normal shutdown retains the owned forward and the next runtime reclaims it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-tailnet-restart-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tailscale = mockTailscale()
  const previousRuntime = new TailnetUiManager(8001, root, tailscale.cli)
  await previousRuntime.apply(baseConfig)
  const previousTarget = tailscale.current()
  await previousRuntime.close()
  assert.equal(tailscale.current(), previousTarget)
  assert.equal(
    JSON.parse(await readFile(join(root, "tailnet-ui-forward.json"), "utf8")).target,
    previousTarget
  )

  const nextRuntime = new TailnetUiManager(8001, root, tailscale.cli)
  await nextRuntime.apply(baseConfig)
  assert.match(tailscale.current() ?? "", /^127\.0\.0\.1:\d+$/u)
  assert.notEqual(tailscale.current(), previousTarget)
  await nextRuntime.apply({ ...baseConfig, enabled: false })
  assert.equal(tailscale.current(), undefined)
  await nextRuntime.close()
})

test("reconciliation restores the forward after Tailscale drops its Serve state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-tailnet-reconcile-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tailscale = mockTailscale()
  const manager = new TailnetUiManager(8001, root, tailscale.cli)
  await manager.apply(baseConfig)
  tailscale.drop()
  assert.equal(tailscale.current(), undefined)
  await manager.apply(baseConfig)
  assert.match(tailscale.current() ?? "", /^127\.0\.0\.1:\d+$/u)
  await manager.apply({ ...baseConfig, enabled: false })
  await manager.close()
})

test("manager rejects an occupied Tailscale Serve port without modifying it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openchatx-tailnet-foreign-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tailscale = mockTailscale("127.0.0.1:9999")
  const manager = new TailnetUiManager(8001, root, tailscale.cli)
  await assert.rejects(manager.apply(baseConfig), /already used by another service/u)
  assert.equal(tailscale.current(), "127.0.0.1:9999")
  await manager.close()
})
