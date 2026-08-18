import type { SupportedFormat } from 'jsona-core';

export interface HumanizedError {
  /** Short, human-readable title. */
  title: string;
  /** 1-based line of the error, if known. */
  line?: number;
  /** 1-based column of the error, if known. */
  column?: number;
  /** A short excerpt (the offending line) shown to the user. */
  snippet?: string;
  /** Plain-language explanation of what went wrong. */
  hint: string;
  /** If present, a one-click auto-fix is available. */
  fix?: (source: string) => string;
  fixLabel?: string;
}

type TFn = (key: string) => string;

/** Resolve a translation key with a Chinese fallback when no `t` is provided. */
function tx(t: TFn | undefined, key: string, fallback: string): string {
  if (!t) return fallback;
  const v = t(key);
  return v === key ? fallback : v;
}

/** Pull line/col out of a core `JsonaParseError` (carries 1-based line/column). */
function lineColFromError(raw: unknown): { line?: number; column?: number } {
  const e = raw as { line?: number; column?: number } | undefined;
  if (e && typeof e.line === 'number') return { line: e.line, column: e.column };
  return {};
}

function lineFromMessage(msg: string): number | undefined {
  const m = msg.match(/line\s+(\d+)/i) || msg.match(/第\s*(\d+)\s*行/);
  if (m) return parseInt(m[1], 10);
  // "at position N" → convert to line by scanning the source.
  const p = msg.match(/position\s+(\d+)/i) || msg.match(/offset\s+(\d+)/i);
  return p ? parseInt(p[1], 10) : undefined;
}

function snippetOf(source: string, line?: number): string | undefined {
  if (!line) return undefined;
  const lines = source.split('\n');
  return lines[line - 1] ?? undefined;
}

/** ---- Main entry -------------------------------------------------------- */

export function humanizeError(
  raw: unknown,
  source: string,
  format: SupportedFormat,
  t?: TFn,
): HumanizedError {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '未知错误');
  const { line: coreLine, column: coreColumn } = lineColFromError(raw);
  const line = coreLine ?? lineFromMessage(msg);
  const snippet = snippetOf(source, line);

  if (format === 'json') {
    const hasUnbalanced = /\{|\[/.test(source) && (source.match(/[}\]]/g)?.length ?? 0) !== (source.match(/[{[]/g)?.length ?? 0);
    const hasTrailing = /,\s*[}\]]/.test(source) || /,\s*,/.test(source);
    const hasUnquotedKey = /(^|[{,]\s*)[A-Za-z_$][\w$-]*\s*:/.test(source);
    let hint = tx(t, 'err.jsonCommonHint', '常见原因：键名没加双引号、字符串里含有未转义的双引号、多了或少了逗号 / 括号。');
    if (hasUnbalanced) hint = tx(t, 'err.jsonUnbalanced', '括号或方括号不匹配（多了或少了 { } [ ]）。');
    else if (hasTrailing) hint = tx(t, 'err.jsonTrailing', '存在多余的逗号（例如 } 前或 ] 前多了一个逗号）。');
    else if (hasUnquotedKey) hint = tx(t, 'err.jsonUnquotedKey', '对象的键名没有加双引号。');
    return {
      title: tx(t, 'err.jsonTitle', 'JSON 语法有误'),
      line,
      column: coreColumn,
      snippet,
      hint,
    };
  }

  if (format === 'yaml') {
    return {
      title: tx(t, 'err.yamlTitle', 'YAML 语法有误'),
      line,
      snippet,
      hint: tx(t, 'err.yamlHint', '常见问题：缩进不一致（用空格不要用 Tab）、冒号后缺少空格、列表项缺少 `- `。'),
    };
  }

  if (format === 'toml') {
    return {
      title: tx(t, 'err.tomlTitle', 'TOML 语法有误'),
      line,
      snippet,
      hint: tx(t, 'err.tomlHint', '常见问题：键与值之间要用 `=` 连接，字符串要用双引号包裹，表头用 `[section]`。'),
    };
  }

  if (format === 'csv') {
    return {
      title: tx(t, 'err.csvTitle', 'CSV 无法解析'),
      line,
      snippet,
      hint: tx(t, 'err.csvHint', '常见问题：某行列数不一致、引号未成对闭合、分隔符不是逗号。可尝试切到 CSV 模式手动检查。'),
    };
  }

  return {
    title: tx(t, 'err.unknownTitle', '无法解析'),
    snippet,
    hint: tx(t, 'err.unknownHint', '请检查文档内容是否完整。'),
  };
}
