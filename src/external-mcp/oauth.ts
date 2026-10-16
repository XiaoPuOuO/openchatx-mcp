import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type Server } from "node:http"
import process from "node:process"
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { AsyncEntry } from "@napi-rs/keyring"
import type { ExternalMcpServerConfig } from "./config.js"

type RemoteConfig = Extract<ExternalMcpServerConfig, { type: "remote" }>

export type McpOAuthStatus = "none" | "auth_required" | "authorizing" | "error"

export interface McpOAuthState {
  status: McpOAuthStatus
  detail?: string
  redirectUrl?: string
  oauthDetected?: boolean
}

interface StoredSession {
  clients?: Record<string, StoredOAuthClientInformation>
  tokens?: StoredOAuthTokens
  verifier?: string
  discovery?: OAuthDiscoveryState
}

interface PendingLogin {
  provider: KeyringOAuthProvider
  transport: StreamableHTTPClientTransport
  url: string
  expiresAt: number
}

export interface OAuthSecretStore {
  getPassword(): Promise<string | null>
  setPassword(value: string): Promise<void>
  deletePassword(): Promise<boolean>
}

const CALLBACK_PORT = 37791
const CALLBACK_PATH = "/callback"
const LOGIN_TTL_MS = 10 * 60 * 1000
const KEYRING_SERVICE = "org.openchatx.mcp.oauth"

/** The remote resource, not the auth issuer alone, scopes every stored secret. */
export function mcpOAuthAccount(
  id: string,
  url: string,
  clientId?: string,
  metadataUrl?: string
): string {
  return createHash("sha256")
    .update(JSON.stringify([id, url, clientId ?? null, metadataUrl ?? null]))
    .digest("hex")
}

export function shouldUseMcpOAuth(config: RemoteConfig): boolean {
  const mode = config.auth ?? "auto"
  if (mode === "none" || mode === "headers") return false
  if (mode === "oauth") return true
  return !Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === "authorization")
}

