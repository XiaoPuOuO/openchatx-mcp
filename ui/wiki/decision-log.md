# Decision Log

Preserve major historical reasoning that helps a future agent understand why the project took its current direction.

Add an entry when a significant decision, reversal, discovery, rejected approach, validation, or lesson from real usage would be useful to understand later and its reasoning is not obvious from the current code, wiki, or Git history.

Do not use this as a changelog. Routine implementation changes, wiki maintenance, generated output, and tests run do not belong here.

Format:

```markdown
## YYYY-MM-DD — Short description

[What changed in the project's direction or understanding, why, and any rejected alternative or discovered constraint worth preserving.]
```

<!--
Examples:

## 2026-09-03 — Moved background jobs to a durable queue

Background jobs were moved out of the web process because serverless instances could terminate before work completed and retries could cause duplicate execution.

-->

