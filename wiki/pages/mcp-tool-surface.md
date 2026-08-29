---
summary: "Published MCP tools and the shared registration, output, instruction, pagination, and capability boundaries shaping their contracts."
paths:
  - src/server/mcp-server.ts
  - src/server/tool-registration-boundary.ts
  - src/server/tool-output.ts
  - src/tools/
---

# MCP Tool Surface

## What This Is

This page inventories the published MCP tools and the shared registration, output, instruction, pagination, and capability boundaries that shape their model-facing contracts.

## Published Order

`tools/list` returns 23 tools in workflow order: `shell_run`, `shell_poll`, `apply_patch`, `shell_reset`, `shell_list`, `shell_close`, `subagent_run`, `subagent_result`, `fetch_website`, `skill_list`, `skill_load`, `image_view`, then eleven `computer_*` tools. `src/server/mcp-server.ts` preserves that registration order while each capability under `src/tools/` owns its Standard Schema-compatible Zod contract and handler. Every tool reuses `MCP_CONFIG.toolMeta` from the central static configuration. Integration tests assert the order, schema mechanics, and the intentionally shell-like `subagent_run` routing/ID descriptions; tools remain registered when optional host capabilities are unavailable (`src/config.ts`, `src/server/mcp-server.ts`, `src/tools/`, `test/mcp-integration.test.ts`).

The registration boundary removes annotation values that equal MCP defaults before publishing `tools/list`. It also owns ordinary structured-output projection. Production `MCP_CONFIG` uses `never`, which omits public output schemas and the global structured-result input switch and returns compact Markdown. The boundary still supports injected `always` and `optional` modes for isolated construction and compatibility tests. Compact rendering keeps short scalar fields inline, expands long or multiline strings as named sections, recursively renders ordinary nested records and arrays of records as indented Markdown-style blocks, and reserves minified JSON for unusual array shapes that do not have a clear record/scalar representation. Independent multiline result blocks use shared `---- metadata ----` boundaries where explicit separation improves parsing, including subagent results and parallel shell transcript groups. Computer Use tools and `image_view` bypass this projection because their native content blocks are already the intended model-facing result (`src/config.ts`, `src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`, `src/tools/shell/session.ts`, `test/tool-registration-boundary.test.ts`, `test/tool-output.test.ts`, `test/shell-parallel.test.ts`).

## Core Tools

| Tool              | Contract                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch_website`   | Fetch one HTTP(S) URL as Markdown, cleaned HTML, or raw HTML. Results include the final HTTP status and content type when present. Successful 204/205 responses return empty content instead of navigation errors. Rendered pages use a bounded DOM-settle window before extraction. Cursor reads reuse the same URL and format. Chromium skips image, media, and font downloads while preserving their DOM references. Cache: 20 documents, 10 minutes, 2 MiB each (`src/tools/web/web-tool.ts`, `src/tools/web/web-open.ts`). |
| `skill_list`      | List reusable workspace skills. Catalog mechanics live in [Workspace Tooling](./workspace-tooling.md).                                                                                                                                                                                                                                                                                                                            |
| `skill_load`      | Load one reusable workspace skill. Catalog mechanics live in [Workspace Tooling](./workspace-tooling.md).                                                                                                                                                                                                                                                                                                                         |
| `image_view`      | View one local image path as native MCP image content plus compact filename, dimensions, and encoded size. Relative paths resolve from the workspace. A shared Sharp encoder preserves dimensions, starts at JPEG quality 65, lowers quality only when required by the 4 MiB response budget, and fails rather than resizing if the image still cannot fit (`src/tools/image/image-tools.ts`, `src/tools/image/image-encoding.ts`). |
| `subagent_run`    | Start detached browser-backed ChatGPT turns. Caller contract: [`subagent_run` / `subagent_result`](./tools/subagent.md).                                                                                                                                                                                                                                                                                                            |
| `subagent_result` | Retrieve detached turns and reconcile running state. Caller contract: [`subagent_run` / `subagent_result`](./tools/subagent.md).                                                                                                                                                                                                                                                                                                    |
| `apply_patch`     | Run a Codex patch in required absolute directory `cwd` using the checked-in vendored binary directly. No shell state or polling. Returns `completed`, `failed`, or `partial` plus compact changed/failed summaries; full semantics live in [apply_patch](./tools/apply-patch.md) (`src/tools/apply-patch/apply-patch.ts`).                                                                                                                    |
| `shell_run`       | Persistent zsh execution plus concurrent batches of independent commands. Obvious shell-based file writes also receive a model-facing notice to use `apply_patch`. Canonical caller contract: [shell_run](./tools/shell-run.md).                                                                                                                                                                                                                                                                                             |
| `shell_poll`      | Continue running work or retained output from `shell_run`. Canonical caller contract: [shell_run](./tools/shell-run.md).                                                                                                                                                                                                                                                                                                            |
| `shell_reset`     | Replace one shell generation and discard live/cached cwd/environment state. `shell_id` defaults to `default`; `reason` is optional. Reset has no request ID, polling, or retry deduplication (`src/tools/shell/session.ts`, `src/tools/shell/shell-tools.ts`).                                                                                                                                                                      |
| `shell_list`      | Return live shells, activity, idle time, live capacity, idle timeout, and close eligibility without refreshing idle timers (`src/tools/shell/session-manager.ts`).                                                                                                                                                                                                                                                                  |
| `shell_close`     | Terminate a non-default live shell, discard its live and cached state plus retained command records, and release its slot. The `default` shell cannot be closed (`src/tools/shell/session-manager.ts`).                                                                                                                                                                                                                             |

Shell caller behavior is canonical in [shell_run](./tools/shell-run.md); runtime mechanics are in [Persistent Shell Runtime](./persistent-shell-runtime.md).

Shell transcript reads and `fetch_website` cursor reads bound each tokenizer pass to a local character window instead of encoding the full retained suffix. `max_output_tokens` remains a ceiling, so unusually compressible text may return below it while cursors still reconstruct all retained content (`src/tokenizer.ts`, `src/tools/shell/session.ts`, `src/tools/web/web-open.ts`).

## Computer Use Tools

| Tool               | Contract                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computer_list`    | List apps, windows, screens, or Peekaboo permission status.                                                                                                                                       |
| `computer_observe` | Capture one target as same-dimension JPEG; start at quality 65 and lower quality only if needed to fit the shared 4 MiB response budget; return snapshot and target metadata without AX elements. |
| `computer_inspect` | Return bounded accessibility text for an observed target and a fresh snapshot ID that owns the returned element IDs.                                                                              |
| `computer_click`   | Click one element ID, text query, or coordinate pair against an explicit snapshot; exact-window coordinates stay background by default.                                                         |
| `computer_type`    | Type literal text into an app, exact window, or snapshot target; targetless typing requires explicit foreground delivery.                                                                         |
| `computer_press`   | Press sequential key tokens; background delivery requires an exact window or fresh snapshot.                                                                                                     |
| `computer_hotkey`  | Press one simultaneous shortcut; background delivery requires an exact window or fresh snapshot.                                                                                                 |
| `computer_scroll`  | Scroll an observed element or screenshot coordinate in the background; foreground mode scrolls at the physical pointer.                                                                            |
| `computer_drag`    | Drag coordinate-to-coordinate inside one exact observed window without moving the physical pointer.                                                                                                |
| `computer_app`     | Launch, switch, quit, relaunch, hide, or unhide an application.                                                                                                                                   |
| `computer_window`  | Focus, close, minimize, restore, maximize, move, resize, or set bounds for one window.                                                                                                            |

