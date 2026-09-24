# Contributing

Thanks for improving OpenChatX.

## Development

OpenChatX targets macOS and native Windows on arm64/x64 with Node.js 22.18.0 or newer.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Keep changes focused and preserve the existing tool contracts unless the change intentionally updates them. The maintainer architecture notes live in [`wiki/`](wiki/).

## Pull requests

- Explain the behavior change and why it is useful.
- Add or update focused tests for behavioral changes.
- Keep secrets, local paths, logs, and personal data out of commits.
- Preserve third-party license and notice files under `vendor/`.

For security issues, follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.
