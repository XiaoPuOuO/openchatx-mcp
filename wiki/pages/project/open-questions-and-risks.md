---
summary: "Current trust, resource, external-integration, persistence, and intentionally unenforced maintenance risks."
paths:
  - src/
  - ngrok-traffic-policy.yml
---

# Open Questions and Risks

## What This Is

This page is the maintenance lint target for current trust, resource, external-integration, and intentionally unenforced boundaries.

## Active Risks

- **Remote trust depends on the deployment boundary:** replacing or weakening the checked-in ngrok origin policy can accidentally turn traffic that should be remote-authenticated into effectively local traffic. Preserve an equivalent trusted-origin marker contract; see [HTTP Transport](../http-transport.md).
- **Local MCP remains intentionally unauthenticated:** exposing the localhost listener through a different proxy changes the threat model. Exact routing and ownership behavior are canonical in [HTTP Transport](../http-transport.md).
- **Authenticated browser delegation:** `subagent_run` can act through the ChatGPT account already authenticated in the configured debuggable Chrome instance. The MCP trust boundary therefore includes that browser session. The subagent runtime service remains attach-only, while the public setup/start helpers may launch the dedicated `~/.shellby/chatgpt-chrome` profile (`src/tools/subagent/subagent-tools.ts`, `src/tools/subagent/chatgpt-subagent.ts`, `scripts/chatgpt-browser.mjs`).
- **Caller-selected shell boundaries are not per-user ACLs:** remote ChatGPT is single-owner by default, but local MCP clients share the same named-shell namespace. Any authorized/local caller that knows or guesses another `shell_id` can access or reset that shell, and all shells retain the same operating-system permissions (`src/auth/auth.ts`, `src/tools/shell/shell-tools.ts`, `src/tools/shell/session-manager.ts`).
- **Child-process resource use is not sandboxed:** shell capacity, hibernation, and batch limits bound orchestration but do not prevent an active local-user process from consuming arbitrary CPU or memory. Caller consequences are in [`shell_run` / `shell_poll`](../tools/shell-run.md); implementation mechanics are in [Persistent Shell Runtime](../persistent-shell-runtime.md).
- **URL fetching is open-world:** `fetch_url` can navigate to HTTP or HTTPS resources reachable from the host, including local or private-network services. Text-like cached documents are count-, TTL-, and byte-bounded; raw non-HTML bodies also have a separate byte ceiling, but concurrent browser renders and resource parses can still cause temporary CPU or memory spikes (`src/config.ts`, `src/tools/web/web-tool.ts`, `src/tools/web/web-open.ts`).
- **Best-effort descendant cleanup:** process-group signaling errors are swallowed to keep the server alive. A process the local user cannot signal may outlive reset or shutdown (`src/tools/shell/shell-process.ts`).
- **Rolling-output loss:** some shell output can become permanently unrecoverable after retention/capture limits are exceeded. The exact caller-visible distinction between truncation and loss is canonical in [`shell_run` / `shell_poll`](../tools/shell-run.md).
- **`apply_patch` paths are not sandboxed:** patching retains the local user's filesystem authority. Exact path/parser behavior is canonical in [apply_patch](../tools/apply-patch.md).
- **MCP audit logging can disclose values:** `agent-commands.yaml` can contain sensitive tool inputs even though it is gitignored, permission-restricted, and bounded. Treat the whole file as sensitive; see [Audit Logging](../operations/audit-logging.md) and [Secret Handling](../operations/secret-handling.md).
- **Subagent persistence contains private identifiers:** `~/.shellby/subagents.sqlite` stores parent MCP session IDs, ChatGPT conversation URLs, and turn counts. The store currently relies on ordinary SQLite/filesystem creation permissions rather than explicitly enforcing `0600` like the auth and audit stores (`src/tools/subagent/subagent-store.ts`, `src/auth/auth.ts`, `src/server/audit/audit-log.ts`).
- **Peekaboo and permission drift:** focused Computer Use forces local CLI execution with `--no-remote`, removing daemon/Bridge selection from that path. Shellby vendors the tested Peekaboo CLI and cursor host so production cannot drift to another executable version, but macOS permission behavior can still vary with launch context. Calls surface semantic failures and are not automatically retried (`vendor/peekaboo/`, `src/server/http-server.ts`, `src/tools/computer/peekaboo.ts`, `src/tools/computer/cursor-host.ts`).
- **Ephemeral observation targets:** screenshot IDs and their capture-target mappings live only in process memory, are capped at 64, and disappear on restart or eviction. Coordinate actions fail closed when the mapping is unavailable, so callers must observe again (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`).
- **Coordinate interpretation:** screen captures require display-origin translation, while app/window clicks use screenshot-relative coordinates with an explicit capture target. Multi-display layout or upstream bounds changes are important real-CLI regression cases (`src/tools/computer/peekaboo.ts`, `src/tools/computer/computer-tools.ts`, `test/peekaboo.test.ts`).

## Intentional Unenforced Conventions

- The workspace location is prompt guidance and an initial cwd, not a filesystem boundary (`src/index.ts`, `src/server/mcp-server.ts`).

`README.md` is the concise public entry point; the maintained wiki remains the detailed maintainer source. Update implementation truth in the relevant maintained page first and mirror only user-relevant setup or capability changes into the README. Raw host-capability surveys are point-in-time evidence, not a roadmap.

## Related

- [Project Overview](../project-overview.md)
- [Architecture Map](../architecture-map.md)
- [HTTP Transport](../http-transport.md)
- [Configuration and Startup](../operations/configuration-and-startup.md)
- [Computer Use](../computer-use.md)
- [Build and Test](../operations/build-and-test.md)
- [Roadmap](./roadmap.md)
- [Audit Logging](../operations/audit-logging.md)
- [apply_patch](../tools/apply-patch.md)
