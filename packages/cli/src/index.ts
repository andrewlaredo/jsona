#!/usr/bin/env node
/**
 * jsona CLI — local-first structured-text query & conversion (MIT).
 *
 * Commands:
 *   jsona [expr] [file]            jq-style query + optional -o conversion
 *   jsona format|minify|sort ...   shape / compress / sort keys
 *   jsona diff <a> <b>             structural diff (reuses jsona-core)
 *   jsona web [file]               emit a self-contained offline HTML viewer
 *   jsona serve [file]             serve the viewer over HTTP with live reload
 *
 * No network calls. Everything runs locally.
 */
import { readFileSync, writeFileSync, existsSync, watch } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { Command, InvalidArgumentError } from 'commander';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Commander option parser: clamp to a valid TCP port. */
function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError(`invalid port: ${value}`);
  }
  return n;
}

/** Best-effort cross-platform open of a URL in the default browser. */
function openBrowser(target: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {/* ignore */});
    p.unref();
  } catch {
    /* ignore */
  }
}
import * as YAML from 'yaml';
import Papa from 'papaparse';
import {
  parse,
  queryPath,
  diffTrees,
  detectFormat,
  astToPlain,
  type ParseResult,
  type SupportedFormat,
  type DiffEntry,
} from 'jsona-core';

const program = new Command();

program
  .name('jsona')
  .description('jsona CLI - local-first structured text query & conversion (MIT)')
  .version('0.2.0');

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function readInput(file?: string): { src: string; filename: string } {
  // `-` means read from stdin (pipe-friendly): `cat data.json | jsona format -`
  if (file === '-') {
    const src = readFileSync(0, 'utf8');
    return { src, filename: '<stdin>' };
  }
  if (file) {
    if (!existsSync(file)) {
      process.stderr.write(`[jsona] file not found: ${file}\n`);
      process.exitCode = 1;
      throw new Error('file-not-found');
    }
    return { src: readFileSync(file, 'utf8'), filename: file };
  }
  const src = readFileSync(0, 'utf8');
  return { src, filename: '<stdin>' };
}

function byteLengthOf(src: string): number {
  return Buffer.byteLength(src, 'utf8');
}

const LARGE_FILE_BYTES = 10 * 1024 * 1024;

/** Robustly extract options from a commander action's variadic args.
 *  Depending on the command definition, the options object may arrive as the
 *  second-to-last argument or via the trailing Command instance's .opts(). */
