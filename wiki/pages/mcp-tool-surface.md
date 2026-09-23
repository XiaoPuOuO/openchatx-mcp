---
summary: "MCP registration, startup prompt loading, result projection, and routing to capability contracts."
paths:
  - src/config.ts
  - src/public-config.cts
  - src/mcp/server-factory.ts
  - src/mcp/tool-registration-boundary.ts
  - src/mcp/tool-schema-presentation.ts
  - src/mcp/tool-output.ts
  - src/tools/file/
  - src/tools/start-here/
  - src/tools/review/
---

# MCP Tool Surface

## Registration and Runtime Ownership

`src/mcp/server-factory.ts` owns registration order, enabled tool groups, and the process-level `McpServerFactory` that binds capability services once. Factory construction snapshots an immutable MCP runtime profile containing advertised server identity, enabled tool groups, and tool-output mode from `MCP_CONFIG`; later process-global mutations cannot change that bound factory. Tests may supply profile overrides without changing model-facing schemas or production capability internals. `start_here` is always published. Services required by an enabled group must already exist or composition fails. `src/index.ts` creates shared services once, while HTTP serving asks the bound factory for short-lived MCP server instances. The HTTP layer does not need to know concrete shell, web, Peekaboo, or delegated-agent service types. See [Architecture Map](./architecture-map.md).

Tool schemas live beside handlers. Use `npm run schemas` to inspect the configured surface instead of maintaining a second tool inventory. Integration tests in `test/integrations/mcp-runtime.ts` cover full registration order and the minimal `start_here` surface. Disabled groups skip both registration and supporting runtime where applicable. Config changes require restart.

## Startup Instructions

`src/config.ts` provides minimal global routing instructions. For requests carrying `X-OpenAI-Session`, the registration boundary checks `AgentIdentity.taskSlug` before invoking ordinary handlers. A successful `start_here` sets that field; failed loading leaves the caller gated. Requests without session identity remain ungated.

`start_here` discovers modes from lowercase kebab-case Markdown filenames in bundled `src/tools/start-here/prompts/` and local `.shellby/prompts/`. `shared.md` is reserved. Local files override matching bundled names; additional local names add modes. Discovery happens each time the short-lived MCP server is registered, so subsequent `tools/list` requests can see added modes without a process restart. Clients caching schemas may still need an app refresh.

Prompt loading returns `shared.md` first, then the selected mode. Contents are read at call time. Repeated same-mode loads by the same agent within five seconds reuse the pending load and return a short reuse notice; errors remain retryable. The caller's nonempty `task_id` becomes audit/review task context; current validation does not require a kebab-case task ID. Startup does not interpolate the configured workspace or automatically read its `AGENTS.md` (`src/tools/start-here/start-here.ts`, `test/integrations/session-initialization.ts`).

## Result Boundary

`src/mcp/tool-schema-presentation.ts` owns model-facing JSON Schema projection, redundant annotation pruning, compact-output schema visibility, and native-content exceptions while preserving declared input fields. The SDK validates inputs and published output schemas. `src/mcp/tool-registration-boundary.ts` owns startup gating, result projection, audit/observer lifecycle, and post-call notices. [Tool Naming and Schema Design](./tool-naming-and-schema-design.md) owns rationale and projection caveats.

With `mcp.tool_output = "compact"`, ordinary tools omit public output schemas and render typed results through `src/mcp/tool-output.ts`. Structured mode preserves native structured results and output schemas. `computer_*`, `image_view`, and `file_read` preserve native MCP content in either mode. Compact nested records use readable blocks; unusual array shapes may use minified JSON. Multi-result text uses `---- metadata ----` separators.

After handler completion, the boundary appends file-edit guidance, queued delegated-turn events, human steering, and the optional review notice. Thrown handlers do not drain these notices. Audit receives the original result and final model projection directly; see [Audit Logging](./operations/audit-logging.md).

`submit_review` stores feedback in local `.shellby/reviews.jsonl`. Its process-local tracker asks once after sustained tool use by a session. Source `src/tools/review/review-tool.ts` owns threshold and rating schema; this feedback experiment is separate from authorization and runtime correctness.

Error results carrying an explicit `structuredContent.error_code` preserve that metadata in compact output.

## Capability Routes

| Area | Maintained context | Source entry |
| --- | --- | --- |
| Shell execution and lifecycle | [Shell contract](./tools/shell-run.md), [runtime](./persistent-shell-runtime.md) | `src/tools/shell/shell-tools.ts` |
| Patching | [apply_patch](./tools/apply-patch.md) | `src/tools/apply-patch/apply-patch.ts` |
| Browser delegation | [Subagents](./tools/subagent.md), [clones](./tools/clones.md) | `src/tools/delegation/` |
| Website and resource fetching | [fetch_url](./tools/fetch-url.md) | `src/tools/web/` |
| Workspace skills | [Workspace Tooling](./workspace-tooling.md) | `src/tools/skills/skill-tools.ts` |
| Computer interaction | [Computer Use](./computer-use.md) | `src/tools/computer/` |
| Local images | Shared Sharp encoder preserves dimensions, lowers JPEG quality to fit its byte budget, and fails rather than resizing. | `src/tools/image/` |
| File transfer | `file_read` returns local bytes as embedded MCP resource content; `file_write` consumes an OpenAI file input and writes its downloaded bytes to a local path. | `src/tools/file/file-tools.ts` |

## Related

- [HTTP Transport](./http-transport.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [Build and Test](./operations/build-and-test.md)
