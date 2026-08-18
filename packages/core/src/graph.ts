import type { JsonNode } from './types.js';

export interface GraphNode {
  id: string;
  /** Display label (key or [i] or root). */
  label: string;
  kind: JsonNode['kind'];
  /** Leaf value preview (truncated) for scalar nodes. */
  value?: string;
  depth: number;
  path?: string;
  /** Source offset range (JSON only). */
  start?: number;
  end?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Walk the AST and build a flat node/edge list with depth + labels. */
export function buildGraph(root: JsonNode): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const walk = (node: JsonNode, depth: number) => {
    const label =
      node.key === undefined ? '(root)' : node.kind === 'array' ? `[${node.key}]` : node.key;
    let value: string | undefined;
    if (node.kind !== 'object' && node.kind !== 'array') {
      const v = node.value === null ? 'null' : String(node.value);
      value = v.length > 24 ? v.slice(0, 24) + '…' : v;
    }
    nodes.push({
      id: node.id,
      label,
      kind: node.kind,
      value,
      depth,
      path: node.path,
      start: node.start,
      end: node.end,
    });
    for (const ch of node.children ?? []) {
      edges.push({ source: node.id, target: ch.id });
      walk(ch, depth + 1);
    }
  };
  walk(root, 0);
  return { nodes, edges };
}

export interface SampleResult {
  graph: Graph;
  /** Number of nodes pruned away by sampling. */
  dropped: number;
  /** True when sampling was applied (> threshold). */
  sampled: boolean;
}

/**
 * Deterministic depth-limited sampling.
 * - nodeCount > maxNodes: keep only the first `maxDepth` levels (root = 0).
 * - Deterministic: always the same result for the same input (no randomness).
 * This guarantees large graphs stay renderable without ever "randomly" dropping
 * meaningful structure (per product decision: never random sampling).
 */
export function sampleForGraph(
  graph: Graph,
  totalNodeCount: number,
  opts: { maxNodes?: number; maxDepth?: number } = {},
): SampleResult {
  const maxNodes = opts.maxNodes ?? 500;
  const maxDepth = opts.maxDepth ?? 3;
  if (totalNodeCount <= maxNodes) {
    return { graph, dropped: 0, sampled: false };
  }
  const keptIds = new Set(graph.nodes.filter((n) => n.depth <= maxDepth).map((n) => n.id));
  const nodes = graph.nodes.filter((n) => keptIds.has(n.id));
  const edges = graph.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
  return { graph: { nodes, edges }, dropped: totalNodeCount - nodes.length, sampled: true };
}

export type DiffOp = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffEntry {
  path: string;
  op: DiffOp;
  /** Present in A. */
  a?: JsonNode;
  /** Present in B. */
  b?: JsonNode;
}

/**
 * Structural diff of two parsed roots by path.
 * Compares kind + value; object/array compared by child paths (not recursively
 * counted as changed unless a child differs). Returns a flat list keyed by path.
 */
export function diffTrees(aRoot: JsonNode, bRoot: JsonNode): DiffEntry[] {
  const out: DiffEntry[] = [];
  const aMap = new Map<string, JsonNode>();
  const bMap = new Map<string, JsonNode>();
  const collect = (node: JsonNode, map: Map<string, JsonNode>) => {
    if (node.path) map.set(node.path, node);
    for (const ch of node.children ?? []) collect(ch, map);
  };
  collect(aRoot, aMap);
  collect(bRoot, bMap);

  const paths = new Set([...aMap.keys(), ...bMap.keys()]);
  // Stable order: by path segments length then lexicographic.
  const sorted = [...paths].sort((p, q) => {
    const dp = p.split(/[.[]/).length;
    const dq = q.split(/[.[]/).length;
    if (dp !== dq) return dp - dq;
    return p < q ? -1 : p > q ? 1 : 0;
  });

  for (const path of sorted) {
    const a = aMap.get(path);
    const b = bMap.get(path);
    if (a && !b) out.push({ path, op: 'removed', a });
    else if (!a && b) out.push({ path, op: 'added', b });
    else if (a && b) {
      const aLeaf = a.kind !== 'object' && a.kind !== 'array';
      const bLeaf = b.kind !== 'object' && b.kind !== 'array';
      const changed =
        a.kind !== b.kind ||
        (aLeaf && bLeaf && String(a.value) !== String(b.value));
      out.push({ path, op: changed ? 'changed' : 'unchanged', a, b });
    }
  }
  return out;
}