function getOpts(...args: unknown[]): Record<string, any> {
  // The Command instance (which carries .opts()) may appear anywhere in the
  // action args depending on how commander wires the program + subcommands.
  for (const a of args) {
    if (a instanceof Command) return (a as Command).opts() as Record<string, any>;
  }
  // Fallback: an options object has known keys.
  for (const a of args) {
    if (
      a &&
      typeof a === 'object' &&
      !Array.isArray(a) &&
      ('output' in (a as object) || 'from' in (a as object) || 'input' in (a as object))
    ) {
      return a as Record<string, any>;
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Serialization (the real TOML emitter — no external dependency)
// ---------------------------------------------------------------------------

function tomlValue(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'string') return JSON.stringify(v); // JSON string escaping works for TOML basic strings
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '0';
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    return '[' + v.map(tomlValue).join(', ') + ']';
  }
  return JSON.stringify(String(v));
}

/** Minimal, correct TOML stringifier supporting tables, arrays of tables, scalars. */
function tomlStringify(value: unknown, rootKey = ''): string {
  const lines: string[] = [];

  const emitTable = (prefix: string, obj: Record<string, any>) => {
    const scalars: string[] = [];
    const subTables: [string, any][] = [];
    const tableArrays: [string, any][] = [];

    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        subTables.push([k, v]);
      } else if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
        tableArrays.push([k, v]);
      } else {
        scalars.push(`${k} = ${tomlValue(v)}`);
      }
    }

    if (scalars.length) {
      if (prefix) lines.push(`[${prefix}]`);
      lines.push(...scalars);
    }

    for (const [k, v] of subTables) {
      const p = prefix ? `${prefix}.${k}` : k;
      lines.push('');
      emitTable(p, v);
    }

    for (const [k, arr] of tableArrays) {
      for (const item of arr) {
        const p = prefix ? `${prefix}.${k}` : k;
        lines.push('');
        lines.push(`[[${p}]]`);
        for (const [ik, iv] of Object.entries(item as Record<string, any>)) {
          if (iv && typeof iv === 'object' && !Array.isArray(iv)) {
            // nested inline table — keep simple, emit as dotted under this array element
            for (const [jk, jv] of Object.entries(iv)) {
              lines.push(`${ik}.${jk} = ${tomlValue(jv)}`);
            }
          } else {
            lines.push(`${ik} = ${tomlValue(iv)}`);
          }
        }
      }
    }
  };

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    emitTable(rootKey, value as Record<string, any>);
  } else if (Array.isArray(value)) {
    lines.push(tomlValue(value));
  } else {
    lines.push(tomlValue(value));
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function serialize(value: unknown, format: SupportedFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(value, null, 2);
    case 'yaml':
      return YAML.stringify(value);
    case 'toml':
      return tomlStringify(value);
    case 'csv':
      return Papa.unparse((Array.isArray(value) ? value : [value]) as object[]);
    default:
      // Defensive: unknown/nonsense output format falls back to JSON.
      return JSON.stringify(value, null, 2);
  }
}

function parseToPlain(src: string, from?: SupportedFormat): unknown {
  const res = parse(src, { format: from });
  return astToPlain(res.root);
}

// ---------------------------------------------------------------------------
// Default command: jq-style query + optional conversion
// ---------------------------------------------------------------------------

program
  .command('query')
  .description('jq-style query + optional conversion (default when no subcommand given)')
  .argument('[expr]', 'jq-style path expression, e.g. .services.api.url (default ".")', '.')
  .argument('[file]', 'input file (defaults to stdin)')
  .option('-i, --input <file>', 'input file')
  .option('-f, --from <format>', 'force input format: json|yaml|toml|csv')
  .option('-o, --output <format>', 'convert output to format: json|yaml|toml|csv')
  .option('--no-color', 'disable ANSI colors')
  .action((expr: string, file: string | undefined, ...rest: unknown[]) => {
    const opts = getOpts(expr, file, ...rest) as { input?: string; from?: string; output?: string };
    const target = opts.input ?? file;
    const { src, filename } = readInput(target);
    if (src.trim() === '') {
      process.stderr.write('[jsona] no input. Usage: jsona <query|format|minify|sort|diff|web|serve|inspect> [options] [file]\n');
      process.stderr.write('Run `jsona <command> --help` for details. Use "-" or omit file to read from stdin.\n');
      process.exitCode = 1;
      return;
    }
    if (byteLengthOf(src) > LARGE_FILE_BYTES) {
      process.stderr.write(
        `[jsona] Note: ${filename} is larger than 10MB. Web sharing is limited; CLI handles it locally.\n`,
      );
    }
    const res: ParseResult = parse(src, { format: opts.from as SupportedFormat | undefined });
    const plain = astToPlain(res.root);

    if (opts.output) {
      process.stdout.write(serialize(plain, opts.output as SupportedFormat) + '\n');
      return;
    }

    const node = queryPath(res.root, expr);
    if (!node) {
      process.stderr.write(`[jsona] path not found: ${expr}\n`);
      process.exitCode = 1;
      return;
    }
    const out = astToPlain(node);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  });

// ---------------------------------------------------------------------------
// format / minify / sort
// ---------------------------------------------------------------------------

