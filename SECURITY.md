# Security Policy

OpenChatX intentionally gives authorized MCP callers powerful access to the local operating-system user account. Treat authentication, tunnel policy, command execution, browser control, and file access issues as security-sensitive.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** flow for this repository. Do not open a public issue for an unpatched vulnerability or include credentials, tokens, private URLs, or personal data in a report.

Include the affected version or commit, reproduction steps, impact, and any suggested mitigation when available.

## Scope

The supported release targets are macOS (Apple Silicon or Intel) and native Windows 10/11. Direct localhost MCP access is intentionally unauthenticated; the remote ChatGPT path depends on the checked-in ngrok trust policy plus OpenChatX's bound OpenAI subject check. See the README and [`wiki/pages/http-transport.md`](wiki/pages/http-transport.md) for the current trust model.
