---
summary: "Mandatory startup context for Shellby MCP"
---

# Project Overview

## What This Is

Shellby MCP is a local macOS agent harness that gives ChatGPT Web stateful, high-authority tools backed by the user's machine. It exists so agents can perform sustained engineering work with persistent local capabilities instead of treating every tool call as an isolated action. Shellby deliberately inherits the current macOS user's authority; it is a coordination and capability layer, not a sandbox or hosted multi-user service. The MCP is entirely for agents at this time, not for human users.

## Engineering Approach

- Prefer simplicity over complexity.
- Tests should adapt to the architecture. Do not turn production architecture into a dependency-injection framework solely to make tests easier.
- Model-facing tool descriptions and schemas work together. Prefer letting the TypeScript-like schema carry obvious shape and constraints; descriptions should add only routing and usage semantics the schema cannot express clearly.
- Prefer functional typescript over class-based when it improves readability and maintainability.
- Follow the Agile principle of adapting to new information: keep major software design decisions changeable as the build progresses.
- For larger problems, use problem decomposition: dividing a complex problem into smaller, independently completable outcomes.
