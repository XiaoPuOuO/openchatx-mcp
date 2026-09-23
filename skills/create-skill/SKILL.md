---
name: create-skill
description: Create or revise reusable Shellby MCP skills. Use when the user asks to create a skill, add a reusable agent workflow, improve an existing skill, or package repeatable instructions for skill_list and skill_use.
---

# Create Skill

Create small reusable workflows that Shellby MCP can discover from the configured workspace.

## Workspace

- Treat the configured Shellby workspace as `<workspace>`. Determine it from the MCP instructions or current shell context. Never assume a username or absolute path.
- Store MCP skills at `<workspace>/skills/<name>/SKILL.md`.
- Read `<workspace>/AGENTS.md` and inspect existing skills before changing the catalog.
- Use lowercase hyphenated skill names. Keep the directory name and frontmatter `name` identical.

## Skill structure

Minimum:

```text
skills/<name>/
└── SKILL.md
```

Optional resources when they materially improve repeated use:

```text
skills/<name>/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

- `scripts/`: deterministic or repeatedly reused operations.
- `references/`: detailed material loaded only when needed.
- `assets/`: templates or files consumed by the workflow.

Keep the important workflow in `SKILL.md`. Avoid extra documentation unless the skill needs it as working material.

## Frontmatter

Use:

```yaml
---
name: example-skill
description: What the skill does and concrete requests that should trigger it.
---
```

`skill_list` exposes the directory name and frontmatter description, so make the description specific enough for an agent to know when to load it.

## Workflow

1. Inspect existing skills for overlap and conventions.
2. Define the requests that should trigger the skill.
3. Capture only reusable instructions, constraints, domain knowledge, scripts, references, and assets needed for those requests.
4. Create or update `<workspace>/skills/<name>/SKILL.md`.
5. Use `skill_list` to verify discovery.
6. Use `skill_use` to verify the complete instructions load correctly.
7. Exercise complex skills on a realistic request when useful.

## Portability

- Prefer paths relative to `<workspace>` or the skill directory.
- Do not assume Codex, Claude, a particular username, or another agent runtime is installed.
- If the user explicitly wants one skill shared with another runtime, inspect that runtime's supported skill location and symlink or share a canonical directory only when both runtimes can consume the same files correctly.
- Avoid runtime-specific tool names unless the skill is intentionally specific to that runtime.

## Quality check

Verify that:

- the trigger description is concrete;
- the instructions are concise and reusable;
- referenced files exist;
- scripts were tested when present;
- `skill_list` shows the skill;
- `skill_use` returns the expected instructions.
