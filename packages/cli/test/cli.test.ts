import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpGet } from 'node:http';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'index.js');

function run(args: string[], input?: string): string {
  return execFileSync('node', [CLI, ...args], {
    input,
    encoding: 'utf8',
    cwd: join(__dirname, '..'),
  });
}

const SAMPLE = `{
  "name": "demo",
  "version": "1.2.3",
  "nested": { "b": 2, "a": 1, "deep": { "z": true, "y": null } },
  "items": [ { "id": 1, "label": "first" }, { "id": 2, "label": "second" } ],
  "tags": ["x", "y", "z"],
  "ratio": 0.5,
  "active": true
}`;

describe('jsona CLI', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error('CLI not built. Run `pnpm --filter @jsona/cli build` first.');
    }
    dir = mkdtempSync(join(tmpdir(), 'jsona-cli-'));
    file = join(dir, 'sample.json');
    writeFileSync(file, SAMPLE);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('format -> pretty JSON (default)', () => {
    const out = run(['format', file]);
    expect(out).toContain('"name": "demo"');
    expect(out).toContain('\n  "version"');
  });

  it('minify produces single-line JSON', () => {
    const out = run(['minify', file]);
    expect(out.trim().startsWith('{')).toBe(true);
    expect(out.includes('\n  ')).toBe(false);
  });

  it('sort subcommand orders keys alphabetically', () => {
    const out = run(['sort', file]);
    const iName = out.indexOf('"name"');
    const iVersion = out.indexOf('"version"');
    expect(iName).toBeGreaterThan(-1);
    expect(iVersion).toBeGreaterThan(-1);
    expect(iVersion).toBeGreaterThan(iName);
  });

  it('format -o toml produces valid TOML with tables', () => {
    const out = run(['format', file, '-o', 'toml']);
    expect(out).toContain('name = "demo"');
    expect(out).toContain('[nested]');
    expect(out).toContain('[[items]]');
    expect(out).toContain('id = 1');
  });

  it('format -o yaml produces YAML', () => {
    const out = run(['format', file, '-o', 'yaml']);
    expect(out).toContain('name: demo');
    expect(out).toContain('version: 1.2.3');
  });

  it('format -o csv produces CSV', () => {
    const out = run(['format', file, '-o', 'csv']);
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it('diff of identical file reports 0 changes', () => {
    const out = run(['diff', file, file]);
    expect(out).toContain('0 added');
    expect(out).toContain('0 removed');
    expect(out).toContain('0 changed');
  });

  it('diff detects added/removed keys', () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeFileSync(a, JSON.stringify({ x: 1, y: 2 }));
    writeFileSync(b, JSON.stringify({ x: 1, z: 3 }));
    const out = run(['diff', a, b]);
    expect(out).toContain('1 added');
    expect(out).toContain('1 removed');
  });

  it('web generates a standalone HTML file', () => {
    const outHtml = join(dir, 'out.html');
    run(['web', file, '-o', outHtml]);
    const html = readFileSync(outHtml, 'utf8');
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html.toLowerCase()).toContain('demo');
  });

  it('inspect reports key count and top-level type', () => {
    const out = run(['inspect', file]);
    expect(out).toContain('keys: 7');
    expect(out).toContain('type: object');
  });

  it('handles stdin via input flag/pipe', () => {
    const out = run(['format', '-'], SAMPLE);
    expect(out).toContain('"name": "demo"');
  });
});

describe('jsona serve', () => {
  const PORT = 9876;
  const HOST = '127.0.0.1';
  let dir: string;
  let file: string;
  let child: ReturnType<typeof spawn> | null = null;

  function fetchHtml(): Promise<string> {
    return new Promise((resolve, reject) => {
      httpGet(`http://${HOST}:${PORT}/`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  }

  function waitForServer(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    const tick = (): Promise<void> =>
      fetchHtml()
        .then(() => undefined)
        .catch((e) => {
          if (Date.now() - start > timeoutMs) throw e;
          return new Promise((r) => setTimeout(r, 100)).then(tick);
        });
    return tick();
  }

  beforeAll(async () => {
    if (!existsSync(CLI)) {
      throw new Error('CLI not built. Run `pnpm --filter @jsona/cli build` first.');
    }
    dir = mkdtempSync(join(tmpdir(), 'jsona-serve-'));
    file = join(dir, 'sample.json');
    writeFileSync(file, SAMPLE);
    child = spawn('node', [CLI, 'serve', file, '--port', String(PORT), '--host', HOST, '--no-open'], {
      cwd: join(__dirname, '..'),
      stdio: 'ignore',
    });
    await waitForServer();
  });

  afterAll(() => {
    if (child) child.kill('SIGTERM');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('serves a standalone HTML viewer over HTTP', async () => {
    const html = await fetchHtml();
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('demo');
  });
});
