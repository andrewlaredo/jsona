import { JsonaParseError, type JsonNode, type ParseOptions, type ParseResult, type SupportedFormat } from './types.js';
import { parseJson, JsonSyntaxError, collectJsonErrors } from './parsers/json.js';
import { parseYamlToAst } from './parsers/yaml.js';
import { parseTomlToAst } from './parsers/toml.js';
import { parseCsvToAst } from './parsers/csv.js';
import { backfillOffsets } from './parsers/offsets.js';

export * from './types.js';
export { parseJson, tokenize, collectJsonErrors } from './parsers/json.js';
export { astToPlain, sortKeys, formatJson, minifyJson, shapeToJson, astToFormat, downloadMeta } from './serialize.js';
export { buildGraph, sampleForGraph, diffTrees } from './graph.js';
export type { Graph, GraphNode, GraphEdge, SampleResult, DiffEntry, DiffOp } from './graph.js';
export { parseYamlToAst } from './parsers/yaml.js';
export { parseTomlToAst } from './parsers/toml.js';
export { parseCsvToAst } from './parsers/csv.js';

const FORMAT_LABELS: Record<SupportedFormat, string> = {
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  csv: 'CSV',
};

/** Best-effort format detection from raw text. */
export function detectFormat(src: string): SupportedFormat {
  const s = src.trimStart();
  // TOML: a "[section]" table header (no comma inside, followed by newline) or top-level "key = value"
  if (/^\[[^\],\s]+\]\s*(\n|$)/.test(s) || /^\w[\w.\-]*\s*=/.test(s)) return 'toml';
  // JSON: object or array literal
  if (s.startsWith('{') || s.startsWith('[')) return 'json';
  // YAML: document marker, "key:" mapping, or list "-" items
  if (/^---/.test(s) || /^\s*[\w\-]+\s*:/.test(s) || /^-\s+/.test(s)) return 'yaml';
  // CSV: comma + newline in the first few lines
  const firstLines = s.split('\n', 3).join('\n');
  if (/,/.test(firstLines) && /\n/.test(firstLines)) return 'csv';
  return 'json';
}

/** A CSV parse is only trustworthy when the text actually looks tabular
 *  (multiple lines + a delimiter), otherwise papaparse will happily swallow
 *  any text as a single row and we'd mask a real error from another format. */
function looksLikeCsv(clean: string): boolean {
  const firstLines = clean.trim().split('\n', 3).join('\n');
  return /,/.test(firstLines) && /\n/.test(firstLines);
}

function countNodes(node: JsonNode): number {
  let c = 1;
  if (node.children) for (const ch of node.children) c += countNodes(ch);
  return c;
}

