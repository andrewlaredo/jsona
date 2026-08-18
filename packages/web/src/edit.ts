// Surgical, format-agnostic source editing helpers.
//
// Every scalar leaf produced by the parsers carries the exact [start, end)
// offsets of its literal in the source text. Rewriting a value is therefore a
// plain string splice: everything outside the span (comments, whitespace,
// key order, the original formatting style) is preserved byte for byte.

import type { JsonNode, SupportedFormat } from 'jsona-core';

/** True when the node's value can be edited in place via source offsets. */
export function isEditable(node: JsonNode): boolean {
  return (
    node.kind !== 'object' &&
    node.kind !== 'array' &&
    typeof node.start === 'number' &&
    typeof node.end === 'number'
  );
}

/** The raw literal text of a node as it appears in the source. */
export function rawSlice(source: string, node: JsonNode): string {
  if (typeof node.start !== 'number' || typeof node.end !== 'number') return '';
  return source.slice(node.start, node.end);
}

/**
 * Render a user-typed value as a literal for the target format.
 *
 * The input is interpreted loosely: `true` / `false` / `null` and numeric text
 * become bare literals; anything else becomes a quoted string (with correct
 * escaping for the format).
 */
export function toLiteral(input: string, format: SupportedFormat | 'auto'): string {
  const t = input.trim();
  if (t === 'true' || t === 'false' || t === 'null') return t;
  if (t !== '' && Number.isFinite(Number(t)) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    return t;
  }
  if (format === 'csv') {
    // CSV: quote only when needed, doubling embedded quotes.
    return /[",\n\r]/.test(input) ? `"${input.split('"').join('""')}"` : input;
  }
  // JSON / YAML / TOML all accept JSON-style double-quoted strings.
  return JSON.stringify(input);
}

/**
 * Replace a node's literal in the source text.
 * Returns the new full source, or null when the node is not editable.
 */
export function replaceNodeValue(
  source: string,
  node: JsonNode,
  input: string,
  format: SupportedFormat | 'auto',
): string | null {
  if (!isEditable(node)) return null;
  const literal = toLiteral(input, format);
  return source.slice(0, node.start) + literal + source.slice(node.end);
}

/** Human-friendly display text for a node's current value. */
export function displayValue(node: JsonNode): string {
  if (node.kind === 'object') return `{${node.children?.length ?? 0}}`;
  if (node.kind === 'array') return `[${node.children?.length ?? 0}]`;
  if (node.value === null || node.value === undefined) return 'null';
  return String(node.value);
}

/** The text seeded into an inline editor (unquoted for strings). */
export function editSeed(node: JsonNode): string {
  if (node.value === null || node.value === undefined) return '';
  return String(node.value);
}

/**
 * Copy text to the clipboard, falling back to a hidden textarea when the
 * async Clipboard API is unavailable (non-secure origins, older browsers).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Serialize a node (and its subtree) back to pretty JSON for copying. */
export function nodeToJson(node: JsonNode): string {
  const walk = (n: JsonNode): unknown => {
    if (n.kind === 'object') {
      const o: Record<string, unknown> = {};
      for (const c of n.children ?? []) o[c.key as string] = walk(c);
      return o;
    }
    if (n.kind === 'array') return (n.children ?? []).map(walk);
    return n.value ?? null;
  };
  return JSON.stringify(walk(node), null, 2);
}
