// Unified AST node model for jsona.
// Every node carries a stable id, its path in the document, and (when available)
// the source text offset range so that Graph <-> Tree <-> Source can be aligned.

export type NodeKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null';

export interface JsonNode {
  /** Stable, unique id used to anchor/highlight across views. */
  id: string;
  /** Dot-path in the document, e.g. ".services.api.url" or ".items[0].name". Filled by annotatePaths. */
  path?: string;
  /** Object key or array index. Undefined for the root. */
  key?: string;
  kind: NodeKind;
  /** Scalar value (string/number/boolean/null). Undefined for object/array. */
  value?: string | number | boolean | null;
  /** Child nodes for object/array. */
  children?: JsonNode[];
  /** 0-based start offset in the source text (inclusive). */
  start?: number;
  /** 0-based end offset in the source text (exclusive). */
  end?: number;
}

export type SupportedFormat = 'json' | 'yaml' | 'toml' | 'csv';

export interface ParseResult {
  /** The unified AST root. */
  root: JsonNode;
  /** Total node count (used for sampling thresholds). */
  nodeCount: number;
  /** The format that produced this result. */
  format: SupportedFormat;
  /** Detected/used format label for display. */
  formatLabel: string;
}

export interface ParseOptions {
  format?: SupportedFormat;
  /** CSV-specific options. */
  csv?: {
    /** Use first row as header keys. Default true. */
    header?: boolean;
  };
}

/** A structured diagnostic produced by the parser, in the style of
 *  VS Code / Monaco markers (offset + length + message + code + severity). */
export interface ParseError {
  /** 0-based start offset in the source text. */
  offset: number;
  /** Length of the offending span (0 when unknown). */
  length: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Human-readable message. */
  message: string;
  /** Optional machine code (e.g. jsonc-parser ParseErrorCode). */
  code?: string | number;
  /** 'error' is blocking, 'warning' is advisory (e.g. trailing comma). */
  severity: 'error' | 'warning';
}

export class JsonaParseError extends Error {
  constructor(
    message: string,
    public readonly format: SupportedFormat,
    public readonly cause?: unknown,
    /** 1-based line of the error, when known. */
    public readonly line?: number,
    /** 1-based column of the error, when known. */
    public readonly column?: number,
    /** When present, a structured list of diagnostics (may contain multiple). */
    public readonly errors?: ParseError[],
  ) {
    super(message);
    this.name = 'JsonaParseError';
  }
}
