---
summary: "Caller-facing apply_patch grammar, execution model, partial-failure behavior, result summaries, limits, and tested semantics."
paths:
  - src/tools/apply-patch/apply-patch.ts
  - src/tools/apply-patch/patch-summary.ts
  - test/apply-patch-vendor.test.ts
  - test/integrations/apply-patch.ts
---

# `apply_patch`

## What This Is

Canonical behavior notes for the first-class `apply_patch` MCP tool and vendored Codex patch binary.

## Runtime

- MCP tool. No shell ID, request ID, polling, or shell lock.
- Requires absolute `cwd`; the wrapper rejects a missing path or non-directory before spawning the binary. Patch text goes to native stdin (`src/tools/apply-patch/apply-patch.ts`).
- The child receives `CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS=1`, preserving the vendored binary's line-ending behavior expected by Shellby (`src/tools/apply-patch/apply-patch.ts`).
- Binary: `vendor/apply-patch/apply_patch`, macOS Universal 2, built from pinned Codex source (`vendor/apply-patch/provenance.json`, `scripts/vendor/build-apply-patch.sh`).
- Failure stdout+stderr share a hard 1,024 `o200k_base` token cap. Extra diagnostic text is dropped.
- Abort: detached POSIX process group, `SIGTERM`, 500 ms, `SIGKILL`, then one more bounded grace before forced settlement. Shared platform-specific group signaling and TERM-to-KILL escalation live in `src/child-process-termination.ts`; apply-patch keeps its own forced-settlement/error semantics (`src/tools/apply-patch/apply-patch.ts`).

## Supported Patch Surface

Envelope:

```text
*** Begin Patch
...
*** End Patch
```

File sections:

```text
*** Add File: path
+new line

*** Update File: path
*** Move to: new/path
@@ unique context
 old context
-old line
+new line
*** End of File

*** Delete File: path
```

Facts:

- One patch may mix add/update/delete and contain many file sections.
- One update may contain many hunks.
- `*** Move to:` is an `Update File` modifier. Rename+edit works. Pure rename also works with a context-only update.
- `@@ <context>` scopes search to a unique class/function/section/line. Bare `@@` starts an ordinary hunk.
- `*** End of File` targets the file tail.
- Update hunk body lines start with space, `-`, or `+`.
- Add/move can create destination parent directories.

Treat the explicit surface above as the contract. Do not advertise parser tolerance as syntax.

## Execution Semantics

Verified against the vendored binary:

- File sections run in order.
- Native execution stops at the first failing file section.
- Successful earlier sections stay applied.
- Later sections are not attempted.
- Whole patch is therefore not atomic.
- One `Update File` section is atomic across its hunks: if a later hunk fails, earlier hunks from that same update do not remain applied.
- Native diagnostics report the first failure only; no multi-error collection.

Example:

```text
a.txt  succeeds  -> changed
b.txt  hunk 2 fails -> unchanged
c.txt  not reached -> unchanged
```

## Results

Statuses:

- `completed`: native exit 0.
- `failed`: failure with no confidently inferred prior changes.
- `partial`: one or more earlier sections completed before a recognized later failure.

Native failure and partial results are MCP errors (`isError: true`). Compact model-facing form:

```text
status=partial exit_code=1

changed:
src/foo.ts +14 -3
src/dead.ts deleted
src/old.ts -> src/new.ts +4 -2

failed:
src/bar.ts hunk 2

output:

Failed to find expected lines ...
```

Change forms:

- add: `path +N`
- update: `path +N -M`
- delete: `path deleted`
- move: `old -> new`
- move+edit: `old -> new +N -M`

`+N/-M` come from patch lines, not a post-write filesystem diff. `src/tools/apply-patch/patch-summary.ts` owns Shellby's interpretation of patch sections plus the vendored binary's ordered first-failure diagnostics. On success it summarizes all sections; on recognized failure it summarizes sections before the failed section. The process wrapper does not reread files before/after.

Failure mapping is conservative. It matches the first native diagnostic line to the longest patch path, then identifies update context/hunk from the diagnostic when possible. If the failure cannot be mapped, it does not claim prior changes. `output_dropped: true` means the native diagnostic exceeded the 1,024-token cap (`src/tools/apply-patch/patch-summary.ts`, `src/tools/apply-patch/apply-patch.ts`).

## Native Quirks / Boundaries

- Patch-internal paths are not sandboxed. Native parser accepts absolute paths, so `cwd` is not a filesystem boundary.
- `*** Add File` can overwrite an existing path.
- Destination directories may be created automatically.
- Parser has undocumented tolerance for some omitted anchors and whitespace/Unicode drift. Do not depend on it.
- Consecutive `@@` anchors fail even though older/copied Codex prompt material described nested anchors.

These are implementation observations, not model-facing promises.

## Diagnostics

Common native failures name the failing path and expected text/context, for example missing expected lines, missing delete target, or missing context. Wrapper/startup failures without structured native output return `apply_patch_failed: ...` text.

Audit retention for successful and failed patches is canonical in [Audit Logging](../operations/audit-logging.md).

## Tests

Validation ownership and current coverage are documented in [Build and Test](../operations/build-and-test.md). The focused sources are `test/apply-patch-vendor.test.ts` and `test/integrations/apply-patch.ts`.

## Related

- [MCP Tool Surface](../mcp-tool-surface.md)
- [State and Skills](../state-and-skills.md)
- [Build and Test](../operations/build-and-test.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
- [Audit Logging](../operations/audit-logging.md)
