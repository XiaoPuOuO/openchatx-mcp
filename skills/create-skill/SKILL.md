---
name: create-skill
description: Create or revise reusable SKILL.md workflows for OpenChatX using the common Markdown skill format.
---

# Create Skill

Create portable reusable workflows as Markdown skills.

## Format

A skill lives at:

```text
<state_dir>/skills/<name>/SKILL.md
```

Use YAML frontmatter followed by Markdown instructions:

```yaml
---
name: example-skill
description: What this skill does and the requests it is relevant to.
---
```

Then place the reusable instructions in the Markdown body.

- `name` must match the skill directory name.
- `description` should be concise, searchable, and describe when the skill applies.
- Keep SKILL.md portable: its required frontmatter is only `name` and `description`.
- Skills have no `alwaysApply` or startup-loading policy. Persistent activation belongs to the separate Rule system.
- Full instructions are returned only by `skill_load`.

## Discovery model

- Do not enumerate all skills to the agent.
- If the user explicitly names or refers to a skill/workflow, use `skill_search` with those words.
- `skill_search` returns only name and description and at most five relevant results.
- No skill metadata or body is injected at startup.
- Use `skill_load` only after selecting an exact skill.

## Management

Use `skill_manage` for user-owned skills:

- `action="create"` creates a new skill.
- `action="edit"` updates metadata or replaces the complete `SKILL.md`.
- `action="delete"` removes the skill directory.

When supplying complete Markdown to create/edit, preserve valid frontmatter and keep the frontmatter `name` identical to the requested skill name.

## Portability

Prefer generic Markdown instructions and relative paths. Avoid runtime-specific assumptions unless the skill is intentionally OpenChatX-specific. Optional sibling folders such as `scripts/`, `references/`, and `assets/` may be used when they materially improve reuse.
