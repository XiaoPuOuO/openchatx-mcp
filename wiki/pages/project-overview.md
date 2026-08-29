---
summary: "Concise orientation to Shellby MCP's purpose, audience, project boundaries, current status, and deeper maintainer knowledge."
paths:
  - README.md
  - package.json
  - src/index.ts
---

# Project Overview

## What This Is

Shellby MCP is a macOS local Agent harness that lets ChatGPT Web operate a developer's computer through persistent shells, direct file editing, webpage retrieval, focused Computer Use, dynamic skills, and browser-backed parallel agents while runtime state and tool execution remain on the local machine. In short: Gives ChatGPT complete control of the connected mac.

## Who It Serves and Why

The project is for software engineers who want ChatGPT Web to perform sustained repository work with local state. It deliberately exposes the current macOS user's authority and is not intended as a sandbox, hosted multi-user service, or non-technical consumer application.

The current release supports macOS arm64 and Intel x64 with Node.js 22.13.0 or newer. The repository is the distribution and maintenance boundary (`package.json`, `.github/workflows/ci.yml`).

## Project-Wide Boundaries

- The product is a local MCP harness, not a hosted relay or multi-user service. Remote transport and ownership are documented in [HTTP Transport](./http-transport.md).
- Setup and managed process lifecycle live in [Configuration and Startup](./operations/configuration-and-startup.md); published capabilities live in [MCP Tool Surface](./mcp-tool-surface.md); component boundaries live in [Architecture Map](./architecture-map.md).
- Roadmap and evaluation pages are explicitly noncommittal. The implemented iOS bridge remains unregistered (`src/tools/ios/ios-shell.ts`, `src/server/mcp-server.ts`).

## Current Status

The core local runtime, managed startup, remote ownership boundary, tool surface, macOS CI, and browser-agent lifecycle are implemented. Drift-prone external boundaries are tracked in [Open Questions and Risks](./project/open-questions-and-risks.md).

## Related

- [Architecture Map](./architecture-map.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Build and Test](./operations/build-and-test.md)
- [Open Questions and Risks](./project/open-questions-and-risks.md)
- [Roadmap](./project/roadmap.md)
