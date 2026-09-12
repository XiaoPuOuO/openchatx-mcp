# Shellby MCP Wiki

Project knowledge for coding agents. Usage Steps:

1. Read [Project Overview](./pages/project-overview.md).
2. Read `index.md`.
3. Follow only branches relevant to the current task.
4. Open the smallest useful set of pages.
5. Verify drift-prone facts against repository evidence.

Use `raw/index.md` only when supporting evidence is needed. Raw source bodies are preserved evidence, not maintained synthesis.
Read `log.md` only when historical context or the reason behind past decisions matters.

Routable pages use:

`<descriptive-filename-slug>.md`:

```md
---
summary: "Concise description of this page."
paths:
  - src/related-files/
  - src/related-file.ts
---

[content]
```

For maintenance, read [maintenance.md](maintenance.md).

## Agent Rules

- Never restart this mcp server, or pm2 process without explicit approval.
