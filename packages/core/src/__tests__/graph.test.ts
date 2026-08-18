import { describe, it, expect } from 'vitest';
import { parse, buildGraph, sampleForGraph, diffTrees } from '../index.js';

describe('buildGraph', () => {
  it('produces nodes/edges with depth and labels', () => {
    const { root } = parse('{"a":1,"b":{"c":[2,3]}}');
    const g = buildGraph(root);
    expect(g.nodes.length).toBe(6); // root + a + b + b.c + [0] + [1]
    expect(g.edges.length).toBe(5);
    const rootNode = g.nodes.find((n) => n.label === '(root)')!;
    expect(rootNode.depth).toBe(0);
    const c = g.nodes.find((n) => n.label === '[c]')!;
    expect(c.depth).toBe(2);
    const arr0 = g.nodes.find((n) => n.label === '0')!;
    expect(arr0.depth).toBe(3);
  });
});

describe('sampleForGraph (deterministic depth sampling)', () => {
  it('does not sample when under threshold', () => {
    const { root } = parse('{"a":1,"b":2}');
    const g = buildGraph(root);
    const r = sampleForGraph(g, g.nodes.length);
    expect(r.sampled).toBe(false);
    expect(r.dropped).toBe(0);
  });

  it('keeps only first N levels when over threshold, deterministically', () => {
    // Build a deep tree with > 500 nodes.
    const make = (depth: number): unknown =>
      depth === 0 ? { leaf: 1 } : Array.from({ length: 4 }, () => make(depth - 1));
    const big = JSON.stringify({ root: make(5) }); // 4^5=1024 leaf objects
    const { root } = parse(big);
    const g = buildGraph(root);
    const total = g.nodes.length;
    expect(total).toBeGreaterThan(500);
    const r = sampleForGraph(g, total, { maxNodes: 500, maxDepth: 3 });
    expect(r.sampled).toBe(true);
    expect(r.dropped).toBeGreaterThan(0);
    // All kept nodes are within depth <= 3.
    expect(r.graph.nodes.every((n) => n.depth <= 3)).toBe(true);
    // Deterministic: same input -> same dropped count.
    const r2 = sampleForGraph(g, total, { maxNodes: 500, maxDepth: 3 });
    expect(r2.dropped).toBe(r.dropped);
  });
});

describe('diffTrees', () => {
  it('detects added / removed / changed / unchanged', () => {
    const a = parse('{"x":1,"y":2,"z":{"k":3}}');
    const b = parse('{"x":1,"y":9,"w":4}');
    const diff = diffTrees(a.root, b.root);
    const byPath = Object.fromEntries(diff.map((d) => [d.path, d.op]));
    expect(byPath['x']).toBe('unchanged');
    expect(byPath['y']).toBe('changed');
    expect(byPath['z']).toBe('removed');
    expect(byPath['w']).toBe('added');
  });

  it('orders by depth then path', () => {
    const a = parse('{"a":1,"b":{"c":2}}');
    const b = parse('{"a":1,"b":{"c":2}}');
    const diff = diffTrees(a.root, b.root);
    const idxA = diff.findIndex((d) => d.path === 'a');
    const idxB = diff.findIndex((d) => d.path === 'b.c');
    expect(idxA).toBeLessThan(idxB);
  });
});
