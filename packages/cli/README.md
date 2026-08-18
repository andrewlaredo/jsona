# jsona-view (CLI)

Local-first structured-text query & conversion CLI for **JSON / YAML / TOML / CSV**.
No network calls — everything runs on your machine. MIT licensed.

> The npm package is named **`jsona-view`**; the installed command is **`jsona`**.

```bash
npm i -g jsona-view
# or, from the workspace:
pnpm --filter jsona-view build
```

## Query (jq-style)

```bash
jsona '.user.address.city' data.json
cat data.yaml | jsona '.services[0].name' -f yaml
```

- `[expr]` — dot-path expression (default `.` returns the whole document).
- `[file]` — input file; omit to read from **stdin**.
- `-f, --from <fmt>` — force input format: `json|yaml|toml|csv`.
- `-o, --output <fmt>` — convert the result: `json|yaml|toml|csv`.
- `--no-color` — disable ANSI colors (in `diff`).

## Convert

```bash
jsona '.services' data.json -o yaml      # query → YAML
jsona format  data.json -o toml          # normalize → TOML
jsona sort    data.json                  # sort keys alphabetically
jsona minify  data.json                  # compact single line
```

`format` pretty-prints/normalizes, `sort` recursively sorts object keys,
`minify` compresses to one line. All support `-i/-f/-o`.

## Diff

```bash
jsona diff old.json new.json
jsona diff a.yaml b.yaml -o json          # machine-readable
```

Structural diff powered by `jsona-core`. Prints `+ added`, `- removed`,
`~ changed` paths plus a summary. Use `-o json` for the full `DiffEntry[]`.

## Offline web viewer

```bash
jsona web data.json -o report.html
open report.html
```

Generates a **self-contained HTML** file (collapsible JSON tree + raw source,
no CDN, no upload) you can share or archive.

## Serve (live local viewer)

```bash
jsona serve data.json                 # http://127.0.0.1:8080, opens browser
jsona serve data.json -p 9000         # custom port
jsona serve data.json --no-open       # don't auto-open the browser
jsona serve data.json --no-watch      # disable file-watch live reload
cat data.yaml | jsona serve - -f yaml # serve from stdin
```

Starts a **local-only HTTP server** that renders the same self-contained
viewer and watches the input file — edit and save, the page reloads
automatically via a Server-Sent-Events channel. Nothing is uploaded; the file
never leaves your machine. Bind to a non-localhost host at your own risk.

## Notes

- Files larger than 10 MB print a hint (web sharing is capped; the CLI handles
  them locally).
- TOML output is emitted by a built-in, dependency-free serializer that supports
  tables, arrays of tables, and scalars.
