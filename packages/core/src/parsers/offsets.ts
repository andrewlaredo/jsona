import type { JsonNode } from '../types.js';

// Best-effort source-offset backfill for value-derived ASTs (YAML / TOML / CSV),
// where the parsing libraries don't hand us byte positions. We walk the AST and
// scan the original source to locate each key and scalar literal, then stamp
// start/end offsets so the tree <-> source highlight works for these formats too.
//
// This is intentionally tolerant: any node we can't locate simply keeps
// undefined offsets (highlight becomes a no-op for it), so a missing match never
// breaks parsing or the tree.

function findIgnoringCase(haystack: string, needle: string, from: number): number {
  if (needle === '') return from;
  const hi = haystack.toLowerCase();
  const ne = needle.toLowerCase();
  return hi.indexOf(ne, from);
}

/**
 * Backfill offsets for an AST produced without source positions.
 * `startHint` lets callers constrain the scan window (parent's range).
 */
export function backfillOffsets(root: JsonNode, src: string): void {
  // For each top-level container, scan within the whole document; deeper nodes
  // are constrained by their parent's discovered range to avoid false matches.
  const scan = (node: JsonNode, winStart: number, winEnd: number) => {
    const children = node.children ?? [];
    let cursor = winStart;
    for (const child of children) {
      // Locate the key text (if any) then the value literal after it.
      let keyStart = -1;
      if (child.key !== undefined && node.kind === 'object') {
        keyStart = findKeyInWindow(src, String(child.key), cursor, winEnd);
      }
      const searchFrom = keyStart >= 0 ? keyStart + String(child.key).length : cursor;
      const lit = locateLiteral(src, child, searchFrom, winEnd);

      if (lit) {
        // Key node range (object key) = the key text span.
        if (node.kind === 'object' && child.key !== undefined && keyStart >= 0) {
          (child as JsonNode & { start?: number; end?: number }).start = keyStart;
          (child as JsonNode & { start?: number; end?: number }).end =
            keyStart + String(child.key).length;
        } else if (typeof child.start === 'number' && typeof child.end === 'number') {
          // already set (literal leaf) – keep
        }
        // Value range.
        if (lit.start >= 0) {
          (child as JsonNode & { start?: number; end?: number }).start = lit.start;
          (child as JsonNode & { start?: number; end?: number }).end = lit.end;
        }
        // Recurse into containers using the located window.
        const childWinStart = typeof child.start === 'number' ? child.start : searchFrom;
        const childWinEnd = typeof child.end === 'number' ? child.end : winEnd;
        scan(child, childWinStart, childWinEnd);
        // Advance past this child so siblings don't rematch the same text.
        cursor = typeof child.end === 'number' ? child.end : lit.end;
      } else {
        // Couldn't locate this child; still recurse loosely so descendants may match.
        scan(child, searchFrom, winEnd);
        cursor = searchFrom;
      }
    }
  };
  scan(root, 0, src.length);
}

/** Find a key token (optionally quoted) within [from, to). Returns its start or -1. */
function findKeyInWindow(src: string, key: string, from: number, to: number): number {
  const win = src.slice(from, to);
  // Try quoted first (handles keys with special chars).
  const quoted = JSON.stringify(key);
  let idx = findIgnoringCase(win, quoted, 0);
  if (idx >= 0) return from + idx;
  idx = findIgnoringCase(win, key, 0);
  if (idx >= 0) {
    // Make sure it's a standalone key token: preceded by start/space/newline/[/.
    const before = idx === 0 ? '' : win[idx - 1];
    if (before === '' || /\s|[\[{,]/.test(before)) return from + idx;
  }
  return -1;
}

/**
 * Locate the literal text of a scalar (or container bracket) for `node`
 * within [from, to). Returns {start, end} in absolute source offsets.
 */
function locateLiteral(
  src: string,
  node: JsonNode,
  from: number,
  to: number,
): { start: number; end: number } | null {
  if (node.kind === 'object') {
    const i = src.indexOf('{', from);
    const j = i >= 0 ? src.indexOf('}', i) : -1;
    if (i >= 0 && j >= 0 && j < to) return { start: i, end: j + 1 };
  }
  if (node.kind === 'array') {
    const i = src.indexOf('[', from);
    const j = i >= 0 ? src.indexOf(']', i) : -1;
    if (i >= 0 && j >= 0 && j < to) return { start: i, end: j + 1 };
  }
  // Scalars.
  const text = literalText(node);
  if (text === null) return null;
  const win = src.slice(from, to);
  let idx = findIgnoringCase(win, text, 0);
  if (idx >= 0) return { start: from + idx, end: from + idx + text.length };
  // Try bare (unquoted) for strings that were quoted in source.
  if (node.kind === 'string' && typeof node.value === 'string') {
    const bare = node.value;
    idx = findIgnoringCase(win, bare, 0);
    if (idx >= 0) return { start: from + idx, end: from + idx + bare.length };
  }
  return null;
}

/** The exact source text a scalar node should appear as. */
function literalText(node: JsonNode): string | null {
  switch (node.kind) {
    case 'string':
      return typeof node.value === 'string' ? JSON.stringify(node.value) : null;
    case 'number':
      return node.value === undefined || node.value === null ? null : String(node.value);
    case 'boolean':
      return node.value === true ? 'true' : node.value === false ? 'false' : null;
    case 'null':
      return 'null';
    default:
      return null;
  }
}
