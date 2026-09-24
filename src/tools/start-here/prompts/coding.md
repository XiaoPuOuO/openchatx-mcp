# OpenChatX engineering guidance

Build the requested behavior so another developer can understand, change, and debug it without reconstructing hidden assumptions.

## Design priorities

- Keep conceptual changes local. If one behavior requires coordinated edits across many unrelated modules, first look for the missing owner or boundary.
- Minimize cognitive load. Prefer a small number of clear concepts over many switches, wrappers, modes, and compatibility branches.
- Make dependencies visible. Configuration, state ownership, side effects, and failure behavior should be discoverable from the module that owns them.
- Prefer canonical representations. Avoid keeping multiple fields or states that can disagree when one value can be derived from another.
- Keep common paths simple. Optional controls should not make routine use harder.

## Ownership and boundaries

- Every protocol rule, persisted format, capability registry, error contract, and lifecycle invariant should have one clear owner.
- Add abstractions when they hide meaningful complexity, enforce an invariant, or reduce repeated knowledge. Do not add pass-through wrappers or naming-only layers.
- Keep cohesive behavior together. Split code when the extracted unit has a clear contract and can be understood independently.
- At trust boundaries, validate external input once and convert it into an internal representation the rest of the system can trust.
- Treat failures as part of the API. Use stable error codes for caller-visible failures and preserve internal causes for diagnostics.

## OpenChatX-specific architecture

- ChatGPT is the primary planner. Local tools, external MCP servers, toolboxes, and provider-backed subagents are capabilities behind OpenChatX.
- Keep the direct MCP tool surface small. Expose capability summaries eagerly and discover large/custom tool surfaces lazily through `tool_search` and `tool_call`.
- Do not duplicate external MCP schemas into the main tool list merely for discoverability.
- Do not add compatibility behavior for removed Shellby subsystems unless the user explicitly requests migration support.
- `bash` is a fresh non-interactive command execution tool. Do not recreate persistent shell polling or streamed shell-result protocols.
- `terminal` owns interactive PTY sessions. Use it only for programs that genuinely require interaction.

## Understand the codebase first

- Inspect the affected implementation, representative callers, tests, configuration, and nearby contracts before editing.
- Use repository evidence instead of assumptions. Check library or protocol behavior when it can be verified cheaply.
- Preserve unrelated user changes in a dirty worktree.

## File operations

Treat the dedicated file tools as the normal editing workflow, not `apply_patch`.

- Before changing any existing text file, you must read the relevant current contents with `file_read`, unless those exact contents were already returned by a recent tool call in this conversation.
- Use `file_edit` as the default way to modify an existing text file. It performs an exact oldString/newString replacement and returns a diff. Copy `oldString` from the current `file_read` output and preserve exact whitespace; if the match is not unique, read more surrounding context and retry with a unique match.
- Use `file_write` when creating a new text file or intentionally replacing essentially the whole file. If the target already exists, read it with `file_read` first. It overwrites the file and returns a diff.
- Use `apply_patch` only when that tool is available and a patch is the clearest representation: coordinated multi-file changes, moves/deletions, or applying a patch supplied by the user. On hosts where `apply_patch` is unavailable, use `file_edit` / `file_write` instead. Do not choose it merely because code is being edited.
- Prefer several clear `file_edit` calls over manufacturing a patch for unrelated localized edits.
- Use `bash` for commands, builds, tests, package managers, and operations that are genuinely shell tasks. Do not use `bash`, `sed`, `cat`, shell redirection, or Python as substitutes for `file_read`, `file_edit`, or `file_write`.

## Implementation rules

- Make the smallest coherent change that fully satisfies the request. Broad requests may require broad edits.
- Prefer direct code over speculative frameworks.
- Avoid defensive branches for impossible internal states; enforce invariants where state enters or changes.
- Do not preserve obsolete architecture solely because tests still reference it. Update or remove tests when the product contract changes.
- Keep schema cost in mind for every model-facing tool. A tool contract should be explicit, compact, and OpenAI-compatible.

## Validation

- Add or update regression tests for changed contracts.
- Validate model-facing MCP schemas, not only TypeScript types.
- Run targeted checks while iterating; before finishing a substantial platform change, run typecheck, lint, build, and the relevant test suite.
- Before declaring completion, verify that the final public behavior matches the current OpenChatX architecture rather than legacy Shellby behavior.

## Subagents

- Use subagents for bounded, independent work that benefits from parallel investigation or specialization.
- Keep architecture, integration decisions, overlapping edits, and final judgment with the primary agent.
