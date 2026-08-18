import type { JsonNode, ParseOptions, ParseResult, SupportedFormat } from './types.js';
import { parse } from './index.js';
import { stringify as yamlStringify } from 'yaml';

/** Convert a unified AST node back into a plain JS value. */
export function astToPlain(node: JsonNode): unknown {
  if (node.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const c of node.children ?? []) out[c.key as string] = astToPlain(c);
    return out;
  }
  if (node.kind === 'array') {
    return (node.children ?? []).map((c) => astToPlain(c));
  }
  return node.value ?? null;
}

/** Recursively sort object keys alphabetically (arrays preserve order). */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Pretty-print JSON source with 2-space indentation (parse -> re-stringify). */
export function formatJson(source: string, options?: ParseOptions): string {
  return JSON.stringify(astToPlain(parse(source, options).root), null, 2);
}

/** Minify JSON source to a single compact line. */
export function minifyJson(source: string, options?: ParseOptions): string {
  return JSON.stringify(astToPlain(parse(source, options).root));
}

/** Re-serialize a parsed result back to a normalized JSON string. */
export function shapeToJson(
  result: ParseResult,
  options: { pretty?: boolean; sort?: boolean } = {},
): string {
  const { pretty = true, sort = false } = options;
  let value: unknown = astToPlain(result.root);
  if (sort) value = sortKeys(value);
  return JSON.stringify(value, null, pretty ? 2 : 0);
}

/** Serialize a plain JS value into a TOML string (lightweight, covers the
 *  common primitive / object / array cases produced by our AST). */
function valueToToml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    // Inline array (TOML supports only single typed/uniform arrays well).
    return '[' + value.map((v) => valueToToml(v)).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const scalar: string[] = [];
    const tables: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      const isNested = v !== null && typeof v === 'object' && !(Array.isArray(v) && v.every((i) => typeof i !== 'object'));
      if (isNested) {
        tables.push(`${pad}[${JSON.stringify(k)}]\n${valueToToml(v, indent + 1)}`);
      } else {
        scalar.push(`${pad}${JSON.stringify(k)} = ${valueToToml(v, indent)}`);
      }
    }
    return [...scalar, ...tables].join('\n');
  }
  return JSON.stringify(String(value));
}

/** Serialize a plain JS value into a CSV string.
 *  - array of objects -> header row + one row per object
 *  - object -> key,value rows
 *  Falls back to empty string when the shape is not tabular. */
function valueToCsv(value: unknown): string {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  if (Array.isArray(value) && value.length > 0 && value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    const rows = value as Record<string, unknown>[];
    const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const lines = [headers.map((h) => escape(h)).join(',')];
    for (const r of rows) {
      lines.push(headers.map((h) => escape(String(r[h] ?? ''))).join(','));
    }
    return lines.join('\n');
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const lines = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      [escape(k), escape(String(v ?? ''))].join(','),
    );
    return lines.join('\n');
  }
  return '';
}

const MIME: Record<SupportedFormat, string> = {
  json: 'application/json',
  yaml: 'text/yaml',
  toml: 'text/toml',
  csv: 'text/csv',
};

/** Serialize an AST node into the requested format's text representation.
 *  Returns the text plus the proper MIME type for download. */
export function astToFormat(node: JsonNode, format: SupportedFormat): { text: string; mime: string } {
  const plain = astToPlain(node);
  switch (format) {
    case 'yaml':
      return { text: yamlStringify(plain), mime: MIME.yaml };
    case 'toml':
      return { text: valueToToml(plain), mime: MIME.toml };
    case 'csv': {
      const csv = valueToCsv(plain);
      return { text: csv || JSON.stringify(plain, null, 2), mime: csv ? MIME.csv : MIME.json };
    }
    case 'json':
    default:
      return { text: JSON.stringify(plain, null, 2), mime: MIME.json };
  }
}

/** Extension + MIME for a download, based on the chosen/auto-detected format. */
export function downloadMeta(format: SupportedFormat): { ext: string; mime: string } {
  return { ext: format, mime: MIME[format] };
}
