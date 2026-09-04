# Shellby UI

Local real-time dashboard for observing Shellby MCP agents and queueing steering instructions.

See `buildplan.md` for the agreed V1 scope.

## Development

From the repository root:

```bash
npm run ui:install
npm run ui:dev
```

The Vite dev server proxies `/ui/api` to Shellby at `http://127.0.0.1:3333`.

## Production

```bash
npm run ui:build
```

Shellby serves the generated `ui/dist/` folder at `/ui` when `[ui].enabled = true`.