export class KeyringOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string
  readonly clientMetadata: OAuthClientMetadata
  readonly clientMetadataUrl?: string
  private readonly entry: OAuthSecretStore
  private record?: StoredSession
  private loading?: Promise<StoredSession>
  private writeQueue: Promise<void> = Promise.resolve()
  private hasTokens = false
  expectedState?: string

  get hasOAuthTokens(): boolean {
    return this.hasTokens
  }

  constructor(
    readonly id: string,
    readonly config: RemoteConfig,
    private readonly redirect: (url: URL) => void | Promise<void>,
    port = CALLBACK_PORT,
    store?: OAuthSecretStore
  ) {
    this.entry =
      store ??
      new AsyncEntry(
        KEYRING_SERVICE,
        mcpOAuthAccount(id, config.url, config.oauthClientId, config.oauthClientMetadataUrl),
        {
          // Never silently use Linux's session-only kernel keyring.
          ...(process.platform === "linux" ? { linux: { store: "secret-service" as const } } : {}),
        }
      )
    this.redirectUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`
    this.clientMetadata = {
      client_name: "OpenChatX",
      redirect_uris: [this.redirectUrl],
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
    if (config.oauthClientMetadataUrl) this.clientMetadataUrl = config.oauthClientMetadataUrl
  }

  private async load(): Promise<StoredSession> {
    if (this.record) return this.record
    if (!this.loading) {
      this.loading = this.entry.getPassword().then((password) => {
        // This OS keyring entry is written by this provider's save() method.
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: Typed JSON from this app-owned keyring entry.
        const value = password ? (JSON.parse(password) as StoredSession) : {}
        this.record = value
        this.hasTokens = Boolean(value.tokens?.access_token)
        return value
      })
    }
    return this.loading
  }

  private async save(update: (value: StoredSession) => void): Promise<void> {
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const next = { ...(await this.load()) }
        update(next)
        await this.entry.setPassword(JSON.stringify(next))
        this.record = next
        this.hasTokens = Boolean(next.tokens?.access_token)
      })
    this.writeQueue = operation
    await operation
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (this.config.oauthClientId) {
      return { client_id: this.config.oauthClientId }
    }
    const stored = await this.load()
    return ctx ? stored.clients?.[ctx.issuer] : undefined
  }

  async saveClientInformation(
    client: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext
  ): Promise<void> {
    if (!ctx) return
    await this.save((stored) => {
      stored.clients = { ...stored.clients, [ctx.issuer]: client }
    })
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const value = (await this.load()).tokens
    if (ctx && value?.issuer !== ctx.issuer) return undefined
    return value
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    // Tokens without a resolvable issuer are rejected instead of crossing AS boundaries.
    if (!tokens.issuer && !ctx?.issuer) throw new Error("OAuth token issuer missing")
    await this.save((stored) => {
      stored.tokens = { ...tokens, issuer: tokens.issuer ?? ctx?.issuer }
    })
  }

  state(): string {
    this.expectedState = randomBytes(32).toString("base64url")
    return this.expectedState
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.redirect(url)
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.save((stored) => {
      stored.verifier = value
    })
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.load()).verifier
    if (!value) throw new Error("OAuth PKCE verifier unavailable")
    return value
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.save((stored) => {
      stored.discovery = value
    })
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discovery
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): Promise<void> {
    await this.save((stored) => {
      if (scope === "all" || scope === "client") stored.clients = undefined
      if (scope === "all" || scope === "tokens") stored.tokens = undefined
      if (scope === "all" || scope === "verifier") stored.verifier = undefined
      if (scope === "all" || scope === "discovery") stored.discovery = undefined
    })
  }

  async disconnect(revoke = false): Promise<void> {
    await this.writeQueue.catch(() => undefined)
    if (revoke) await this.revokeBestEffort()
    await this.entry.deletePassword()
    this.record = undefined
    this.loading = undefined
    this.hasTokens = false
    this.expectedState = undefined
  }

  private async revokeBestEffort(): Promise<void> {
    // Remote revocation is best effort; local logout must work offline.
    try {
      const session = await this.load()
      const token = session.tokens?.refresh_token ?? session.tokens?.access_token
      const issuer = session.tokens?.issuer
      const metadata = session.discovery?.authorizationServerMetadata
      const endpoint =
        metadata &&
        "revocation_endpoint" in metadata &&
        typeof metadata.revocation_endpoint === "string"
          ? metadata.revocation_endpoint
          : undefined
      if (token && issuer && endpoint) {
        const target = new URL(endpoint)
        const authority = new URL(issuer)
        if (
          target.origin === authority.origin &&
          (target.protocol === "https:" ||
            (target.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))
        ) {
          const body = new URLSearchParams({
            token,
            token_type_hint: session.tokens?.refresh_token ? "refresh_token" : "access_token",
          })
          const clientId = this.config.oauthClientId ?? session.clients?.[issuer]?.client_id
          if (clientId) body.set("client_id", clientId)
          await fetch(target, {
            method: "POST",
            body,
            redirect: "error",
            signal: AbortSignal.timeout(3000),
          })
        }
      }
    } catch {
      // An unavailable revocation endpoint does not retain local credentials.
    }
  }
}

/**
 * Browser redirects stay on 127.0.0.1, completely outside the ChatGPT tunnel.
 * The dashboard receives only a URL and non-secret status, never access tokens.
 */
export class ExternalMcpOAuth {
  private readonly providers = new Map<string, KeyringOAuthProvider>()
  private readonly transports = new Map<string, StreamableHTTPClientTransport>()
  private readonly pending = new Map<string, PendingLogin>()
  private readonly states = new Map<string, McpOAuthState>()
  private server?: Server
  private serverReady?: Promise<void>
  private onAuthorized?: (id: string) => Promise<void>

  constructor(
    private readonly port = CALLBACK_PORT,
    private readonly storeFactory?: (id: string, config: RemoteConfig) => OAuthSecretStore
  ) {}

  setAuthorizedHandler(handler: (id: string) => Promise<void>): void {
    this.onAuthorized = handler
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}${CALLBACK_PATH}`
  }

  status(id: string): McpOAuthState {
    const pending = this.pending.get(id)
    if (pending && pending.expiresAt < Date.now()) {
      this.pending.delete(id)
      if (this.transports.get(id) === pending.transport) this.transports.delete(id)
      void pending.transport.close().catch(() => undefined)
      this.states.set(id, {
        status: "error",
        detail: "Authorization request expired. Retry account linking.",
      })
    }
    const state = this.states.get(id) ?? { status: "none" }
    // In auto mode, a working MCP does not imply OAuth. Remember it only
    // after an authorization challenge or when a token exists in the keychain.
    const detected =
      state.status !== "none" ||
      [...this.providers.values()].some((provider) => provider.id === id && provider.hasOAuthTokens)
    return detected ? { ...state, oauthDetected: true } : state
  }

  requiresAuth(id: string): boolean {
    const status = this.status(id).status
    return status === "auth_required" || status === "authorizing"
  }

  provider(id: string, config: RemoteConfig): OAuthClientProvider {
    const key = mcpOAuthAccount(id, config.url, config.oauthClientId, config.oauthClientMetadataUrl)
    const current = this.providers.get(key)
    if (current) return current
    const created = new KeyringOAuthProvider(
      id,
      config,
      (url) => this.offerLogin(id, created, url),
      this.port,
      this.storeFactory?.(id, config)
    )
    this.providers.set(key, created)
    return created
  }

  track(id: string, transport: StreamableHTTPClientTransport): void {
    this.transports.set(id, transport)
  }

  private async offerLogin(id: string, provider: KeyringOAuthProvider, url: URL): Promise<void> {
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
      throw new Error("Insecure OAuth authorization endpoint")
    }
    await this.ensureCallback()
    const transport = this.transports.get(id)
    if (!transport) throw new Error("OAuth transport missing")
    const previous = this.pending.get(id)
    if (previous && previous.transport !== transport)
      void previous.transport.close().catch(() => undefined)
    this.pending.set(id, {
      provider,
      transport,
      url: url.href,
      expiresAt: Date.now() + LOGIN_TTL_MS,
    })
    this.states.set(id, { status: "auth_required" })
  }

  begin(id: string): { authorizationUrl: string } {
    const state = this.status(id)
    const pending = this.pending.get(id)
    if (!pending || state.status !== "auth_required") {
      throw new Error("No pending OAuth login. Refresh the MCP connection first.")
    }
    return { authorizationUrl: pending.url }
  }

  async disconnect(id: string, config: RemoteConfig, revoke = true): Promise<void> {
    const key = mcpOAuthAccount(id, config.url, config.oauthClientId, config.oauthClientMetadataUrl)
    const provider =
      this.providers.get(key) ??
      new KeyringOAuthProvider(
        id,
        config,
        () => undefined,
        this.port,
        this.storeFactory?.(id, config)
      )
    const pending = this.pending.get(id)
    this.pending.delete(id)
    if (pending) await pending.transport.close().catch(() => undefined)
    await provider.disconnect(revoke)
    this.providers.delete(key)
    this.transports.delete(id)
    this.states.delete(id)
  }

  clearPending(id: string): void {
    this.pending.delete(id)
    this.transports.delete(id)
    this.states.delete(id)
  }

  private async ensureCallback(): Promise<void> {
    if (this.serverReady !== undefined) return this.serverReady
    this.serverReady = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        if (
          request.method !== "GET" ||
          !request.url?.startsWith(`${CALLBACK_PATH}?`) ||
          request.headers.host !== `127.0.0.1:${this.port}`
        ) {
          response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found")
          return
        }
        const url = new URL(request.url, `http://127.0.0.1:${this.port}`)
        void this.complete(url.searchParams).then(
          () =>
            response
              .writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
              })
              .end(
                "<!doctype html><title>OpenChatX</title><p>Authorization complete. You can close this window.</p>"
              ),
          () =>
            response
              .writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
              .end("Authorization failed. Return to OpenChatX and retry.")
        )
      })
      server.once("error", reject)
      server.listen(this.port, "127.0.0.1", () => {
        this.server = server
        server.off("error", reject)
        resolve()
      })
    }).catch((error: unknown) => {
      this.serverReady = undefined
      throw new Error("OpenChatX OAuth callback port unavailable", { cause: error })
    })
    return this.serverReady
  }

  private async complete(params: URLSearchParams): Promise<void> {
    const state = params.get("state")
    if (!state) throw new Error("OAuth state missing")
    const found = [...this.pending.entries()].find(([, candidate]) => {
      const expected = candidate.provider.expectedState
      if (!expected || candidate.expiresAt < Date.now()) return false
      const supplied = Buffer.from(state)
      const stored = Buffer.from(expected)
      return supplied.length === stored.length && timingSafeEqual(supplied, stored)
    })
    if (!found) throw new Error("OAuth state mismatch or expired")
    const [id, pending] = found
    this.pending.delete(id) // Reject replays before token exchange.
    this.states.set(id, { status: "authorizing" })
    try {
      await pending.transport.finishAuth(params)
      await pending.provider.invalidateCredentials("verifier")
      await this.onAuthorized?.(id)
      this.states.delete(id)
    } catch (error) {
      this.states.set(id, { status: "error", detail: "Authorization failed. Retry connection." })
      throw error
    } finally {
      if (this.transports.get(id) === pending.transport) this.transports.delete(id)
      await pending.transport.close().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    const pending = [...this.pending.values()]
    this.pending.clear()
    this.transports.clear()
    await Promise.all(pending.map(({ transport }) => transport.close().catch(() => undefined)))
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
    this.server = undefined
    this.serverReady = undefined
  }
}
