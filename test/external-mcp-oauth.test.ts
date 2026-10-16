import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import { join } from "node:path"
import test from "node:test"

import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

import {
  ExternalMcpOAuth,
  KeyringOAuthProvider,
  mcpOAuthAccount,
  type OAuthSecretStore,
  shouldUseMcpOAuth,
} from "../src/external-mcp/oauth.js"
import { createExternalMcpRegistry } from "../src/external-mcp/registry.js"
import { tempDir } from "./helpers/temp.js"

function memoryStore(): OAuthSecretStore {
  let value: string | null = null
  return {
    async getPassword() {
      return value
    },
    async setPassword(next) {
      value = next
    },
    async deletePassword() {
      const had = value !== null
      value = null
      return had
    },
  }
}

const remote = { type: "remote" as const, url: "https://mcp.example.com/mcp", enabled: true }

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test("OAuth auto mode preserves existing header auth without emitting new OAuth requests", () => {
  assert.equal(shouldUseMcpOAuth(remote), true)
  assert.equal(shouldUseMcpOAuth({ ...remote, auth: "oauth" }), true)
  assert.equal(shouldUseMcpOAuth({ ...remote, auth: "none" }), false)
  assert.equal(shouldUseMcpOAuth({ ...remote, auth: "headers" }), false)
  assert.equal(shouldUseMcpOAuth({ ...remote, headers: { authorization: "Bearer legacy" } }), false)
  assert.notEqual(mcpOAuthAccount("first", remote.url), mcpOAuthAccount("second", remote.url))
  assert.notEqual(
    mcpOAuthAccount("first", remote.url),
    mcpOAuthAccount("first", remote.url, "different-client")
  )
})

test("OAuth credentials are persisted per resource, bound to issuer and cleared on disconnect", async () => {
  const store = memoryStore()
  const provider = new KeyringOAuthProvider("test", remote, () => undefined, 37792, store)
  const a = { issuer: "https://issuer-a.example.com" }
  const b = { issuer: "https://issuer-b.example.com" }
  await provider.saveClientInformation({ client_id: "client-a" }, a)
  await provider.saveClientInformation({ client_id: "client-b" }, b)
  await provider.saveCodeVerifier("pkce-secret")
  assert.equal(provider.hasOAuthTokens, false)
  await provider.saveTokens(
    { access_token: "sensitive-token", token_type: "Bearer", issuer: a.issuer },
    a
  )
  assert.equal(provider.hasOAuthTokens, true)
  assert.equal((await provider.clientInformation(a))?.client_id, "client-a")
  assert.equal((await provider.clientInformation(b))?.client_id, "client-b")
  assert.equal((await provider.tokens(a))?.access_token, "sensitive-token")
  assert.equal(await provider.tokens(b), undefined)
  assert.equal(await provider.codeVerifier(), "pkce-secret")

  const restored = new KeyringOAuthProvider("test", remote, () => undefined, 37792, store)
  assert.equal(restored.hasOAuthTokens, false)
  assert.equal((await restored.tokens())?.access_token, "sensitive-token")
  assert.equal(restored.hasOAuthTokens, true)
  assert.equal((await restored.clientInformation(b))?.client_id, "client-b")
  await restored.disconnect()
  assert.equal(restored.hasOAuthTokens, false)
  assert.equal(await restored.tokens(), undefined)
})

test("OAuth loopback callback rejects wrong state and replays, and resumes connection once", async (t) => {
  const port = await freePort()
  const store = memoryStore()
  const manager = new ExternalMcpOAuth(port, () => store)
  t.after(() => manager.close())
  let resumes = 0
  manager.setAuthorizedHandler(async () => {
    resumes += 1
  })
  const provider = manager.provider("protected", remote) as KeyringOAuthProvider
  const state = provider.state()
  await provider.saveCodeVerifier("one-time-pkce-verifier")
  const expected = "abc-code"
  let exchanges = 0
  let closed = 0
  manager.track("protected", {
    async finishAuth(params: URLSearchParams) {
      assert.equal(params.get("code"), expected)
      exchanges += 1
    },
    async close() {
      closed += 1
    },
  } as unknown as StreamableHTTPClientTransport)

  await provider.redirectToAuthorization(
    new URL("https://auth.example.com/authorize?client_id=example")
  )
  assert.equal(manager.status("protected").status, "auth_required")
  assert.equal(manager.status("protected").oauthDetected, true)
  assert.match(manager.begin("protected").authorizationUrl, /^https:\/\/auth.example.com/)

  const callback = `http://127.0.0.1:${port}/callback`
  assert.equal((await fetch(`${callback}?code=${expected}&state=invalid`)).status, 400)
  assert.equal(exchanges, 0)
  assert.equal(
    (await fetch(`${callback}?code=${expected}&state=${encodeURIComponent(state)}`)).status,
    200
  )
  assert.equal(exchanges, 1)
  assert.equal(resumes, 1)
  assert.equal(closed, 1)
  await assert.rejects(provider.codeVerifier(), /PKCE verifier unavailable/)
  assert.equal(manager.status("protected").status, "none")
  assert.equal(
    (await fetch(`${callback}?code=${expected}&state=${encodeURIComponent(state)}`)).status,
    400
  )
  assert.equal(exchanges, 1)
})