/** Parse with one specific format. Throws on failure. */
function parseWith(format: SupportedFormat, src: string, clean: string, options?: ParseOptions): JsonNode {
  switch (format) {
    case 'json':
      try {
        return parseJson(clean);
      } catch (e) {
        const msg = (e as Error).message ?? 'JSON 语法有误';
        // When the input smells like JSON, collect ALL diagnostics (not just the
        // first) using jsonc-parser — this powers multi-marker underlines like
        // VS Code / Monaco. For non-JSON-looking text we keep the single error.
        if (/^\s*[[{]/.test(clean)) {
          const errors = collectJsonErrors(clean).map((er) => ({ ...er, severity: 'error' as const }));
          const first = errors[0];
          throw new JsonaParseError(
            msg,
            'json',
            e,
            first?.line ?? undefined,
            first?.column ?? undefined,
            errors,
          );
        }
        if (e instanceof JsonSyntaxError) {
          const { line, column } = offsetToLineCol(clean, e.offset);
          throw new JsonaParseError(msg, 'json', e, line, column);
        }
        throw new JsonaParseError(`JSON 语法有误：${msg}`, 'json', e);
      }
    case 'yaml':
      return parseYamlToAst(src);
    case 'toml':
      return parseTomlToAst(src);
    case 'csv':
      return parseCsvToAst(src, options);
    default:
      throw new JsonaParseError(`Unsupported format: ${format}`, format as SupportedFormat);
  }
}

/** Convert a 0-based source offset into 1-based (line, column) for UI display. */
function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  const clamped = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

/** Auto mode: parse with the detected format. If that fails, fall back to CSV
 *  — but only when the text is genuinely tabular (multiple lines + a
 *  delimiter). This prevents a real error in one format (e.g. a malformed
 *  JSON) from being silently swallowed by a lenient parser, while still
 *  rescuing the common case of an auto-detected CSV. */
function parseAuto(src: string, clean: string, options?: ParseOptions): ParseResult {
  const preferred = detectFormat(clean);
  let lastErr: unknown;
  try {
    const root = parseWith(preferred, src, clean, options);
    const nodeCount = countNodes(root);
    return { root, nodeCount, format: preferred, formatLabel: FORMAT_LABELS[preferred] };
  } catch (e) {
    lastErr = e;
  }
  // Fallback: only a trustworthy CSV can override the preferred format's error.
  if (preferred !== 'csv' && looksLikeCsv(clean)) {
    try {
      const root = parseWith('csv', src, clean, options);
      const nodeCount = countNodes(root);
      return { root, nodeCount, format: 'csv', formatLabel: FORMAT_LABELS.csv };
    } catch {
      /* fall through to the original error */
    }
  }
  throw lastErr instanceof JsonaParseError
    ? lastErr
    : new JsonaParseError('无法解析该文档', preferred);
}

/** Single entry point used by Web and CLI. */
export function parse(src: string, options?: ParseOptions): ParseResult {
  // Strip UTF-8 BOM (common in files exported from Excel/Windows tooling).
  let clean = src;
  const BOM = String.fromCharCode(0xfeff);
  if (clean.charAt(0) === BOM) clean = clean.slice(1);
  clean = clean.split(BOM).join('');

  if (options?.format) {
    const format = options.format;
    const root = parseWith(format, src, clean, options);
    annotatePaths(root, '');
    // JSON already carries real offsets from jsonc-parser; for YAML/TOML/CSV we
    // backfill best-effort offsets so tree <-> source highlight works everywhere.
    if (format !== 'json') backfillOffsets(root, clean);
    const nodeCount = countNodes(root);
    return { root, nodeCount, format, formatLabel: FORMAT_LABELS[format] };
  }

  const result = parseAuto(src, clean, options);
  const { root } = result;
  annotatePaths(root, '');
  if (result.format !== 'json') backfillOffsets(root, clean);
  return result;
}

/** Fill in the `path` field for every node (dot/bracket notation). */
export function annotatePaths(node: JsonNode, parentPath: string): void {
  if (node.key === undefined) {
    node.path = parentPath;
  } else if (parentPath === '') {
    // root-level key (object) uses bare key; array element uses [i]
    node.path = node.kind === 'array' ? `[${node.key}]` : node.key;
  } else {
    node.path = node.kind === 'array'
      ? `${parentPath}[${node.key}]`
      : `${parentPath}.${node.key}`;
  }
  if (node.children) {
    for (const ch of node.children) annotatePaths(ch, node.path ?? '');
  }
}

/** Query a value by dot/bracket path, jq-style (e.g. ".services.api.url"). */
export function queryPath(root: JsonNode, path: string): JsonNode | undefined {
  const cleaned = path.replace(/^\./, '');
  if (cleaned === '') return root;
  const parts = cleaned.split(/\.(?![^[]*\])/).flatMap((p) =>
    p.split(/\[(.*?)\]/).filter((x) => x !== ''),
  );
  let cur: JsonNode | undefined = root;
  for (const part of parts) {
    if (!cur?.children) return undefined;
    cur = cur.children.find((c) => c.key === part);
    if (!cur) return undefined;
  }
  return cur;
}
