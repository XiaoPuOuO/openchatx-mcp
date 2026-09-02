---
summary: "Focused Computer Use execution through Peekaboo, including snapshots, coordinates, background delivery, and cursor-host ownership."
paths:
  - src/tools/computer/
  - src/tools/image/image-encoding.ts
  - vendor/peekaboo/
---

# Computer Use

## What This Is

This page documents Shellby's focused `computer_*` execution path, Peekaboo ownership boundary, snapshot/target semantics, background input behavior, and coordinate rules (`src/tools/computer/computer-tools.ts`, `src/tools/computer/peekaboo.ts`, `src/tools/computer/cursor-host.ts`).

## Runtime Path

Focused Computer Use is `computer_*` -> one serialized `PeekabooClient` -> Shellby's bundled Peekaboo CLI. Production constructs the client in local-only mode, so focused tools append `--no-remote` and do not depend on Peekaboo's daemon. The package-local CLI in `vendor/peekaboo/peekaboo` is the only production executable, keeping the adapter and CLI version coupled (`src/config.ts`, `src/index.ts`, `src/tools/computer/peekaboo.ts`).

Raw Peekaboo commands through `shell_run` are outside this adapter and may use Peekaboo's daemon unless the caller supplies `--no-remote`.

Shellby also ships `vendor/peekaboo/peekaboo-cursor-host` beside the bundled Peekaboo executable. `CursorHostManager` starts it with the MCP, restarts it after unexpected exit, and terminates it during shutdown. If the executable is absent, Computer Use remains available without the cursor host (`src/config.ts`, `src/index.ts`, `src/tools/computer/cursor-host.ts`).

## Snapshots and Coordinates

`computer_observe` captures the target at its original dimensions and retains the resolved target metadata with the returned snapshot ID. Shellby does not resize screenshots, so screenshot coordinates remain in the capture's coordinate space. Exact-window coordinate actions use the retained window target and, where required, a fresh local Peekaboo snapshot receipt; screen coordinates are translated with retained display bounds (`src/tools/computer/computer-tools.ts`, `src/tools/computer/peekaboo.ts`, `src/tools/image/image-encoding.ts`).

When observation explicitly targets `PID:<pid>`, Shellby preserves that exact app selector in the retained snapshot target even if Peekaboo omits or normalizes the returned observation target. Follow-up actions therefore remain process-bound (`src/tools/computer/peekaboo.ts`, `test/peekaboo.test.ts`).

`computer_inspect` performs a fresh tree observation and returns a new snapshot ID. Element IDs from inspection belong to that returned snapshot and must not be paired with the older screenshot snapshot (`src/tools/computer/computer-tools.ts`).

Because Shellby deliberately does not resize captures or invent a second coordinate transform, upstream capture-scaling changes can surface directly as targeting errors. When targeting appears wrong, verify the configured Peekaboo binary's reported bounds and screenshot dimensions before changing Shellby coordinate logic (`src/tools/computer/peekaboo.ts`, `src/tools/image/image-encoding.ts`, `test/peekaboo.test.ts`).

## Background Delivery

- Exact-window clicks, long presses, coordinate scrolls, and coordinate-to-coordinate drags can use Shellby's local background path without moving the physical pointer where the tool schema permits it (`src/tools/computer/computer-tools.ts`, `src/tools/computer/peekaboo.ts`).
- `computer_drag` currently requires one exact observed window and coordinate-to-coordinate points; screen targets, element endpoints, app destinations, and modifiers are rejected for background dragging (`src/tools/computer/computer-tools.ts`).
- Targetless/app-only raw presses and hotkeys require explicit foreground delivery. Typing can target an app, exact window, or snapshot in the background. Pointer scrolling and smooth scrolling require explicit foreground delivery (`src/tools/computer/computer-tools.ts`).
- Stateful actions are not retried automatically. Re-observe after an ambiguous result before issuing another mutation.

## Related

- [MCP Tool Surface](./mcp-tool-surface.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [Architecture Map](./architecture-map.md)
- [Build and Test](./operations/build-and-test.md)
