# jsona Share Server

Optional backend for jsona. The web client works fully offline without it; this
server only adds **server-side short share links** and **optional GitHub-account
workspace sync**.

> **License: closed-source.** This `server/` directory is the commercial backend
> of jsona and is **not** released under the open-source licenses used by the
> other packages (CLI/core = MIT, web = GPL-3.0). The source here is provided for
> self-hosting reference only; redistribution and derivative works are not
> permitted without a separate commercial agreement.

## Features
- `POST /api/share` → store a document, get a short `/s/:id` link (TTL, default 7d).
- `GET /api/share/:id` → retrieve stored document.
- `GET /s/:id` → tiny redirect page to the web client with the share id in the hash.
- Workspace sync (requires GitHub OAuth):
  - `GET /api/workspace` list, `GET/PUT /api/workspace/:id` read/save, `DELETE` remove.
  - `GET /api/oauth/login` → GitHub authorize, `/callback` → session cookie.
  - `GET /api/oauth/me` → `{ authenticated, login }`, `POST /api/oauth/logout`.

## Storage (SQLite)
Data lives in a real SQLite database (`DB_PATH`, default `./data/share.db`) with
WAL enabled and indexes on TTL / owner columns.

The engine is `node-sqlite3-wasm` — SQLite compiled to WebAssembly — chosen so the
server has **no native build step**. Prebuilt `better-sqlite3` binaries are not
published for every Node/OS combination, and this deployment target had no
compiler toolchain, so a native driver could not be installed at all.

A legacy `./data/share.json` from earlier versions is imported automatically on
first start, then renamed to `.json.migrated` so it is never re-imported.

## Abuse protection
- **Per-IP rate limiting**, fixed window, counters stored in SQLite so they
  survive restarts (an in-memory counter resets exactly when an abuser retries).
  Writes and reads use independent budgets: throttled writes never block reads.
  - `RATE_WINDOW_MS` (default 60000), `RATE_WRITE_MAX` (20), `RATE_READ_MAX` (120).
  - Every response carries `X-RateLimit-Limit/Remaining/Reset`; a 429 adds `Retry-After`.
- **Payload caps** — requests over `MAX_SHARE_BYTES` (default 4 MB) are rejected
  with 413 before the body is parsed or stored.
- **Per-account quota** — at most `MAX_WORKSPACES_PER_USER` (default 50) stored
  workspaces; updating an existing one is always allowed.
- **`TRUST_PROXY`** — set to `1` *only* behind a trusted reverse proxy. When off,
  `X-Forwarded-For` is ignored, since a client can otherwise forge it and bypass
  per-IP limits.

## Config (`.env`)
See `.env.example`. `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are optional; with
them unset, the web client stays anonymous (local-only). `PUBLIC_ORIGINS` controls
CORS (comma-separated origins, or `*` to allow any).

## Run (dev)
```
pnpm install
cp .env.example .env   # edit SESSION_SECRET, optionally GitHub keys + PUBLIC_ORIGINS
node --env-file=.env src/server.js
```

## Build & Run (prod)
```
npm run build          # tsc -> dist/
node --env-file=.env dist/server.js
```

## Docker
```
docker build -t jsona-share .
docker run -d -p 8787:8787 \
  -e PUBLIC_URL=https://share.example.com \
  -e PUBLIC_ORIGINS=https://jsona.example.com \
  -e SESSION_SECRET=long-random \
  -e GITHUB_CLIENT_ID=... -e GITHUB_CLIENT_SECRET=... \
  -v jsona-data:/app/data jsona-share
```
The SQLite DB persists in `/app/data` (mount a volume). Add `-e TRUST_PROXY=1`
when running behind a reverse proxy so per-IP limits see the real client address.

## Connecting the web client
Set `VITE_API_BASE` in `packages/web/.env` to the server's base URL (e.g.
`https://share.example.com`). The web client then shows the "server short link"
and "workspace sync" sections. Without it, the client stays 100% local-first.

## GitHub OAuth setup
1. On GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Authorization callback URL = `https://<your-server>/api/oauth/callback`.
3. Copy Client ID / Client Secret into `.env` (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`).
4. Optionally restrict to specific GitHub logins via `GITHUB_ALLOWED_USERS`
   (comma-separated; empty = allow any authenticated GitHub user).
5. Restart the server. The web client's "sign in with GitHub" button becomes active.

OAuth is read-only (user + avatar). No email/password scope is requested. Session
cookies are HMAC-signed with `SESSION_SECRET`; rotate the secret to invalidate all.

## Security notes
- Documents stored via `/api/share` are reachable by anyone who knows the short id
  (unguessable nanoid). Do not store secrets you would not paste into a public link.
- Workspace documents are scoped per GitHub login and require authentication.
- Rate-limit counters are keyed by client IP; behind a proxy set `TRUST_PROXY=1`,
  otherwise every request appears to come from the proxy and shares one budget.
- The short-link page escapes the id before reflecting it into HTML.

This package is **UNLICENSED / proprietary** — see `LICENSE`.
