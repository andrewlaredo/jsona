// Reverse location: map a source offset back to the AST node that covers it.

import type { JsonNode } from 'jsona-core';

/**
 * Find the deepest node whose [start, end) span contains the offset.
 *
 * Descends greedily: a child always wins over its parent, so the result is the
 * most specific node under the caret. Nodes without offsets are skipped but
 * their children are still searched.
 */
export function nodeAtOffset(root: JsonNode, offset: number): JsonNode | null {
  let best: JsonNode | null = null;

  const covers = (n: JsonNode) =>
    typeof n.start === 'number' &&
    typeof n.end === 'number' &&
    offset >= n.start &&
    offset <= n.end;

  const walk = (n: JsonNode) => {
    if (covers(n)) best = n;
    for (const c of n.children ?? []) {
      // Prune subtrees that cannot contain the offset.
      if (
        typeof c.start === 'number' &&
        typeof c.end === 'number' &&
        (offset < c.start || offset > c.end)
      ) {
        continue;
      }
      walk(c);
    }
  };

  walk(root);
  return best;
}

/** Collect the ids of every ancestor of `id` (so callers can expand them). */
export function ancestorIds(root: JsonNode, id: string): string[] {
  const stack: string[] = [];
  let found: string[] = [];
  const walk = (n: JsonNode): boolean => {
    if (n.id === id) {
      found = [...stack];
      return true;
    }
    stack.push(n.id);
    for (const c of n.children ?? []) {
      if (walk(c)) return true;
    }
    stack.pop();
    return false;
  };
  walk(root);
  return found;
}
