---
summary: "Local HTTP/MCP routing, ngrok trust boundary, remote owner binding, request lifetime, and shared process state."
paths:
  - src/server/http-server.ts
  - src/agent/dashboard-routes.ts
  - src/mcp/server-factory.ts
  - src/auth/
  - ngrok-traffic-policy.yml
---

# HTTP Transport

## What This Is

This page documents the local HTTP/MCP boundary, trusted remote path, subject binding, and request lifetime.

## Routes and Middleware

- `createMcpExpressApp({ host, jsonLimit: "1mb" })` creates the Express app and applies the MCP v2 adapter's JSON parsing plus localhost Host/Origin guards. No custom `allowedOrigins` list is configured (`src/server/http-server.ts`).
- `GET /healthz` returns `{ "ok": true }` and an `X-Shellby-Instance` header derived from the repository and resolved state directory. Startup checks that identity so a different copy listening on the selected port cannot satisfy its health check. This header is a local startup check, not authentication (`src/server/http-server.ts`, `src/config.ts`, `scripts/start.ts`).
- Exact `/mcp` is the only MCP endpoint; a regex route keeps `/mcp/` distinct because the MCP Express factory initializes Express routing before application code can enable strict routing. `app.all` forwards the MCP methods to the SDK handler, which owns the protocol-specific method semantics. Direct localhost clients remain unauthenticated. Trusted tunnel traffic is marked by ngrok; on marked `tools/call` requests Shellby MCP requires `X-OpenAI-Subject`, binds the first subject before dispatch, and requires that subject thereafter. The tool does not need to exist or succeed for the first call to bind (`src/server/http-server.ts`, `src/auth/store.ts`).
- Shellby uses no MCP OAuth or per-tool security schemes; redundant `noauth` metadata is omitted. Remote authorization remains at the HTTP/deployment boundary (`src/server/http-server.ts`, `src/mcp/server-factory.ts`).

The MCP Express Host/Origin guards protect the localhost HTTP listener from DNS-rebinding/browser-origin attacks; they are not caller authentication. The ngrok policy remains the remote trust boundary: it rejects traffic outside ngrok's `com.openai.chatgpt` IP category, exposes only exact `/mcp`, rewrites Host to `localhost` independently of the configured upstream port, and adds `X-Shellby-Remote: 1`. Shellby MCP uses that marker only to distinguish already-origin-verified tunnel traffic from direct localhost clients (`ngrok-traffic-policy.yml`, `src/server/http-server.ts`).

## Local Dashboard Boundary

When `ui.enabled` creates an `AgentObserver`, `src/agent/dashboard-routes.ts` registers static `ui/dist` under `/ui`, a snapshot at `/ui/api/agents`, SSE at `/ui/api/events`, and steering endpoints on the same Express app. These routes share the localhost Host/Origin guards but do not use ChatGPT subject binding. The checked-in ngrok policy exposes only `/mcp`, so the dashboard stays local.

Observation starts at the tool-registration boundary after the startup gate. Steering is queued by agent identity and appended to a returning tool result; it cannot interrupt upstream model generation or a tool that has not returned. Observer history and queued instructions disappear on restart. Frontend contracts and presentation state live in the [UI wiki](../../ui/wiki/index.md).

## ChatGPT Identity Metadata

OpenAI documents three opaque client-provided identifiers on MCP tool calls: `openai/subject` is an anonymized user ID for rate limiting and identification, `openai/session` is an anonymized conversation ID for correlating calls within one ChatGPT session, and `openai/organization` is an anonymized organization ID when available. Live ChatGPT traffic observed on 2026-08-09 also carried `X-OpenAI-Subject` and `X-OpenAI-Session` as HTTP headers; organization was observed in MCP `_meta`, not as an HTTP header. Across multiple conversations, subject remained stable while session changed.

Shellby MCP uses `X-OpenAI-Subject` as the remote owner identifier and `X-OpenAI-Session` as conversation-scoped operational context (`src/server/http-server.ts`, `src/auth/store.ts`). Session context scopes completion notices, audit activity, and the process-local `start_here` initialization gate and durable delegated-conversation lookup. It is never authorization state and remains unsuitable for durable user binding. OpenAI marks `openai/userAgent` and `openai/userLocation` as best-effort hints that must not be relied on for authorization.

Each MCP request may carry `X-OpenAI-Session`, which Shellby treats as the opaque identity of the ChatGPT conversation making that request. Successful `start_here` sets `AgentIdentity.taskSlug`; the shared tool-registration boundary rejects other tool handlers while that field is absent. There is no separate initialized-session set. Sessions without the header are not startup-gated. Shellby does not infer relationships between sessions or classify a caller as a browser subagent. Audit output maps distinct raw session values to readable `agent-N` aliases (`src/agent/context.ts`, `src/server/http-server.ts`, `src/mcp/tool-registration-boundary.ts`, `src/server/audit/audit-log.ts`).

## Connection Model

Production composition binds the process-level capability services into one `McpServerFactory` in `src/mcp/server-factory.ts`. HTTP receives that factory plus transport-owned auth/audit state and, when enabled, the single process-level `AgentObserver`. The same observer instance is registered for dashboard routes and passed to each short-lived MCP server for tool observation and steering delivery. `createMcpHandler(factory)` asks the bound factory for a fresh `McpServer` per serving unit; the handler owns request classification, modern per-request serving, response streaming, and MCP-server teardown (`src/server/http-server.ts`, `src/mcp/server-factory.ts`).

The endpoint is dual-era by construction. Modern clients negotiate MCP `2026-07-28` through `server/discover` and then send the per-request protocol envelope. The handler's default `legacy: "stateless"` leg continues to serve 2025-era clients from the same server factory, so tool registration cannot drift between protocol eras. Shellby's integration clients use `versionNegotiation: { mode: "auto" }` and assert the modern era; a dedicated compatibility test pins the legacy path (`src/server/http-server.ts`, `test/integrations/helpers.ts`, `test/integrations/http-transport.ts`).

Production also injects the repository-local MCP audit logger at this boundary. Its storage, truncation, token-accounting, and sensitivity rules are canonical in [Audit Logging](./operations/audit-logging.md).

Because neither the modern 2026 serving model nor Shellby's legacy stateless fallback retains an MCP HTTP session ID, an existing client can send its next request after the server is rebuilt and restarted on the same URL without reconnecting. The bound owner survives in `<state_dir>/auth.json` (default `~/.shellby/auth.json`); process-local shell, webpage-cache, and `start_here` state reset, so a ChatGPT conversation must initialize again after process restart. ChatGPT needs an app refresh when advertised tool metadata or server instructions change (`src/auth/store.ts`, `src/server/http-server.ts`).

The shared `McpHttpHandler` tracks modern in-flight exchanges and closes with the Node HTTP server. Process-level shell, Peekaboo, subagent, and cursor-host services are owned and disposed separately by the production composition root (`src/server/http-server.ts`, `src/index.ts`).

Integration tests prove modern `2026-07-28` negotiation and MCP surface behavior in `test/integrations/mcp-runtime.ts`; `test/integrations/http-transport.ts` covers legacy 2025 fallback, continued client use after a stop/start on the same port, and HTTP 403 for an attacker-controlled Host.

## Related

- [Project Overview](./project-overview.md)
- [Architecture Map](./architecture-map.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Open Questions and Risks](./project/open-questions-and-risks.md)
- [Audit Logging](./operations/audit-logging.md)
