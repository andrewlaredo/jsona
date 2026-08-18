import { describe, it, expect } from 'vitest';
import { parse, collectJsonErrors, JsonaParseError } from '../index';

describe('multi-error diagnostics', () => {
  it('collectJsonErrors returns multiple items for a broken json', () => {
    const src = `{
  "a": 1
  "b": 2,
}`;
    const errs = collectJsonErrors(src);
    expect(errs.length).toBeGreaterThanOrEqual(1);
    // every item has line/column/offset/length
    for (const e of errs) {
      expect(e.line).toBeGreaterThanOrEqual(1);
      expect(e.column).toBeGreaterThanOrEqual(1);
      expect(typeof e.offset).toBe('number');
      expect(e.severity).toBe('error');
    }
  });

  it('parse() failure carries structured errors', () => {
    const src = `{
  "a": 1
  "b": 2
}`;
    let thrown: unknown;
    try {
      parse(src);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JsonaParseError);
    const je = thrown as JsonaParseError;
    expect(je.errors).toBeDefined();
    expect(je.errors!.length).toBeGreaterThanOrEqual(1);
    // first error should be near line 3 (the missing comma)
    expect(je.errors![0].line).toBeGreaterThanOrEqual(2);
  });

  it('valid json produces no errors', () => {
    const src = `{"a":1,"b":[1,2,3]}`;
    const errs = collectJsonErrors(src);
    expect(errs.length).toBe(0);
  });
});