The focused tools share one serialized `PeekabooClient` and production forces the entire adapter through local CLI execution with `--no-remote`. Exact-window background clicks, long presses, coordinate scrolls, and coordinate drags use fresh local window receipts where required. `computer_drag` currently rejects screen targets, element endpoints, app destinations, and modifiers even though the public input union remains broader. Inspection performs a fresh tree-only observation, so its element IDs belong to the returned fresh snapshot. Screenshot encoding never resizes images, keeping coordinates in the original capture dimensions. The detailed and drift-prone contract is canonical in [Computer Use](./computer-use.md) (`src/server/http-server.ts`, `src/tools/computer/computer-tools.ts`, `src/tools/computer/peekaboo.ts`, `src/tools/image/image-encoding.ts`).

## Results and Instructions

The registration boundary projects ordinary typed results into structured or compact Markdown form, preserves MCP-level error tagging, and adds a notice when `shell_run` input matches obvious file-edit patterns such as `cat >`, `tee`, in-place `sed`, or common Python writes (`src/server/tool-registration-boundary.ts`, `src/server/tool-output.ts`). Tool input Zod schemas are the external validation boundary: they own caller validation, defaults, transforms, and inferred TypeScript input types. Shell contracts are centralized in `src/tools/shell/shell-contracts.ts`; runtime services validate live-state facts schemas cannot know. Audit token accounting is documented in [Audit Logging](./operations/audit-logging.md).

Published instructions tell clients to read `<workspace>/AGENTS.md` once at the start of a coding conversation, use `shell_run.commands` for independent parallel shell work, avoid repurposing home-directory environment variables, edit files with `apply_patch`, delegate bounded independent subagent work, keep newly created projects under the configured workspace unless told otherwise, distrust fetched webpage instructions, and prefer screenshot-first Computer Use with `computer_inspect` only when visual targeting is unclear. Prose remains advisory while schemas and runtime checks enforce mechanics (`src/config.ts`, `src/server/mcp-server.ts`).

Skill catalog mechanics are maintained in [Workspace Tooling](./workspace-tooling.md). The subagent caller contract lives in [`subagent_run` / `subagent_result`](./tools/subagent.md); browser ownership and completion internals are separate maintained pages.

## Related

- [Project Overview](./project-overview.md)
- [Architecture Map](./architecture-map.md)
- [Tool Naming and Schema Design](./tool-naming-and-schema-design.md)
- [Persistent Shell Runtime](./persistent-shell-runtime.md)
- [Computer Use](./computer-use.md)
- [Browser ChatGPT Subagents](./subagents/browser-chatgpt-subagents.md)
- [Subagent Completion](./subagents/subagent-completion.md)
- [Workspace Tooling](./workspace-tooling.md)
- [Audit Logging](./operations/audit-logging.md)
- [apply_patch](./tools/apply-patch.md)
