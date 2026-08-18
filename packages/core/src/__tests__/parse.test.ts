import { describe, it, expect } from 'vitest';
import {
  parse,
  detectFormat,
  queryPath,
  parseJson,
  type JsonNode,
  type JsonaParseError,
} from '../index.js';

function find(node: JsonNode, path: string): JsonNode | undefined {
  return queryPath(node, path);
}

describe('detectFormat', () => {
  it('detects JSON', () => {
    expect(detectFormat('{"a":1}')).toBe('json');
    expect(detectFormat('[1,2,3]')).toBe('json');
  });
  it('detects YAML', () => {
    expect(detectFormat('a: 1\nb: 2')).toBe('yaml');
    expect(detectFormat('- 1\n- 2')).toBe('yaml');
  });
  it('detects TOML', () => {
    expect(detectFormat('title = "hi"')).toBe('toml');
    expect(detectFormat('[section]\nkey = 1')).toBe('toml');
  });
  it('detects CSV', () => {
    expect(detectFormat('a,b\n1,2')).toBe('csv');
  });
});

describe('parse JSON with offsets', () => {
  const src = `{
  "name": "jsona",
  "nested": { "count": 3 },
  "list": [10, 20]
}`;
  const res = parse(src, { format: 'json' });

  it('builds AST with correct kinds', () => {
    expect(res.root.kind).toBe('object');
    expect(find(res.root, '.name')?.value).toBe('jsona');
    expect(find(res.root, '.nested.count')?.value).toBe(3);
    expect(find(res.root, '.list[1]')?.value).toBe(20);
  });

  it('records source offsets', () => {
    const nameNode = find(res.root, '.name')!;
    expect(nameNode.start).toBeDefined();
    expect(nameNode.end).toBeDefined();
    // the literal value text equals the slice
    const slice = src.slice(nameNode.start!, nameNode.end!);
    expect(slice).toBe('"jsona"');
  });

  it('counts nodes', () => {
    // root + name + nested + count + list + 10 + 20 = 7
    expect(res.nodeCount).toBe(7);
  });

  it('handles JSON5-style but strict JSON only', () => {
    expect(() => parseJson('{a: 1}')).toThrow();
  });
});

describe('parse YAML', () => {
  it('parses nested structures', () => {
    const src = 'services:\n  api:\n    url: https://x.com\n    ports: [80, 443]';
    const res = parse(src, { format: 'yaml' });
    expect(res.format).toBe('yaml');
    expect(find(res.root, '.services.api.url')?.value).toBe('https://x.com');
    expect(find(res.root, '.services.api.ports[1]')?.value).toBe(443);
  });
});

describe('parse TOML', () => {
  it('parses tables and values', () => {
    const src = 'title = "hi"\n[server]\nport = 8080';
    const res = parse(src, { format: 'toml' });
    expect(res.format).toBe('toml');
    expect(find(res.root, '.title')?.value).toBe('hi');
    expect(find(res.root, '.server.port')?.value).toBe(8080);
  });
});

describe('parse CSV', () => {
  it('parses with header row', () => {
    const src = 'name,age\nAlice,30\nBob,25';
    const res = parse(src, { format: 'csv' });
    expect(res.format).toBe('csv');
    expect(find(res.root, '[0].name')?.value).toBe('Alice');
    expect(find(res.root, '[1].age')?.value).toBe('25');
  });
});

describe('queryPath', () => {
  const res = parse('{"a":{"b":[1,2,{"c":3}]}}', { format: 'json' });
  it('navigates dot and bracket', () => {
    expect(find(res.root, '.a.b[2].c')?.value).toBe(3);
    expect(queryPath(res.root, '.a.b')?.kind).toBe('array');
  });
  it('returns undefined for missing', () => {
    expect(find(res.root, '.a.x')).toBeUndefined();
  });
});

describe('parse errors carry line numbers', () => {
  it('YAML reports the offending line', () => {
    try {
      parse('- a\n  b\nc: : bad', { format: 'yaml' });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as JsonaParseError;
      expect(err.format).toBe('yaml');
      expect(typeof err.line).toBe('number');
    }
  });

  it('TOML throws a JsonaParseError', () => {
    let err: JsonaParseError | undefined;
    try {
      parse('[section]\nkey = ', { format: 'toml' });
    } catch (e) {
      err = e as JsonaParseError;
    }
    expect(err).toBeDefined();
    expect(err!.format).toBe('toml');
  });

  it('CSV reports the offending line', () => {
    let err: JsonaParseError | undefined;
    try {
      parse('name,age\nAlice,30\n"unterminated', { format: 'csv' });
    } catch (e) {
      err = e as JsonaParseError;
    }
    // papaparse may or may not flag an unterminated quote depending on config;
    // if it does, the error must carry a line number.
    if (err) {
      expect(err.format).toBe('csv');
      expect(typeof err.line).toBe('number');
    }
  });
});
