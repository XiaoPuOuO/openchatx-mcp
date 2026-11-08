import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { basename, dirname, join } from "node:path"

import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"

import { MCP_CONFIG } from "../config.js"
import type { SubagentModelProfile } from "./config.js"
import { openaiThinkingConfig } from "./model-metadata.js"

const AUTH_ORIGIN = "https://auth.openai.com"
const RESOURCE = "https://api.openai.com/v1"
const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`
const CALLBACK_PATH = "/auth/callback"
const PERMISSION = "chatgpt.tokens.use.direct"
const WHITESPACE_RE = /\s+/u
const JWKS = createRemoteJWKSet(new URL(`${AUTH_ORIGIN}/.well-known/jwks.json`))

const accountSchema = z.object({
  clientId: z.string().min(1),
  subject: z.string().min(1),
  email: z.string().optional(),
  idToken: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
})
const stateSchema = z.object({
  hostId: z.string().min(1),
  account: accountSchema.optional(),
})
const tokensSchema = z.object({
  id_token: z.string().min(1).optional(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string(),
  token_type: z.string().optional(),
})
type AuthState = z.infer<typeof stateSchema>
type AuthAccount = z.infer<typeof accountSchema>

export interface ChatGPTModel {
  id: string
  name: string
  description?: string
  context_window?: number
  max_output_tokens?: number
  thinking?: SubagentModelProfile["thinking"]
}

// Model-list visibility is account-specific. This table enriches returned entries only;
// it never makes an unavailable model selectable. Unknown capacities stay editable.
const KNOWN_OPENAI_CAPACITIES: Record<
  string,
  { context_window: number; max_output_tokens: number }
> = {
  "gpt-6-astra": { context_window: 1_050_000, max_output_tokens: 128_000 },
  "gpt-6.1-sol": { context_window: 500_000, max_output_tokens: 128_000 }, // ChatGPT/Codex subscription default
  "gpt-6.1-terra": { context_window: 1_050_000, max_output_tokens: 128_000 },
  "gpt-6-luna": { context_window: 1_050_000, max_output_tokens: 128_000 },
  "gpt-5-codex": { context_window: 400_000, max_output_tokens: 128_000 },
}

interface PendingLogin {
  server: Server
  timer: NodeJS.Timeout
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  existing?: AuthAccount
}

/** ChatGPT plan OAuth is separate from OpenAI Platform API-key authentication. */
export class ChatGPTAuth {
  private state?: AuthState
  private loading?: Promise<AuthState>
  private refreshing?: Promise<string>
  private pending?: PendingLogin
  private loginError?: string

  constructor(private readonly file = join(MCP_CONFIG.stateDir, "chatgpt-auth.json")) {}

  async status(): Promise<{
    connected: boolean
    authorized: boolean
    email?: string
    expiresAt?: number
    pending: boolean
    error?: string
  }> {
    const state = await this.load()
    const account = state.account
    return {
      connected: Boolean(account),
      authorized: Boolean(account?.scopes.includes(PERMISSION)),
      ...(account?.email ? { email: account.email } : {}),
      ...(account ? { expiresAt: account.expiresAt } : {}),
      pending: Boolean(this.pending),
      ...(this.loginError ? { error: this.loginError } : {}),
    }
  }

  async begin(): Promise<{ authorizationUrl: string }> {
    const state = await this.load()
    this.stopPending()
    this.loginError = undefined
    const server = createServer((req, res) => {
      if (!req.url || req.method !== "GET") {
        res.writeHead(404).end()
        return
      }
      const callback = new URL(req.url, "http://127.0.0.1")
      if (callback.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end()
        return
      }
      const pending = this.pending
      if (!pending || pending.server !== server) {
        res.writeHead(410).end("Sign-in attempt expired.")
        return
      }
      // Consume once before any network request or await.
      this.pending = undefined
      clearTimeout(pending.timer)
      void this.complete(pending, callback)
        .then(() => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          res.end(
            "<!doctype html><title>OpenChatX</title><p>ChatGPT connected. You may close this window.</p>"
          )
        })
        .catch((error) => {
          this.loginError = error instanceof Error ? error.message : "ChatGPT sign-in failed."
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          res.end(
            "<!doctype html><title>OpenChatX</title><p>ChatGPT sign-in failed. Return to OpenChatX.</p>"
          )
        })
        .finally(() => server.close())
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string")
        throw new Error("OAuth callback port unavailable.")
      const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`
      const verifier = randomBytes(48).toString("base64url")
      const requestState = randomBytes(32).toString("base64url")
      const nonce = randomBytes(32).toString("base64url")
      const timer = setTimeout(() => {
        this.loginError = "ChatGPT sign-in timed out. Try again."
        this.stopPending()
      }, 10 * 60_000)
      timer.unref()
      const existing = state.account
      this.pending = { server, timer, state: requestState, nonce, verifier, redirectUri, existing }
      const params = new URLSearchParams({
        client_id: existing?.clientId ?? "dynamic_agent_client",
        ext_agent_host_id: state.hostId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        resource: RESOURCE,
        state: requestState,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      })
      if (existing) {
        params.set("id_token_hint", existing.idToken)
        if (existing.email) params.set("login_hint", existing.email)
      } else {
        params.set("agent_name_hint", "OpenChatX")
      }
      return { authorizationUrl: `${AUTH_ORIGIN}/api/accounts/authorize?${params}` }
    } catch (error) {
      server.close()
      throw error
    }
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    this.stopPending()
    this.loginError = undefined
    const state = await this.load()
    const account = state.account
    let revoked = !account
    if (account) {
      try {
        const metadata = await fetch(`${AUTH_ORIGIN}/.well-known/openid-configuration`)
        const discovery: unknown = metadata.ok ? await metadata.json() : undefined
        const revocationUrl = isRecord(discovery) ? discovery.revocation_endpoint : undefined
        if (typeof revocationUrl === "string" && new URL(revocationUrl).origin === AUTH_ORIGIN) {
          const response = await fetch(revocationUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: account.refreshToken,
              token_type_hint: "refresh_token",
              client_id: account.clientId,
            }),
            signal: AbortSignal.timeout(10_000),
          })
          revoked = response.ok
        }
      } catch {
        // Local disconnection still succeeds; remote revocation may need ChatGPT Settings.
      }
    }
    // Keep the host identity; the next login can register a new account.
    await this.persist({ hostId: state.hostId })
    return { revoked }
  }

  async accessToken(): Promise<string> {
    const state = await this.load()
    const account = state.account
    if (!account?.scopes.includes(PERMISSION))
      throw new Error("Sign in with ChatGPT and authorize plan usage in Subagent settings.")
    if (Date.now() < account.expiresAt - 60_000) return account.accessToken
    this.refreshing ??= this.refresh(account).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  async models(): Promise<ChatGPTModel[]> {
    const response = await fetch(`${RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`ChatGPT model discovery failed (HTTP ${response.status}).`)
    const payload: unknown = await response.json()
    return parseChatGPTModels(payload)
  }

  private async complete(pending: PendingLogin, callback: URL): Promise<void> {
    if (callback.searchParams.get("state") !== pending.state)
      throw new Error("ChatGPT OAuth state mismatch.")
    const error = callback.searchParams.get("error")
    if (error) throw new Error(`ChatGPT authorization was not completed (${error}).`)
    const code = callback.searchParams.get("code")
    if (!code) throw new Error("ChatGPT authorization callback is missing a code.")
    const returnedId = callback.searchParams.get("client_id")
    if (pending.existing && returnedId && returnedId !== pending.existing.clientId)
      throw new Error("ChatGPT OAuth client changed unexpectedly.")
    const clientId = pending.existing?.clientId ?? returnedId
    if (!clientId || clientId === "dynamic_agent_client")
      throw new Error("ChatGPT OAuth registration did not return a client ID.")
    const tokens = await this.exchange(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        resource: RESOURCE,
      })
    )
    if (!tokens.id_token) throw new Error("ChatGPT OAuth did not return an identity token.")
    const { payload } = await jwtVerify(tokens.id_token, JWKS, {
      issuer: AUTH_ORIGIN,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    })
    if (payload.nonce !== pending.nonce || typeof payload.sub !== "string" || !payload.sub)
      throw new Error("ChatGPT OAuth identity validation failed.")
    if (pending.existing && payload.sub !== pending.existing.subject)
      throw new Error("ChatGPT account differs from the connected account. Disconnect first.")
    const scopes = tokens.scope.split(WHITESPACE_RE).filter(Boolean)
    if (!scopes.includes(PERMISSION))
      throw new Error("ChatGPT plan usage permission was not granted.")
    const state = await this.load()
    await this.persist({
      hostId: state.hostId,
      account: {
        clientId,
        subject: payload.sub,
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        scopes,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      },
    })
    this.loginError = undefined
  }

  private async refresh(account: AuthAccount): Promise<string> {
    let tokens: z.infer<typeof tokensSchema>
    try {
      tokens = await this.exchange(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: account.refreshToken,
          client_id: account.clientId,
          resource: RESOURCE,
        })
      )
    } catch (error) {
      if (error instanceof Error && error.message.includes("invalid_grant")) {
        const state = await this.load()
        await this.persist({ hostId: state.hostId })
        throw new Error("ChatGPT session expired. Sign in again.", { cause: error })
      }
      throw error
    }
    const scopes = tokens.scope.split(WHITESPACE_RE).filter(Boolean)
    if (!scopes.includes(PERMISSION))
      throw new Error("ChatGPT plan usage permission was revoked. Sign in again.")
    const state = await this.load()
    await this.persist({
      hostId: state.hostId,
      account: {
        ...account,
        idToken: tokens.id_token ?? account.idToken,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        scopes,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      },
    })
    return tokens.access_token
  }

  private async exchange(body: URLSearchParams): Promise<z.infer<typeof tokensSchema>> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined)
      const code =
        isRecord(payload) && typeof payload.error === "string" ? payload.error : undefined
      throw new Error(
        `ChatGPT OAuth token exchange failed (HTTP ${response.status}${code ? `, ${code}` : ""}).`
      )
    }
    return tokensSchema.parse(await response.json())
  }

  private stopPending(): void {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    this.pending.server.close()
    this.pending = undefined
  }

  private async load(): Promise<AuthState> {
    if (this.state) return this.state
    this.loading ??= (async () => {
      try {
        const state = stateSchema.parse(JSON.parse(await readFile(this.file, "utf8")))
        this.state = state
        return state
      } catch (error) {
        if (!isFileNotFound(error)) throw error
        const state = { hostId: `urn:uuid:${randomUUID()}` }
        await this.persist(state)
        return state
      }
    })().finally(() => {
      this.loading = undefined
    })
    return this.loading
  }

  private async persist(next: AuthState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
      this.state = next
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export function parseChatGPTModels(payload: unknown): ChatGPTModel[] {
  if (!isRecord(payload)) throw new Error("ChatGPT model response is not an object.")
  const entries = Array.isArray(payload.models) ? payload.models : payload.data
  if (!Array.isArray(entries)) throw new Error("ChatGPT model response contains no model list.")
  return entries.flatMap((item): ChatGPTModel[] => {
    const model = parseChatGPTModel(item)
    return model ? [model] : []
  })
}

function parseChatGPTModel(item: unknown): ChatGPTModel | undefined {
  if (!isRecord(item) || (item.visibility && item.visibility !== "list")) return undefined
  const id = typeof item.slug === "string" ? item.slug : item.id
  if (typeof id !== "string" || !id) return undefined
  const context =
    positiveInteger(item.context_window) ??
    positiveInteger(item.context_length) ??
    KNOWN_OPENAI_CAPACITIES[id]?.context_window
  const max =
    positiveInteger(item.max_output_tokens) ?? KNOWN_OPENAI_CAPACITIES[id]?.max_output_tokens
  const thinking = openaiThinkingConfig(id, true)
  return {
    id,
    name: typeof item.display_name === "string" ? item.display_name : id,
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(context ? { context_window: context } : {}),
    ...(max ? { max_output_tokens: max } : {}),
    ...(thinking ? { thinking } : {}),
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
