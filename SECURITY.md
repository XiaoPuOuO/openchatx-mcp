# Security Policy

OpenChatX intentionally gives authorized MCP callers powerful access to the local operating-system user account. Treat authentication, tunnel policy, command execution, browser control, and file access issues as security-sensitive.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** flow for this repository. Do not open a public issue for an unpatched vulnerability or include credentials, tokens, private URLs, or personal data in a report.

Include the affected version or commit, reproduction steps, impact, and any suggested mitigation when available.

## Scope

The supported release targets are macOS (Apple Silicon or Intel) and native Windows 10/11. Direct localhost MCP access is intentionally unauthenticated; remote ChatGPT access is carried through OpenAI Secure MCP Tunnel, and OpenChatX binds trusted tool calls to the first observed OpenAI subject. See the README and [`wiki/pages/http-transport.md`](wiki/pages/http-transport.md) for the current trust model.
