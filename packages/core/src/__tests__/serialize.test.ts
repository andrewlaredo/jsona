import { describe, it, expect } from 'vitest';
import { parse, astToPlain, sortKeys, formatJson, minifyJson, shapeToJson } from '../index.js';

describe('serialize', () => {
  const src = `{
  "zeta": 1,
  "alpha": { "b": 2, "a": 1 },
  "list": [3, 1, 2]
}`;

  it('astToPlain reconstructs plain value', () => {
    const root = parse(src).root;
    expect(astToPlain(root)).toEqual({
      zeta: 1,
      alpha: { b: 2, a: 1 },
      list: [3, 1, 2],
    });
  });

  it('formatJson pretty-prints', () => {
    const out = formatJson('{"a":1,"b":[1,2]}');
    expect(out).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  });

  it('minifyJson compacts', () => {
    expect(minifyJson('{\n  "a": 1\n}')).toBe('{"a":1}');
  });

  it('sortKeys sorts nested objects alphabetically, arrays untouched', () => {
    const sorted = sortKeys(astToPlain(parse(src).root));
    expect(Object.keys(sorted as Record<string, unknown>)).toEqual(['alpha', 'list', 'zeta']);
    expect(Object.keys((sorted as any).alpha)).toEqual(['a', 'b']);
    expect((sorted as any).list).toEqual([3, 1, 2]);
  });

  it('shapeToJson supports sort option', () => {
    const out = shapeToJson(parse(src), { pretty: true, sort: true });
    // keys must appear alphabetically: alpha, list, zeta
    const idxAlpha = out.indexOf('"alpha"');
    const idxList = out.indexOf('"list"');
    const idxZeta = out.indexOf('"zeta"');
    expect(idxAlpha).toBeLessThan(idxList);
    expect(idxList).toBeLessThan(idxZeta);
  });
});
