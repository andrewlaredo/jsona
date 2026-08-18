import { useEffect, useRef, useState, useCallback } from 'react';
import type { ParseOptions, ParseResult, ParseError } from 'jsona-core';
import type { WorkerOutbound } from './parseWorker';

interface ParseState {
  result: ParseResult | null;
  error: string | null;
  /** Structured diagnostics for the failed parse (null when not applicable). */
  diagnostics: ParseError[] | null;
  progress: number; // 0..1, -1 means idle
  parsing: boolean;
  /** True when the latest parse was superseded by a newer request. */
  stale: boolean;
}

/** Hard ceiling so a pathological document can never hang the worker forever. */
const PARSE_TIMEOUT_MS = 60_000;

export function useParseWorker() {
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const latestId = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<ParseState>({
    result: null,
    error: null,
    diagnostics: null,
    progress: -1,
    parsing: false,
    stale: false,
  });

  const clearTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => {
    const worker = new Worker(new URL('./parseWorker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<WorkerOutbound>) => {
      const msg = e.data;
      // Drop anything that does not belong to the most recent request.
      if ('id' in msg && msg.id !== latestId.current) return;
      if (msg.type === 'progress') {
        setState((s) => ({ ...s, progress: msg.ratio, parsing: true, stale: false }));
      } else if (msg.type === 'done') {
        clearTimer();
        setState({ result: msg.result, error: null, diagnostics: null, progress: -1, parsing: false, stale: false });
      } else if (msg.type === 'error') {
        clearTimer();
        setState({ result: null, error: msg.message, diagnostics: msg.diagnostics ?? null, progress: -1, parsing: false, stale: false });
      } else if (msg.type === 'cancelled') {
        clearTimer();
        setState((s) => ({ ...s, parsing: false }));
      }
    };
    workerRef.current = worker;
    return () => {
      clearTimer();
      worker.terminate();
    };
  }, []);

  const parseAsync = useCallback((src: string, options?: ParseOptions) => {
    const worker = workerRef.current;
    if (!worker || !src.trim()) {
      clearTimer();
      setState({ result: null, error: null, diagnostics: null, progress: -1, parsing: false, stale: false });
      return;
    }
    const id = ++reqId.current;
    latestId.current = id;
    clearTimer();
    // Tell the worker to abandon any still-running older task immediately.
    worker.postMessage({ type: 'cancel', id: id - 1 } as { type: 'cancel'; id: number });
    setState((s) => ({ ...s, parsing: true, error: null, progress: 0, stale: false }));
    worker.postMessage({ type: 'parse', id, src, options } as { type: 'parse'; id: number; src: string; options?: ParseOptions });
    // Main-thread safety net: if the worker has not responded within the
    // ceiling, surface a timeout instead of leaving the UI in "parsing…".
    timeoutRef.current = setTimeout(() => {
      if (latestId.current === id) {
        setState((s) => (s.parsing ? { ...s, parsing: false, error: '解析超时：文档可能过大或结构异常' } : s));
      }
    }, PARSE_TIMEOUT_MS);
  }, []);

  return { ...state, parseAsync };
}
