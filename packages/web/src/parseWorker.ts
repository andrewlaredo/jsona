// Web Worker: run jsona core parsing off the main thread so large files
// do not freeze the UI. Reports progress for the progress bar.
import { parse, tokenize, type ParseOptions, type ParseResult, type ParseError } from 'jsona-core';

interface ParseRequest {
  type: 'parse';
  id: number;
  src: string;
  options?: ParseOptions;
}
interface CancelRequest {
  type: 'cancel';
  id: number;
}
interface ParseProgress {
  type: 'progress';
  id: number;
  ratio: number;
  message: string;
}
interface ParseDone {
  type: 'done';
  id: number;
  result: ParseResult;
}
interface ParseErrorMsg {
  type: 'error';
  id: number;
  message: string;
  /** Structured diagnostics from JsonaParseError.errors (may be absent). */
  diagnostics?: ParseError[];
}
interface ParseCancelled {
  type: 'cancelled';
  id: number;
}

export type WorkerInbound = ParseRequest | CancelRequest;
export type WorkerOutbound = ParseProgress | ParseDone | ParseErrorMsg | ParseCancelled;

const post = (msg: WorkerOutbound) => (self as unknown as Worker).postMessage(msg);
// Yield to the event loop so the progress messages are flushed and a newer
// request (or cancel) can take over.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// The id of the request currently being processed. A newer request supersedes
// any in-flight work, so stale results are dropped instead of overwriting a
// newer document. This is the core of the parse-cancellation guarantee.
let activeId = 0;

self.onmessage = async (e: MessageEvent<WorkerInbound>) => {
  const data = e.data;
  if (data.type === 'cancel') {
    if (data.id === activeId) activeId = -data.id; // negate so stale checks fail
    return;
  }
  const { id, src, options } = data;
  activeId = id;
  const fmt = options?.format;
  // Real progress: for JSON we tokenize as a measurable first pass (O(n)),
  // emitting progress per ~4% of tokens. Other formats get a lightweight sweep.
  try {
    if (fmt === undefined || fmt === 'json') {
      const tokens = tokenize(src);
      const total = tokens.length;
      const bucket = Math.max(1, Math.floor(total / 25));
      for (let i = 0; i < total; i += bucket) {
        if (id !== activeId) return; // superseded
        post({ type: 'progress', id, ratio: 0.05 + 0.9 * (i / total), message: '扫描中…' });
        if (i % (bucket * 5) === 0) await tick();
      }
    } else {
      post({ type: 'progress', id, ratio: 0.3, message: '解析中…' });
      await tick();
    }
    if (id !== activeId) return; // superseded before parse finished
    const result = parse(src, options);
    if (id !== activeId) return; // superseded during parse
    post({ type: 'done', id, result } satisfies ParseDone);
  } catch (err) {
    if (id !== activeId) return; // superseded, drop
    const er = err as Error & { errors?: unknown };
    post({ type: 'error', id, message: er.message, diagnostics: Array.isArray(er.errors) ? er.errors : undefined } satisfies ParseErrorMsg);
  }
};

