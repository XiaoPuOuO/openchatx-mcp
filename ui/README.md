# openchatx-mcp UI

Local real-time dashboard for observing openchatx-mcp agents and queueing steering instructions.

See `buildplan.md` for the agreed V1 scope.

## Development

From the repository root:

```bash
npm run ui:install
npm run ui:dev
```

The Vite dev server proxies `/ui/api` to openchatx-mcp at `http://127.0.0.1:3333`.

## Production

```bash
npm run ui:build
```

openchatx-mcp serves the generated `ui/dist/` folder at `/ui` when `[ui].enabled = true`.
