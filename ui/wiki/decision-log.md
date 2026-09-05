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

## 2026-09-04 — Pixel room is delayed visualization, not live-state mirror

Fast Shellby calls were too brief to perceive when animation followed `agent.current` directly. Room now queues observed call IDs and gives each station action at least three visible working seconds after arrival, while server Recent/state remains authoritative. Pixel Agents assets and office composition conventions provide visual language; Shellby keeps smaller custom engine instead of importing Pixel Agents editor/pathfinding stack.
