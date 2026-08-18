import { parse as parseYaml } from 'yaml';
import { JsonaParseError, type JsonNode } from '../types.js';
import { valueToAstRoot } from './value.js';

export function parseYamlToAst(src: string): JsonNode {
  try {
    const data = parseYaml(src);
    return valueToAstRoot(data ?? null);
  } catch (e) {
    const err = e as { message?: string; linePos?: Array<{ line: number; col: number }> };
    let line: number | undefined;
    if (Array.isArray(err.linePos) && err.linePos.length > 0) {
      line = err.linePos[0].line;
    } else {
      const m = /line\s+(\d+)/i.exec(err.message ?? '');
      if (m) line = parseInt(m[1], 10);
    }
    throw new JsonaParseError(`YAML parse failed: ${err.message ?? e}`, 'yaml', e, line);
  }
}