function makeShapeCommand(
  name: string,
  description: string,
  transform: (value: unknown) => unknown,
) {
  program
    .command(name)
    .description(description)
    .argument('[file]', 'input file (defaults to stdin)')
    .option('-i, --input <file>', 'input file')
    .option('-f, --from <format>', 'force input format')
    .option('-o, --output <format>', 'output format: json|yaml|toml|csv (default json)')
    .action((file: string | undefined, ...rest: unknown[]) => {
      const opts = getOpts(file, ...rest) as { input?: string; from?: string; output?: string };
      const { src } = readInput(opts.input ?? file);
      const value = parseToPlain(src, opts.from as SupportedFormat | undefined);
      const out = transform(value);
      const fmt = (opts.output as SupportedFormat) || 'json';
      process.stdout.write(serialize(out, fmt) + '\n');
    });
}

makeShapeCommand('format', 'pretty-print / normalize the document', (v) => v);
makeShapeCommand('sort', 'sort object keys alphabetically (recursively)', (v) => sortKeysDeep(v));

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// `minify` uses compact JSON regardless of -o for clarity; honor -o otherwise.
program
  .command('minify')
  .description('alias: compress JSON to one line')
  .argument('[file]', 'input file')
  .option('-i, --input <file>', 'input file')
  .option('-f, --from <format>', 'force input format')
  .action((file: string | undefined, ...rest: unknown[]) => {
    const opts = getOpts(file, ...rest) as { input?: string; from?: string };
    const { src } = readInput(opts.input ?? file);
    const value = parseToPlain(src, opts.from as SupportedFormat | undefined);
    process.stdout.write(JSON.stringify(value) + '\n');
  });

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

const OP_COLOR: Record<DiffEntry['op'], string> = {
  added: '\x1b[32m',
  removed: '\x1b[31m',
  changed: '\x1b[33m',
  unchanged: '\x1b[90m',
};
const RESET = '\x1b[0m';

program
  .command('diff')
  .description('structural diff between two documents')
  .argument('<fileA>', 'original document')
  .argument('<fileB>', 'new document')
  .option('-f, --from <format>', 'force input format (auto-detected if omitted)')
  .option('-o, --output <format>', 'output format: text|json (default text)')
  .option('--no-color', 'disable ANSI colors')
  .action(
    (
      fileA: string,
      fileB: string,
      ...rest: unknown[]
    ) => {
      const opts = getOpts(fileA, fileB, ...rest) as { from?: string; output?: string; color?: boolean };
      const a = readInput(fileA).src;
      const b = readInput(fileB).src;
      const fmt = (opts.from as SupportedFormat) || undefined;
      const ra = parse(a, { format: fmt });
      const rb = parse(b, { format: fmt });
      const diffs: DiffEntry[] = diffTrees(ra.root, rb.root);
      const color = opts.color !== false;

      if (opts.output === 'json') {
        process.stdout.write(JSON.stringify(diffs, null, 2) + '\n');
        return;
      }

      const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
      const lines: string[] = [];
      for (const d of diffs) {
        counts[d.op]++;
        if (d.op === 'unchanged') continue;
        const c = color ? OP_COLOR[d.op] : '';
        const tag = d.op === 'added' ? '+' : d.op === 'removed' ? '-' : '~';
        lines.push(`${c}${tag} ${d.path}${color ? RESET : ''}`);
      }
      const summary = `[jsona] ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed, ${counts.unchanged} unchanged (${diffs.length} total)`;
      process.stdout.write(lines.join('\n') + (lines.length ? '\n' : '') + summary + '\n');
    },
  );

// ---------------------------------------------------------------------------
// web — self-contained offline HTML viewer (no CDN, no upload)
// ---------------------------------------------------------------------------

