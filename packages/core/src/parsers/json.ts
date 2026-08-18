import type { JsonNode, NodeKind } from '../types.js';

// A small JSON lexer/parser that produces a unified AST while tracking
// source-text offsets for each node. This powers the "source <-> tree/graph"
// alignment feature. We intentionally do not use JSON.parse so we keep offsets.

type TokenType =
  | 'braceL'
  | 'braceR'
  | 'bracketL'
  | 'bracketR'
  | 'colon'
  | 'comma'
  | 'string'
  | 'number'
  | 'true'
  | 'false'
  | 'null';

interface Token {
  type: TokenType;
  start: number;
  end: number;
  value?: string | number | boolean | null;
}

// Tokenize a JSON source string. Handles strings (with escapes), numbers,
// booleans, null, and structural punctuation. Whitespace is skipped.
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  while (i < n) {
    const c = src[i];
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === '{') {
      tokens.push({ type: 'braceL', start: i, end: i + 1 });
      i++;
    } else if (c === '}') {
      tokens.push({ type: 'braceR', start: i, end: i + 1 });
      i++;
    } else if (c === '[') {
      tokens.push({ type: 'bracketL', start: i, end: i + 1 });
      i++;
    } else if (c === ']') {
      tokens.push({ type: 'bracketR', start: i, end: i + 1 });
      i++;
    } else if (c === ':') {
      tokens.push({ type: 'colon', start: i, end: i + 1 });
      i++;
    } else if (c === ',') {
      tokens.push({ type: 'comma', start: i, end: i + 1 });
      i++;
    } else if (c === '"') {
      // parse string
      let j = i + 1;
      let str = '';
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          const nx = src[j + 1];
          switch (nx) {
            case 'n': str += '\n'; break;
            case 't': str += '\t'; break;
            case 'r': str += '\r'; break;
            case 'b': str += '\b'; break;
            case 'f': str += '\f'; break;
            case '/': str += '/'; break;
            case '\\': str += '\\'; break;
            case '"': str += '"'; break;
            case 'u': {
              const hex = src.slice(j + 2, j + 6);
              str += String.fromCharCode(parseInt(hex, 16));
              j += 4;
              break;
            }
            default: str += nx;
          }
          j += 2;
        } else if (ch === '"') {
          j++;
          break;
        } else {
          str += ch;
          j++;
        }
      }
      tokens.push({ type: 'string', start: i, end: j, value: str });
      i = j;
    } else if (c === '-' || c === '+' || (c >= '0' && c <= '9')) {
      let j = i;
      while (j < n && /[0-9eE+\-.]/i.test(src[j])) j++;
      const numStr = src.slice(i, j);
      const num = Number(numStr);
      if (Number.isNaN(num)) throw new Error(`Invalid number at ${i}`);
      tokens.push({ type: 'number', start: i, end: j, value: num });
      i = j;
    } else if (src.startsWith('true', i)) {
      tokens.push({ type: 'true', start: i, end: i + 4, value: true });
      i += 4;
    } else if (src.startsWith('false', i)) {
      tokens.push({ type: 'false', start: i, end: i + 5, value: false });
      i += 5;
    } else if (src.startsWith('null', i)) {
      tokens.push({ type: 'null', start: i, end: i + 4, value: null });
      i += 4;
    } else {
      throw new Error(`Unexpected character '${c}' at position ${i}`);
    }
  }
  return tokens;
}

export class JsonSyntaxError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
    this.name = 'JsonSyntaxError';
  }
}

import type { ParseError as ParseErrorItem } from '../types.js';
import {
  parse as jsoncParse,
  parseTree,
  printParseErrorCode,
  type ParseError as JsoncParseError,
} from 'jsonc-parser';

/** Collect multiple diagnostics from a (possibly invalid) JSON source using
 *  jsonc-parser, the same engine VS Code uses. Returns a unified list of
 *  `{ offset, length, line, column, message, code, severity }` items. */
