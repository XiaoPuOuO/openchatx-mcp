# Wiki Context Log

Record only durable historical context that cannot be cheaply reconstructed from commit messages, diffs, the current repository/wiki, or preserved raw evidence. Most changes do not need an entry.

## 2026-08-04 — Static bearer authentication was tried and removed

Shellby briefly required a shared `MCP_AUTH_TOKEN`, then removed it after confirming the ChatGPT connector path did not fit a fixed custom bearer-token model. Remote ownership later converged on the ngrok origin boundary plus bound OpenAI subject metadata. Do not treat the removed shared-secret design as an unfinished requirement.

## 2026-08-07 — Browser-backed subagents established important UI constraints

Live validation showed that normal background Chrome works while headless Chrome encountered a Cloudflare challenge. Direct contenteditable filling also duplicated prompt text; page-targeted keyboard insertion followed by ChatGPT's Send action avoided that failure. The current browser submission path reflects those findings.

## 2026-08-15 — Direct conversation recovery fetch was abandoned

An authenticated page-context request to `/backend-api/conversation/<conversation_id>` returned `conversation_inaccessible`, so that direct-fetch recovery approach was dropped. Recovery later converged on observed ChatGPT-owned traffic and ultimately raw-CDP turn tracking with bounded catastrophic recovery. Avoid reintroducing the direct page-context fetch without fresh evidence that the private endpoint behavior changed.

## 2026-09-12 — Config upgrades preserve existing operator choices

Making a newly exposed setting required broke existing configurations. Public settings now resolve omitted defaults at load time and recover invalid values individually, so adding an option does not require a file migration. Setup leaves existing files intact to preserve comments and alternate TOML layouts. Whole-file fallback for malformed syntax was deliberately excluded: it could silently discard disabled tool groups or a reserved tunnel URL. Runtime, scaffold defaults, and PM2/ngrok must share the same interpretation.

## 2026-09-12 — Routine restart retains PM2; macOS recovery is explicit

Recreating PM2 on every restart broke restarts requested through Shellby's own shells: shutting down the daemon also killed the CLI responsible for bringing services back. The full reset was introduced for stale macOS permission/service context, which routine app reloads cannot repair. Keep routine restart inside the surviving PM2 daemon and reserve daemon recreation for `restart -- --hard` from a healthy external Terminal session. A disposable PM2 daemon confirmed that app reload completes after its requesting CLI is killed. The initiating tool call may disconnect; preserving that call does not justify detached workers or changes to tool behavior.
