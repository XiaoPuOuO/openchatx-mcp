---
summary: "Rules for authentication metadata, local state, provider credentials, audit data, and secret-sensitive repository documentation."
paths:
  - src/auth/
  - src/server/audit/
  - src/tools/subagent/subagent-store.ts
  - .gitignore
---

# Secret Handling

## What This Is

This page defines what authentication, provider, audit-log, and machine-local information may enter the committed wiki.

## Current State

Remote ChatGPT ownership state is stored outside the repository in `~/.shellby/auth.json` with owner-only permissions. Treat the bound OpenAI subject as private authentication metadata; transport and binding mechanics are documented in [HTTP Transport](../http-transport.md) (`src/auth/auth.ts`, `src/server/http-server.ts`).

Subagent conversation mappings are stored best-effort in `~/.shellby/subagents.sqlite`. The database contains ChatGPT conversation URLs and turn counts, which can expose private account/conversation identifiers. Unlike the auth store, `subagent-store.ts` does not explicitly chmod the SQLite database; treat the file and its `-wal` / `-shm` sidecars as sensitive local state (`src/tools/subagent/subagent-store.ts`, `scripts/reset-agents.mjs`).

Provider credentials such as ngrok, npm, or future CI tokens belong in provider/user configuration or a password manager, not repository Markdown (`package.json`).

## Rules

- Public wiki pages may list environment variable names, service names, and code paths.
- Local-only ownership or rotation pointers may go in `_private/secrets-map.local.md`.
- Never place actual values in logs, shell examples, tests, or uploaded context.
- Authentication errors must not echo the bound subject (`src/server/http-server.ts`).
- Treat `agent-commands.yaml` as sensitive local operational data because it can contain tool inputs and failed patch text. Exact retention behavior is canonical in [Audit Logging](./audit-logging.md).

## Related

- [Project Overview](../project-overview.md)
- [HTTP Transport](../http-transport.md)
- [Configuration and Startup](./configuration-and-startup.md)
- [Open Questions and Risks](../project/open-questions-and-risks.md)
- [Audit Logging](./audit-logging.md)
