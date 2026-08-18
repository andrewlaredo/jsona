import type { JsonNode, NodeKind } from '../types.js';

// Convert a plain JS value (from YAML/TOML/CSV libs) into a unified AST.
// Offsets are not available for these formats via the libraries, so we leave
// start/end undefined; JSON (json.ts) provides offsets. Graph/Tree alignment
// for YAML/TOML still works via path, just without source-highlight.

let counter = 0;
function resetCounter() {
  counter = 0;
}

function kindOf(value: unknown): NodeKind {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'object':
      return Array.isArray(value) ? 'array' : 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'null';
  }
}

export function valueToAst(value: unknown, key?: string): JsonNode {
  const kind = kindOf(value);
  const id = `n${counter++}`;
  if (kind === 'object') {
    const obj = value as Record<string, unknown>;
    const children = Object.keys(obj).map((k) => valueToAst(obj[k], k));
    return { id, kind, key, children };
  }
  if (kind === 'array') {
    const arr = value as unknown[];
    const children = arr.map((v, i) => valueToAst(v, String(i)));
    return { id, kind, key, children };
  }
  return { id, kind, key, value: value as string | number | boolean | null };
}

export function valueToAstRoot(value: unknown): JsonNode {
  resetCounter();
  return valueToAst(value, undefined);
}