export function collectJsonErrors(textForLines: string): ParseErrorItem[] {
  const errors: JsoncParseError[] = [];
  parseTree(textForLines, errors, {
    allowTrailingComma: false,
    disallowComments: false,
  });
  // Also attempt a full parse to surface any errors the tree builder swallowed.
  const parseErrs: JsoncParseError[] = [];
  jsoncParse(textForLines, parseErrs, {
    allowTrailingComma: false,
    disallowComments: false,
  });

  const seen = new Set<string>();
  const out: ParseErrorItem[] = [];
  for (const e of [...errors, ...parseErrs]) {
    const key = `${e.offset}:${e.length}:${e.error}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { line, column } = offsetToLineColSafe(textForLines, e.offset);
    out.push({
      offset: e.offset,
      length: e.length,
      line,
      column,
      message: printParseErrorCode(e.error),
      code: e.error,
      severity: 'error',
    });
  }
  // Cap to a reasonable number to keep the UI responsive.
  return out.slice(0, 50);
}

function offsetToLineColSafe(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  const clamped = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

export function parseJson(src: string): JsonNode {
  const tokens = tokenize(src);
  let pos = 0;
  let counter = 0;

  // Compute the source offset where the parser currently is stuck. This is the
  // start of the not-yet-consumed token, or the end of the previous one, or EOF.
  function currentOffset(): number {
    if (pos < tokens.length) return tokens[pos].start;
    if (tokens.length > 0) return tokens[tokens.length - 1].end;
    return src.length;
  }

  function fail(msg: string): never {
    throw new JsonSyntaxError(msg, currentOffset());
  }

  function next(): Token {
    if (pos >= tokens.length) throw new JsonSyntaxError('Unexpected end of input', currentOffset());
    return tokens[pos++];
  }

  function parseValue(expectedKey?: string): JsonNode {
    // Consume the starting token for this value.
    const tok = next();
    if (!tok) fail('Unexpected end of input');

    if (tok.type === 'braceL') {
      const start = tok.start;
      const children: JsonNode[] = [];
      // handle empty object
      if (tokens[pos]?.type === 'braceR') {
        const close = next();
        return mkNode('object', undefined, expectedKey, children, start, close.end);
      }
      while (true) {
        const keyTok = next();
        if (keyTok.type !== 'string') fail('Expected a string key in object');
        const key = keyTok.value as string;
        const colon = next();
        if (colon.type !== 'colon') fail('Expected ":" after object key');
        const val = parseValue(key);
        children.push(val);
        const sep = next();
        if (sep.type === 'comma') continue;
        if (sep.type === 'braceR') {
          return mkNode('object', undefined, expectedKey, children, start, sep.end);
        }
        fail('Expected "," or "}" in object');
      }
    }

    if (tok.type === 'bracketL') {
      const start = tok.start;
      const children: JsonNode[] = [];
      if (tokens[pos]?.type === 'bracketR') {
        const close = next();
        return mkNode('array', undefined, expectedKey, children, start, close.end);
      }
      let idx = 0;
      while (true) {
        const val = parseValue(String(idx));
        children.push(val);
        const sep = next();
        if (sep.type === 'comma') {
          idx++;
          continue;
        }
        if (sep.type === 'bracketR') {
          return mkNode('array', undefined, expectedKey, children, start, sep.end);
        }
        fail('Expected "," or "]" in array');
      }
    }

    if (tok.type === 'string') {
      return mkLeaf('string', tok.value as string, expectedKey, tok.start, tok.end);
    }
    if (tok.type === 'number') {
      return mkLeaf('number', tok.value as number, expectedKey, tok.start, tok.end);
    }
    if (tok.type === 'true' || tok.type === 'false') {
      return mkLeaf('boolean', tok.value as boolean, expectedKey, tok.start, tok.end);
    }
    if (tok.type === 'null') {
      return mkLeaf('null', null, expectedKey, tok.start, tok.end);
    }
    fail(`Unexpected token at ${tok.start}`);
  }

  function mkLeaf(
    kind: NodeKind,
    value: string | number | boolean | null,
    key: string | undefined,
    start: number,
    end: number,
  ): JsonNode {
    return { id: `n${counter++}`, kind, key, value, start, end };
  }

  function mkNode(
    kind: NodeKind,
    _v: undefined,
    key: string | undefined,
    children: JsonNode[],
    start: number,
    end: number,
  ): JsonNode {
    return { id: `n${counter++}`, kind, key, children, start, end };
  }

  const root = parseValue(undefined);
  return root;
}
