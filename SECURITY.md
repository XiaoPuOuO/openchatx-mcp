# Security Policy

OpenChatX intentionally gives authorized MCP callers powerful access to the local operating-system user account. Treat authentication, tunnel policy, command execution, browser control, and file access issues as security-sensitive.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** flow for this repository. Do not open a public issue for an unpatched vulnerability or include credentials, tokens, private URLs, or personal data in a report.

Include the affected version or commit, reproduction steps, impact, and any suggested mitigation when available.

## Scope

The supported release targets are macOS (Apple Silicon or Intel) and native Windows 10/11. Direct localhost MCP access is intentionally unauthenticated; remote ChatGPT access is carried through OpenAI Secure MCP Tunnel, and OpenChatX binds trusted tool calls to the first observed OpenAI subject. See the README and [`wiki/pages/http-transport.md`](wiki/pages/http-transport.md) for the current trust model.

## Community capabilities

Community Capability Store entries are discovered directly from public GitHub repositories tagged `openchatx-capability`. They are not reviewed, approved, or endorsed by OpenChatX. Treat them like arbitrary third-party code.

OpenChatX exposes the source tree, exact commit SHA, static review evidence, and individual source files before install. Static review can identify common risk indicators but cannot prove that a capability is safe. Install only code you are willing to run with your local user permissions.

Community installation is pinned to an immutable commit revision, rejects symlinks and git submodules, enforces path and size limits, and records Store ownership so uninstall does not delete unrelated Toolbox directories. `GITHUB_TOKEN` is optional for API rate limits; never commit or paste that token into a capability repository.

## Project scopes

Registered Projects provide an OpenChatX policy layer around built-in file, search, shell startup, image, patch, durable-job, and workflow-job path resolution. Their read/write/shell flags are not an operating-system sandbox. Shell commands and interactive terminals execute with the current OS user's permissions, and code reached through custom Toolboxes or external MCP servers may not pass through Project path checks. Use Project permissions to make agent intent and default scope explicit, not as a substitute for OS-level isolation.
