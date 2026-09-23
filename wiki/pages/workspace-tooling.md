---
summary: "Default coding workspace behavior and the dynamic reusable-skill catalog exposed through skill_list and skill_load."
paths:
  - src/tools/skills/skill-tools.ts
  - src/tools/skills/skill-catalog.ts
  - src/agent/load-deduper.ts
  - src/config.ts
  - src/public-config.cts
  - src/tools/start-here/
  - scripts/workspace-setup.ts
  - scripts/start.ts
  - skills/create-skill/SKILL.md
  - test/tools/skills/skill-catalog.test.ts
  - test/setup-workspace.test.ts
---

# Workspace Tooling

## What This Is

This page documents the configured coding workspace and dynamic skill catalog.

## Default Workspace

`.shellby/config.toml` supplies `MCP_CONFIG.workspace`; the setup-generated active value is `~/Desktop/agent-workspace`. `src/config.ts` expands `~` and resolves relative paths from the repository root; the resolved workspace becomes the initial shell cwd and workspace-relative tool root. `npm run setup -- --config-only` creates the complete repo-local config only when missing and otherwise preserves the file. Missing fields default at load time. Full `npm run setup` uses the same create-only path before loading runtime configuration, then creates the workspace recursively, creates a starter `AGENTS.md` only when absent, and copies the repository's `create-skill` starter into `<workspace>/skills/create-skill/SKILL.md` only when absent. Re-running setup preserves customized values, instructions, and starter skill files. Managed `npm start` requires the config and workspace to already exist and directs missing-config/workspace callers to run setup; `src/index.ts` assumes that bootstrap has already happened. This is a convention, not a sandbox (`src/config.ts`, `src/index.ts`, `scripts/setup.ts`, `scripts/start.ts`, `scripts/workspace-setup.ts`, `skills/create-skill/SKILL.md`, `test/setup-workspace.test.ts`).

## Workspace Skills

Reusable agent workflows live under `<workspace>/skills/<name>/SKILL.md`. `src/tools/skills/skill-catalog.ts` owns filesystem discovery, name validation, frontmatter descriptions, symlink-compatible lookup, and the byte ceiling. `src/tools/skills/skill-tools.ts` is the MCP adapter: `skill_list` scans through the catalog and `skill_load` returns complete instructions plus the local `SKILL.md` path. The catalog validates names at its own boundary, so direct callers do not depend on MCP-schema validation for path safety.

Repeated loads of the same skill by the same `AgentIdentity` within five seconds reuse the pending load and return a short reuse notice; failed loads remain retryable. `src/agent/load-deduper.ts` owns this per-agent load pattern and is also used by `start_here`. Callers without session identity are not deduplicated. Skills are dynamic data rather than MCP schema entries, so adding or removing a skill does not require rebuilding the server (`src/tools/skills/skill-catalog.ts`, `src/tools/skills/skill-tools.ts`, `src/agent/load-deduper.ts`, `src/mcp/server-factory.ts`).

The maintainer workspace catalog is intentionally not enumerated here because it is dynamic and can change without a Shellby rebuild. Directory symlinks are supported, so selected shared skills can stay single-sourced while still appearing under `<workspace>/skills` (`src/tools/skills/skill-catalog.ts`, `test/tools/skills/skill-catalog.test.ts`).

Skill names may begin with an alphanumeric character or underscore and may otherwise contain letters, numbers, dots, underscores, and hyphens. A leading underscore can be used for workspace-local skills such as `_web-search`. The restricted character set prevents path traversal while still allowing a named workspace entry to be a symlink. `SKILL.md` is capped at 256 KiB; broken or oversized entries are omitted from `skill_list`, while direct `skill_load` calls return explicit errors (`src/tools/skills/skill-catalog.ts`, `src/tools/skills/skill-tools.ts`, `test/tools/skills/skill-catalog.test.ts`).

## Skill Bootstrap Boundary

`skills/create-skill/SKILL.md` is repository-owned bootstrap source, while `<workspace>/skills/create-skill/SKILL.md` becomes workspace-owned state after the first setup copy. Runtime discovery scans only `<workspace>/skills`; repository-level skill files do not enter `skill_list` or `skill_load` unless setup or another explicit mechanism places them there (`scripts/workspace-setup.ts`, `skills/create-skill/SKILL.md`, `src/tools/skills/skill-catalog.ts`).

## Related

- [Project Overview](./project-overview.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Persistent Shell Runtime](./persistent-shell-runtime.md)
- [apply_patch](./tools/apply-patch.md)