program
  .command('web [file]')
  .description('emit a self-contained offline HTML viewer (local, no upload)')
  .argument('[file]', 'input file')
  .option('-f, --from <format>', 'force input format')
  .option('-o, --output <html>', 'write HTML to this file instead of stdout')
  .action((file: string | undefined, ...rest: unknown[]) => {
    const opts = getOpts(file, ...rest) as { from?: string; output?: string };
    const { src } = readInput(file);
    const fmt = (opts.from as SupportedFormat) || detectFormat(src);
    const res = parse(src, { format: fmt });
    const plain = astToPlain(res.root);
    const html = buildOfflineHtml(JSON.stringify(plain, null, 2), fmt, res.nodeCount);
    if (opts.output) {
      writeFileSync(opts.output, html, 'utf8');
      process.stderr.write(`[jsona] wrote ${opts.output}\n`);
    } else {
      process.stdout.write(html);
    }
  });

// ---------------------------------------------------------------------------
// serve — local HTTP viewer with live reload (no upload, file stays on disk)
// ---------------------------------------------------------------------------

program
  .command('serve [file]')
  .description('serve a local HTML viewer over HTTP with live reload (no upload)')
  .argument('[file]', 'input file (defaults to stdin)')
  .option('-f, --from <format>', 'force input format')
  .option('-p, --port <port>', 'port to listen on', '8080')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .option('--no-open', 'do not auto-open the browser')
  .option('--no-watch', 'disable file watching / live reload')
  .action((file: string | undefined, ...rest: unknown[]) => {
    const opts = getOpts(file, ...rest) as {
      from?: string;
      port?: string;
      host?: string;
      open?: boolean;
      watch?: boolean;
    };
    const port = Number.parseInt(opts.port || '8080', 10) || 8080;
    const host = opts.host || '127.0.0.1';
    const shouldOpen = opts.open !== false;
    const shouldWatch = opts.watch !== false;

    const htmlFor = (): string => {
      try {
        const { src } = readInput(file);
        const fmt = (opts.from as SupportedFormat) || detectFormat(src);
        const res = parse(src, { format: fmt });
        const plain = astToPlain(res.root);
        return buildOfflineHtml(JSON.stringify(plain, null, 2), fmt, res.nodeCount, shouldWatch);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `<!doctype html><meta charset="utf-8"><body style="font-family:monospace;padding:2rem;color:#b00"><h1>jsona: failed to read input</h1><pre>${escapeHtml(msg)}</pre></body>`;
      }
    };

    const clients = new Set<ServerResponse>();

    const server = createServer((req, res) => {
      try {
        const url = (req.url || '/').split('?')[0];
        if (shouldWatch && url === '/__jsona_live') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('retry: 1000\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        const html = htmlFor();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end(`jsona serve error: ${msg}`);
      }
    });

    const reload = () => {
      for (const c of clients) c.write('data: reload\n\n');
    };

    if (shouldWatch && file && file !== '-') {
      const watcher = watch(file, { persistent: false }, () => reload());
      watcher.on('error', () => {/* file may be transiently unavailable */});
    }

    server.listen(port, host, () => {
      const addr = `http://${host}:${port}/`;
      process.stderr.write(`[jsona] serving viewer at ${addr} (Ctrl+C to stop)\n`);
      if (shouldOpen) {
        try {
          openBrowser(addr);
        } catch {
          /* ignore */
        }
      }
    });

    const shutdown = () => {
      try { server.close(); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ---------------------------------------------------------------------------
// inspect — summarize a document without printing it
// ---------------------------------------------------------------------------

function topLevelType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (value && typeof value === 'object') return 'object';
  return typeof value;
}

program
  .command('inspect [file]')
  .description('summarize a document: format, type, key count, size (no output of the data)')
  .argument('[file]', 'input file (defaults to stdin)')
  .option('-f, --from <format>', 'force input format')
  .action((file: string | undefined, ...rest: unknown[]) => {
    const opts = getOpts(file, ...rest) as { from?: string };
    const { src, filename } = readInput(file);
    const fmt = (opts.from as SupportedFormat) || detectFormat(src);
    const res = parse(src, { format: fmt });
    const plain = astToPlain(res.root);
    const size = src.length;
    const type = topLevelType(plain);
    const keyCount = plain && typeof plain === 'object' && !Array.isArray(plain)
      ? Object.keys(plain as Record<string, unknown>).length
      : Array.isArray(plain)
        ? plain.length
        : 0;
    process.stdout.write(
      [
        `format: ${fmt}`,
        `type: ${type}`,
        `keys: ${keyCount}`,
        `nodes: ${res.nodeCount}`,
        `bytes: ${size}`,
        `source: ${filename}`,
      ].join('\n') + '\n',
    );
  });

// ---------------------------------------------------------------------------
// mcp — run jsona as a Model Context Protocol server over stdio
// ---------------------------------------------------------------------------

program
  .command('mcp')
  .description('run jsona as a Model Context Protocol (MCP) server (stdio, HTTP+SSE, OAuth HTTP, or WebSocket)')
  .option('--http', 'run over MCP Streamable HTTP transport (remote agents)')
  .option('--auth', 'protect the HTTP endpoint with the SDK OAuth 2.1 flow (implies --http)')
  .option('--ws', 'run over WebSocket transport (subprotocol: mcp)')
  .option('--port <port>', 'port for --http/--ws (default 3939)', parsePort)
  .option('--host <host>', 'bind host (default 127.0.0.1; use 0.0.0.0 to expose)', '127.0.0.1')
  .option('--oauth-state-file <path>', 'file storing OAuth clients/tokens/signing key (default ~/.jsona/oauth.json)')
  .option('--issuer-url <url>', 'issuer URL for OAuth metadata (default http://<host>:<port>)')
  .option('--manifest', 'print the tool catalog as JSON and exit (no server)')
  .action((...rest: unknown[]) => {
    const opts = getOpts(...rest) as {
      http?: boolean;
      auth?: boolean;
      ws?: boolean;
      port?: number;
      host?: string;
      oauthStateFile?: string;
      issuerUrl?: string;
      manifest?: boolean;
    };
    if (opts.manifest) {
      void import('./mcp.js').then((m) => m.printManifest());
      return;
    }
    const base = { port: opts.port, host: opts.host };
    if (opts.ws) {
      void import('./mcp.js').then((m) => m.runWsMcpServer(base));
      return;
    }
    if (opts.auth) {
      void import('./mcp.js').then((m) =>
        m.runAuthHttpMcpServer({
          ...base,
          stateFile: opts.oauthStateFile,
          issuerUrl: opts.issuerUrl,
        }),
      );
      return;
    }
    if (opts.http) {
      void import('./mcp.js').then((m) => m.runHttpMcpServer(base));
      return;
    }
    // The server owns stdio until stdin closes (MCP client lifecycle).
    void import('./mcp.js').then((m) => m.runMcpServer());
  });

function buildOfflineHtml(source: string, format: string, nodeCount: number, liveReload = false): string {
  const liveScript = liveReload
    ? `<script>
const es = new EventSource('/__jsona_live');
es.onmessage = (e) => { if (e.data === 'reload') location.reload(); };
es.onerror = () => {/* server closed; ignore */};
</script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>jsona · offline viewer</title>
<style>
  :root { --bg:#0d1117; --fg:#c9d1d9; --muted:#8b949e; --accent:#58a6ff; --key:#79c0ff; --str:#a5d6ff; --num:#f0883e; --bool:#d2a8ff; --border:#21262d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; }
  header { padding:12px 16px; border-bottom:1px solid var(--border); display:flex; gap:12px; align-items:center; }
  header h1 { font-size:14px; margin:0; color:var(--accent); }
  header .meta { color:var(--muted); font-size:12px; }
  .toolbar { padding:8px 16px; border-bottom:1px solid var(--border); display:flex; gap:16px; }
  .toolbar label { color:var(--muted); font-size:12px; cursor:pointer; user-select:none; }
  #search { background:#010409; border:1px solid var(--border); color:var(--fg); border-radius:6px; padding:4px 8px; font:inherit; flex:1; max-width:280px; }
  main { display:flex; height:calc(100vh - 96px); }
  .tree { flex:1; overflow:auto; padding:8px 12px; }
  .src { flex:1; overflow:auto; padding:8px 12px; border-left:1px solid var(--border); }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; }
  .node { padding-left:14px; position:relative; }
  .node > .row { cursor:pointer; padding:1px 0; }
  .node > .row:hover { background:rgba(88,166,255,0.08); }
  .caret { display:inline-block; width:12px; color:var(--muted); }
  .key { color:var(--key); }
  .string { color:var(--str); }
  .number { color:var(--num); }
  .boolean { color:var(--bool); }
  .collapsed > .children { display:none; }
  .hidden { display:none; }
  .note { color:var(--muted); padding:12px 16px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>jsona</h1>
  <span class="meta">${escapeHtml(format)} · ${nodeCount} nodes</span>
  <span class="meta">generated locally · no data uploaded</span>
</header>
<div class="toolbar">
  <input id="search" placeholder="filter keys / values…" />
  <label><input type="checkbox" id="expandAll"> expand all</label>
</div>
<main>
  <div class="tree" id="tree"></div>
  <div class="src"><pre>${escapeHtml(source)}</pre></div>
</main>
<script>
const data = ${source};
const tree = document.getElementById('tree');
function render(value, key, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'node';
  const row = document.createElement('div');
  row.className = 'row';
  const isObj = value && typeof value === 'object';
  const hasChildren = isObj && Object.keys(value).length > 0;
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = hasChildren ? '▾' : '';
  row.appendChild(caret);
  if (key !== undefined) {
    const k = document.createElement('span'); k.className='key'; k.textContent = key + ': '; row.appendChild(k);
  }
  if (!isObj) {
    const v = document.createElement('span');
    v.className = typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean';
    v.textContent = typeof value === 'string' ? JSON.stringify(value) : String(value);
    row.appendChild(v);
  } else {
    const v = document.createElement('span');
    v.className = 'muted';
    v.textContent = Array.isArray(value) ? '[ … ]' : '{ … }';
    row.appendChild(v);
  }
  wrap.appendChild(row);
  if (hasChildren) {
    const kids = document.createElement('div');
    kids.className = 'children';
    for (const k of Object.keys(value)) kids.appendChild(render(value[k], k, depth+1));
    wrap.appendChild(kids);
    row.onclick = () => wrap.classList.toggle('collapsed');
  }
  return wrap;
}
tree.appendChild(render(data, undefined, 0));
document.getElementById('expandAll').onchange = (e) => {
  tree.querySelectorAll('.node').forEach(n => { if (e.target.checked) n.classList.remove('collapsed'); else if (n.querySelector('.children')) n.classList.add('collapsed'); });
};
document.getElementById('search').oninput = (e) => {
  const q = e.target.value.toLowerCase();
  tree.querySelectorAll('.node').forEach(n => {
    const text = n.textContent.toLowerCase();
    n.classList.toggle('hidden', q && !text.includes(q));
  });
};
</script>
${liveScript}
</body>
</html>`;
}

// Auto-prepend `query` so `jsona '.expr' file` works without an explicit
// subcommand (avoids option-flag collisions between the root and subcommands).
const SUBCOMMANDS = new Set(['query', 'format', 'minify', 'sort', 'diff', 'web', 'serve', 'inspect', 'mcp']);
const rawArgs = process.argv.slice(2);
const firstToken = rawArgs.find((a) => !a.startsWith('-'));
if (!firstToken || !SUBCOMMANDS.has(firstToken)) {
  process.argv.splice(2, 0, 'query');
}

program.parse();
