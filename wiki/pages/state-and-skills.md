---
summary: "Persistent Agent Skills and Cursor-style Rule state."
---

# State, Skills, and Rules

## Editable start_here template

`<state_dir>/AGENTS.md` is the runtime template for `start_here`. Static operating guidance lives there instead of in the server implementation. Dynamic context is inserted only through placeholders:

- `{{MODE}}`
- `{{TASK_ID}}`
- `{{MODE_INSTRUCTIONS}}`
- `{{PROJECT_CONTEXT}}`
- `{{CAPABILITY_CATALOG}}`
- `{{ALWAYS_RULES}}`

The Toolbox Dashboard exposes this file at the same level as Toolbox folders. Users can move, repeat, or remove placeholders to control the final prompt shape. Bundled mode prompts remain separately selectable/overridable and are injected through `{{MODE_INSTRUCTIONS}}`.

## Persistent Skills

Reusable agent workflows live only inside Toolbox folders at `toolboxes/<toolbox>/skills/<name>/SKILL.md`. `SKILL.md` stays portable and uses the standard `name` and `description` frontmatter plus Markdown instructions. `skill_search` returns at most five relevant qualified names/descriptions without loading instructions; `skill_load` accepts an exact `<toolbox>.<skill>` name; `skill_manage` creates, edits, or deletes a skill inside an explicit toolbox.

Skills are always on-demand. No skill name, description, or body is injected by `start_here`, and Skills do not have `alwaysApply` or an OpenChatX startup-loading flag. `store_skill_import` and `store_skill_export` copy portable skill folders, including optional `scripts/`, `references/`, and `assets/`, between OpenChatX and other Agent Skills consumers.

New managed skill names use lowercase kebab-case; safe legacy names remain readable for compatibility. `SKILL.md` is capped at 256 KiB.

## Persistent Rules

Rules are a separate system under `<state_dir>/rules/*.mdc`. The format follows the common Cursor-style MDC shape:

```md
---
description: "React component conventions"
globs:
  - "src/**/*.tsx"
alwaysApply: false
---

# React

Use accessible labels and named exports.
```

Rule activation modes are first-class in the API and derived from metadata:

- **Always** (`mode=always`): `alwaysApply: true`; the full Markdown body is injected by `start_here`.
- **Auto Attached** (`mode=auto_attached`): `alwaysApply: false` with `globs`; `rule_resolve` selects the rule when a relevant file path matches.
- **Agent Requested** (`mode=agent_requested`): `alwaysApply: false`, no globs, and a `description`; `rule_resolve` selects it by task-query relevance.
- **Manual** (`mode=manual`): no description, no globs, and `alwaysApply: false`; it is loaded only through `rule_load` when explicitly referenced.

`rule_manage` creates, edits, or deletes `.mdc` files and accepts the four mode names directly. The mode itself is not duplicated into the file; `description`, `globs`, and `alwaysApply` remain the canonical persisted metadata.

## Compatibility

`rule_import` and `rule_export` bridge three external formats:

- **Cursor**: native `.mdc`; all four OpenChatX modes can round-trip without losing activation metadata.
- **Claude Code**: `.claude/rules/*.md`; no `paths` maps to Always, while `paths` maps to Auto Attached.
- **AGENTS.md / OpenCode-style instructions**: imports as Always by default because directory scope is carried by the file location rather than rule metadata.

Claude and AGENTS.md cannot losslessly represent OpenChatX Agent Requested or Manual activation. `rule_export` rejects those conversions unless `allow_lossy=true`, and returns a warning when the exported rule's activation semantics change. Import callers can override `mode`, `description`, and `globs` to choose an exact OpenChatX mode.

## Skill Bootstrap Boundary

There is no global skill catalog under `state_dir`. Runtime discovery scans enabled Toolboxes only, so every skill is visible in the same Toolbox model used by the UI.

## Related

- [Project Overview](./project-overview.md)
- [Configuration and Startup](./operations/configuration-and-startup.md)
- [MCP Tool Surface](./mcp-tool-surface.md)
- [Tool Naming and Schema Design](./tool-naming-and-schema-design.md)
