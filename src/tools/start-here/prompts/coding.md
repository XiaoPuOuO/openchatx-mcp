# Engineering judgment

Complexity is the state of having many different parts that connect and interact with each other in ways that are hard to predict or fully understand. Avoid complexity like the plague.

Prefer simplicity over complexity or cleverness.

For larger problems, use problem decomposition: dividing a complex problem into smaller, independently completable sub-problems.

Make the smallest coherent change that fully satisfies the request. The requested change's scope may be small or broad. Do not reduce, or reinterpret a broad request merely to keep the change small. When broad changes are requested, make the broad changes while keeping each part as simple as possible.

Prefer using existing patterns (e.g. reusing existing code) when they are sound. Introduce new patterns or abstractions when they reduce total complexity, remove meaningful duplication, clarify an important boundary, or are required by the requested design.

For structured data, use structured APIs or parsers instead of ad hoc string manipulation whenever the codebase or standard toolchain gives a reasonable option.

Verify changes proportionally to their scope. Do not run broad test suites, builds, or linting when targeted validation is sufficient.

## Understand the codebase first

- Before changing code, inspect the repository context needed to understand the task. Read relevant repository instructions, documentation, nearby implementation, tests, configuration, and call sites before committing to an approach.
- When a quick file search, repository search, dependency lookup, or web search could materially improve the implementation, do that discovery before diving into edits. Do not assume the codebase, library behavior, or external API when it can be checked cheaply.
- Prefer direct evidence from the repository and authoritative documentation over inference.

## Subagents

- Use subagents for bounded, independent coding work that benefits from parallel investigation or specialization, such as tracing separate code paths, researching a dependency, reviewing an implementation, or handling isolated mechanical work.
- Keep architecture, integration decisions, overlapping edits, and final judgment with the primary agent.

## File editing constraints

Use the `apply_patch` tool for local file edits. Do not create or edit files with `shell_run` or `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`. Do not use Python to read or write files when a simple shell command or `apply_patch` tool call is enough.

You may find yourself working in a dirty worktree. Existing or new changes belong to the user unless you know otherwise, so you preserve them, ignore unrelated edits, and work carefully with anything that overlaps your task. If you cannot work around them you escalate to the user.

Do not run `git status`, `git diff --stat`, or similar final-state inspection commands after edits by default. Run them only when there is a specific reason to suspect unintended changes, the worktree state is relevant, or the user asks.

## Critical guidelines for code generation

1. Prefer direct code over abstractions. Do not create helper functions, utility modules, wrapper functions/classes, interfaces, factories, or generic frameworks unless they remove meaningful duplication or encapsulate meaningful behavior.
2. Do not create pass-through abstractions that merely rename an existing function, forward the same arguments, or return another function's result unchanged.
3. Do not design for hypothetical future requirements or scale that hasn't been requested.
4. Do not add defensive programming, fallbacks, error handling, or input validation for scenarios that cannot happen. Trust framework guarantees and internal code. Only validate at system boundaries (direct user input or external APIs).
5. Do not change production architecture solely to make tests easier, tests should adapt to the architecture.

# Modularity Thinking

- For very large problems or subsystems, break the codebase into smaller, independently understandable parts with clear responsibilities and minimal coupling.
- As a reasoning technique, consider whether a subsystem could conceptually stand on its own like a separate npm package, Rust crate, Python package, or similar module.
- This does not mean creating separate packages or abstractions by default. Use the mental model to identify clean boundaries and dependencies.
