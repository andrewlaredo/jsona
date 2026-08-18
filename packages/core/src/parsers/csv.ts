import Papa from 'papaparse';
import { JsonaParseError, type JsonNode, type ParseOptions } from '../types.js';
import { valueToAstRoot } from './value.js';

export function parseCsvToAst(src: string, opts?: ParseOptions): JsonNode {
  try {
    const result = Papa.parse<string[] | Record<string, string>>(src, {
      header: opts?.csv?.header ?? true,
      skipEmptyLines: true,
    });
    if (result.errors.length > 0) {
      const first = result.errors[0];
      const line = typeof first.row === 'number' ? first.row : undefined;
      throw new JsonaParseError(
        `CSV parse failed: line ${first.row ?? '?'}: ${first.message}`,
        'csv',
        undefined,
        line,
      );
    }
    // Papaparse with header:true yields Record<string,string>[].
    // Without header, yields string[][]; wrap into {row:[...]} for a stable shape.
    const data = result.data;
    let normalized: unknown;
    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
      normalized = { rows: data };
    } else {
      normalized = data;
    }
    return valueToAstRoot(normalized);
  } catch (e) {
    if (e instanceof JsonaParseError) throw e;
    throw new JsonaParseError(`CSV parse failed: ${(e as Error).message}`, 'csv', e);
  }
}
