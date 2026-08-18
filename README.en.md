# jsona

**A structure-first, local-first viewer & toolkit for JSON / YAML / TOML / CSV.**

Open a file and go — your data stays on your machine by default. Optionally connect your own share server for short links and GitHub-account workspace sync.

## Features

- **Multi-format parsing**: JSON / YAML / TOML / CSV, auto-detection, BOM stripping, errors pinpointed to line & column.
- **Structure-first views**: tree view (virtual scrolling — handles huge files without lag), column view, table view, graph view (force-directed 2D + 3D), diff comparison.
- **In-place editing**: Monaco editor + live parse validation + export true serialization back to the original format.
- **AI assistant**:
  - **Local**: offline structure analysis, path lookup, diff explanation — zero upload.
  - **Cloud (BYOK)**: bring your own OpenAI / Anthropic / compatible gateway key. jsona proxies your prompt at zero cost — no model hosting, no token fees.
  - **MCP**: `jsona mcp` runs as a standard MCP server (stdio / HTTP-SSE / OAuth / WebSocket), exposing `jsona_query` / `jsona_schema` / `jsona_diff` / `jsona_ask` tools for agents.
- **Share & sync (optional)**: short links, GitHub-account workspace sync across devices.

## Quick start

### Web viewer (fully offline, open & go)

```bash
pnpm install
pnpm dev       # open the printed URL in your browser
```

### CLI (install from npm)

```bash
npm i -g jsona-view

jsona query 'data.users[*].name' input.json
jsona format input.yaml -o output.json
jsona mcp     # start an MCP server
```

## Packages

| Package | Description | License |
|---|---|---|
| `jsona-core` | Parsing / serialization / graph building / diff (pure functions, zero deps) | MIT |
| `jsona-view` | CLI `jsona`: `query` / `format` / `minify` / `sort` / `diff` / `mcp` / `serve` | MIT |
| `packages/web` | Web viewer (React + Vite, fully offline capable) | GPL-3.0 |
| `server/` | Optional share / sync backend (Node + SQLite-WASM) | Closed source |

> Data stays on your machine by default. Only short links, GitHub sync and BYOK AI require connecting to your own server; pure-offline use needs no setup.

## Docs

- `server/README.md`: share server deployment & configuration.
- `DEPLOY.md`: npm publishing, Vercel static deployment, backend container deployment.
