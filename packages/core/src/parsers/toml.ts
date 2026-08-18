import { parse as parseToml } from 'toml';
import { JsonaParseError, type JsonNode } from '../types.js';
import { valueToAstRoot } from './value.js';

export function parseTomlToAst(src: string): JsonNode {
  try {
    const data = parseToml(src);
    return valueToAstRoot(data ?? null);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    const m = /line\s+(\d+)/i.exec(message);
    const line = m ? parseInt(m[1], 10) : undefined;
    throw new JsonaParseError(`TOML parse failed: ${message}`, 'toml', e, line);
  }
}