test("expired OAuth login is not offered again and releases its pending transport", async (t) => {
  const port = await freePort()
  const manager = new ExternalMcpOAuth(port, () => memoryStore())
  t.after(() => manager.close())
  const provider = manager.provider("expired", remote) as KeyringOAuthProvider
  provider.state()
  let closed = 0
  manager.track("expired", {
    async close() {
      closed += 1
    },
  } as unknown as StreamableHTTPClientTransport)
  await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"))
  const before = Date.now()
  t.mock.method(Date, "now", () => before + 11 * 60_000)
  assert.equal(manager.status("expired").status, "error")
  assert.throws(() => manager.begin("expired"), /No pending OAuth login/)
  t.mock.restoreAll()
  assert.equal(closed, 1)
})

test("protected MCP completes SDK discovery, PKCE, DCR and reconnect", {
  timeout: 15_000,
}, async (t) => {
  const callbackPort = await freePort()
  let base = ""
  let challenge = ""
  let exchanged = 0
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base || "http://127.0.0.1")
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(data))
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return json({ resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      })
    if (url.pathname === "/register")
      return json(
        {
          client_id: "test-client",
          token_endpoint_auth_method: "none",
          redirect_uris: [`http://127.0.0.1:${callbackPort}/callback`],
        },
        201
      )
    const chunks: Buffer[] = []
    for await (const part of req) chunks.push(Buffer.from(part))
    if (url.pathname === "/token") {
      const params = new URLSearchParams(Buffer.concat(chunks).toString())
      assert.equal(
        createHash("sha256")
          .update(params.get("code_verifier") ?? "")
          .digest("base64url"),
        challenge
      )
      assert.equal(params.get("resource"), `${base}/mcp`)
      assert.equal(params.get("code"), "valid-code")
      exchanged++
      return json({ access_token: "mock-access", token_type: "Bearer", expires_in: 3600 })
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer mock-access") {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        })
        return res.end()
      }
      if (req.method === "GET") return res.writeHead(405).end()
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number
        method: string
        params?: { protocolVersion?: string }
      }
      if (body.method === "notifications/initialized") return res.writeHead(202).end()
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "initialize"
            ? {
                protocolVersion: body.params?.protocolVersion ?? "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "oauth-test", version: "1" },
              }
            : { tools: [] },
      })
    }
    return json({ error: "unknown route" }, 404)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  base = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const root = await tempDir(t, "openchatx-oauth-e2e-")
  const file = join(root, "mcp-servers.json")
  await writeFile(
    file,
    JSON.stringify({
      protected: {
        type: "remote",
        url: `${base}/mcp`,
        enabled: true,
        auth: "oauth",
      },
    })
  )
  const credentialStore = memoryStore()
  const oauth = new ExternalMcpOAuth(callbackPort, () => credentialStore)
  let registry = await createExternalMcpRegistry(file, oauth)
  t.after(() => registry.close())
  assert.equal(registry.authorization?.().protected?.status, "auth_required")
  assert.equal(registry.authorization?.().protected?.oauthDetected, true)
  const authorize = new URL(registry.beginAuthorization?.("protected").authorizationUrl ?? "")
  assert.equal(authorize.origin, base)
  assert.equal(authorize.searchParams.get("resource"), `${base}/mcp`)
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256")
  challenge = authorize.searchParams.get("code_challenge") ?? ""
  assert.ok(challenge)
  const state = authorize.searchParams.get("state")
  assert.ok(state)
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "")
  assert.equal(registry.authorization?.().protected?.redirectUrl, callback.href)
  callback.searchParams.set("state", state)
  callback.searchParams.set("code", "valid-code")
  assert.equal((await fetch(callback)).status, 200)
  assert.equal(exchanged, 1)
  assert.deepEqual(registry.connectedServers, ["protected"])
  assert.equal(registry.authorization?.().protected?.status, "none")
  assert.equal(registry.authorization?.().protected?.oauthDetected, true)

  // After a runtime restart the saved OAuth token must still identify this
  // as an OAuth MCP, rather than hiding its account-management controls.
  await registry.close()
  registry = await createExternalMcpRegistry(
    file,
    new ExternalMcpOAuth(callbackPort, () => credentialStore)
  )
  assert.deepEqual(registry.connectedServers, ["protected"])
  assert.equal(registry.authorization?.().protected?.status, "none")
  assert.equal(registry.authorization?.().protected?.oauthDetected, true)
})
