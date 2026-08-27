---
summary: "Local HTTP/MCP routing, ngrok trust boundary, remote owner binding, request lifetime, and shared process state."
paths:
  - src/server/http-server.ts
  - src/auth/
  - ngrok-traffic-policy.yml
---

# HTTP Transport

## What This Is

This page documents the local HTTP/MCP boundary, trusted remote path, subject binding, and request lifetime.

## Routes and Middleware

- `createMcpExpressApp({ host, jsonLimit: "1mb" })` creates the Express app and applies the MCP v2 adapter's JSON parsing plus localhost Host/Origin guards. No custom `allowedOrigins` list is configured (`src/server/http-server.ts`).
- `GET /healthz` returns `{ "ok": true }` (`src/server/http-server.ts`).
- Exact `POST /mcp` is the only MCP endpoint; a regex route keeps `/mcp/` distinct because the MCP Express factory initializes Express routing before application code can enable strict routing. Direct localhost clients remain unauthenticated. Trusted tunnel traffic is marked by ngrok; on marked `tools/call` requests Shellby MCP requires `X-OpenAI-Subject`, binds the first subject before dispatch, and requires that subject thereafter. The tool does not need to exist or succeed for the first call to bind (`src/server/http-server.ts`, `src/auth/auth.ts`).
- `GET` and `DELETE /mcp` return a JSON-RPC-shaped 405 response with `Allow: POST` (`src/server/http-server.ts`).
- Tool metadata continues to declare `noauth` because Shellby MCP does not use MCP OAuth or per-tool security schemes; remote authorization is enforced at the HTTP/deployment boundary (`src/tools/shell/shell-tools.ts`, `src/tools/computer/computer-tools.ts`, `src/server/http-server.ts`).

The MCP Express Host/Origin guards protect the localhost HTTP listener from DNS-rebinding/browser-origin attacks; they are not caller authentication. The ngrok policy remains the remote trust boundary: it rejects traffic outside ngrok's `com.openai.chatgpt` IP category, exposes only exact `/mcp`, rewrites Host to `localhost:3333`, and adds `X-Shellby-Remote: 1`. Shellby MCP uses that marker only to distinguish already-origin-verified tunnel traffic from direct localhost clients (`ngrok-traffic-policy.yml`, `src/server/http-server.ts`).

## ChatGPT Identity Metadata

OpenAI documents three opaque client-provided identifiers on MCP tool calls: `openai/subject` is an anonymized user ID for rate limiting and identification, `openai/session` is an anonymized conversation ID for correlating calls within one ChatGPT session, and `openai/organization` is an anonymized organization ID when available. Live ChatGPT traffic observed on 2026-08-09 also carried `X-OpenAI-Subject` and `X-OpenAI-Session` as HTTP headers; organization was observed in MCP `_meta`, not as an HTTP header. Across multiple conversations, subject remained stable while session changed.

Shellby MCP uses `X-OpenAI-Subject` as the remote owner identifier and `X-OpenAI-Session` as best-effort conversation-scoped operational context (`src/server/http-server.ts`, `src/auth/auth.ts`). Session context scopes completion notices and audit activity; it is never authorization state and remains unsuitable for durable user binding. OpenAI marks `openai/userAgent` and `openai/userLocation` as best-effort hints that must not be relied on for authorization.

Each MCP request may carry `X-OpenAI-Session`, which Shellby treats as the opaque identity of the ChatGPT conversation making that request. Shellby does not infer relationships between sessions or classify a caller as a browser subagent. Audit output maps distinct raw session values to readable `agent-N` aliases (`src/server/http-server.ts`, `src/server/audit-log.ts`).

## Connection Model

Every accepted POST creates a new v2 `McpServer` and `NodeStreamableHTTPServerTransport` with no session ID generator. The response's `finish` or `close` event closes that request's transport/server, while all requests share the process-level `ShellSessionManager`, `WebPageOpener`, `PeekabooClient`, `ChatGptSubagentService`, and production `ShellbyAuthStore`. The HTTP boundary creates default services or accepts explicit instances for production-specific behavior and tests (`src/server/http-server.ts`, `src/index.ts`).

Production also injects the repository-local MCP audit logger at this boundary. Its storage, truncation, token-accounting, and sensitivity rules are canonical in [Audit Logging](./operations/audit-logging.md).

Because no MCP session ID is retained by the HTTP layer, an existing client can send its next request after the server is rebuilt and restarted on the same URL without reconnecting. The bound owner survives because it lives outside the repository in `~/.shellby/auth.json`; process-local shell and webpage-cache state still reset. ChatGPT needs an app refresh when advertised tool metadata or server instructions change (`src/auth/auth.ts`, `src/server/http-server.ts`).

In-flight request closers are tracked so startup failure and server shutdown can settle them before closing the shell. HTTP shutdown begins before shell shutdown (`src/server/http-server.ts`, `src/index.ts`).

Integration tests prove state sharing across SDK clients, continued client use after a stop/start on the same port, and HTTP 403 for an attacker-controlled Host (`test/mcp-integration.test.ts`).

## Related

- [Project Overview](./project-overview.md)
- [Architecture Map](./architecture-map.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Open Questions and Risks](./project/open-questions-and-risks.md)
- [Audit Logging](./operations/audit-logging.md)
