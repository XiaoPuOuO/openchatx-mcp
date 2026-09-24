---
summary: "OpenChatX persistent state, default tool cwd behavior, AGENTS.md, and the dynamic reusable-skill catalog."
paths:
  - src/tools/skills/skill-tools.ts
  - src/tools/skills/skill-catalog.ts
  - src/agent/load-deduper.ts
  - src/config.ts
  - src/public-config.cts
  - src/tools/start-here/
  - scripts/state-setup.ts
  - scripts/start.ts
  - skills/create-skill/SKILL.md
  - test/tools/skills/skill-catalog.test.ts
  - test/state-setup.test.ts
---

# State and Skills

## What This Is

This page documents the persistent OpenChatX state directory, default tool cwd, AGENTS.md, and dynamic skill catalog.

## Persistent State and Default CWD

`.openchatx/config.toml` exposes `state_dir`, which defaults to `~/.openchatx-mcp`. Full `npm run setup` creates that directory, creates `<state_dir>/AGENTS.md` only when absent, and copies the repository's `create-skill` starter into `<state_dir>/skills/create-skill/SKILL.md` only when absent. Re-running setup preserves customized instructions and skills. There is no separate `agent-workspace` directory or configurable workspace root.

Shell, file, search, and image tools still need a base for relative paths. `MCP_CONFIG.defaultCwd` is the operating-system user's home directory, so relative tool paths resolve from `~`; callers can pass an absolute cwd/path for any project. This is convenience, not a sandbox (`src/config.ts`, `src/index.ts`, `scripts/setup.ts`, `scripts/state-setup.ts`, `test/state-setup.test.ts`).

## Persistent Skills

Reusable agent workflows live under `<state_dir>/skills/<name>/SKILL.md`. `src/tools/skills/skill-catalog.ts` owns filesystem discovery, name validation, frontmatter descriptions, symlink-compatible lookup, and the byte ceiling. `src/tools/skills/skill-tools.ts` is the MCP adapter: `skill_list` scans through the catalog and `skill_use` returns complete instructions plus the local `SKILL.md` path. The catalog validates names at its own boundary, so direct callers do not depend on MCP-schema validation for path safety.

Repeated loads of the same skill by the same `AgentIdentity` within five seconds reuse the pending load and return a short reuse notice; failed loads remain retryable. `src/agent/load-deduper.ts` owns this per-agent load pattern and is also used by `start_here`. Callers without session identity are not deduplicated. Skills are dynamic data rather than MCP schema entries, so adding or removing a skill does not require rebuilding the server (`src/tools/skills/skill-catalog.ts`, `src/tools/skills/skill-tools.ts`, `src/agent/load-deduper.ts`, `src/mcp/server-factory.ts`).

The persistent skill catalog is intentionally not enumerated here because it is dynamic and can change without an OpenChatX rebuild. Directory symlinks are supported, so selected shared skills can stay single-sourced while still appearing under `<state_dir>/skills` (`src/tools/skills/skill-catalog.ts`, `test/tools/skills/skill-catalog.test.ts`).

Skill names may begin with an alphanumeric character or underscore and may otherwise contain letters, numbers, dots, underscores, and hyphens. A leading underscore can be used for installation-local skills such as `_web-search`. The restricted character set prevents path traversal while still allowing a named skill entry to be a symlink. `SKILL.md` is capped at 256 KiB; broken or oversized entries are omitted from `skill_list`, while direct `skill_use` calls return explicit errors (`src/tools/skills/skill-catalog.ts`, `src/tools/skills/skill-tools.ts`, `test/tools/skills/skill-catalog.test.ts`).

## Skill Bootstrap Boundary

`skills/create-skill/SKILL.md` is repository-owned bootstrap source, while `<state_dir>/skills/create-skill/SKILL.md` becomes installation-owned state after the first setup copy. Runtime discovery scans only `<state_dir>/skills`; repository-level skill files do not enter `skill_list` or `skill_use` unless setup or another explicit mechanism places them there (`scripts/state-setup.ts`, `skills/create-skill/SKILL.md`, `src/tools/skills/skill-catalog.ts`).

## Related

- [Project Overview](./project-overview.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Persistent Shell Runtime](./persistent-shell-runtime.md)
- [apply_patch](./tools/apply-patch.md)
