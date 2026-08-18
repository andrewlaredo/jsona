import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { ParseError, SupportedFormat } from 'jsona-core';
import { useT } from './i18n';

/** Imperative handle exposed to the rest of the app. */
export interface SourceEditorHandle {
  /** Scroll to and focus a 1-based line. */
  scrollToLine(line: number): void;
  /** Flash/select the character range starting at the given 0-based offset. */
  highlight(offset: number): void;
}

// Map our format ids to Monaco language ids.
const LANG: Record<SupportedFormat, string> = {
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
  csv: 'csv',
};

// Convert a 0-based offset into 1-based Monaco line/column.
function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  if (offset < 0) offset = 0;
  if (offset > text.length) offset = text.length;
  let line = 1;
  let last = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return { line, column: offset - last + 1 };
}

// Hard-coded theme colors keyed by our theme id. We do NOT read from CSS
// variables here: the SourceEditor effect runs before the App's effect that
// flips <html data-theme>, so reading the DOM would lag one toggle behind and
// paint the opposite background ("themes appear swapped"). Pinning colors to
// the theme id keeps dark=dark and light=light regardless of effect order.
const THEME_COLORS = {
  'jsona-dark': {
    bg: '#0d1117',
    fg: '#c9d1d9',
    // Scrollbar slider tints, kept in sync with the app's --sb-thumb vars so the
    // Monaco overlay scroller reads like the rest of the project's scrollbars.
    scrollbarThumb: 'rgba(139, 148, 158, 0.30)',
    scrollbarThumbHover: 'rgba(139, 148, 158, 0.55)',
  },
  'jsona-light': {
    bg: '#ffffff',
    fg: '#1f2328',
    scrollbarThumb: 'rgba(101, 109, 118, 0.30)',
    scrollbarThumbHover: 'rgba(101, 109, 118, 0.60)',
  },
} as const;

function themeIdOf(theme: 'light' | 'dark'): 'jsona-dark' | 'jsona-light' {
  return theme === 'dark' ? 'jsona-dark' : 'jsona-light';
}

// Define both themes on every switch so colors stay in sync with the source of
// truth (the THEME_COLORS table above, not the DOM).
function ensureThemes() {
  const defs: [keyof typeof THEME_COLORS, 'vs-dark' | 'vs'][] = [
    ['jsona-dark', 'vs-dark'],
    ['jsona-light', 'vs'],
  ];
  for (const [id, base] of defs) {
    const { bg, fg, scrollbarThumb, scrollbarThumbHover } = THEME_COLORS[id];
    try {
      monaco.editor.defineTheme(id, {
        base,
        inherit: true,
        rules: [],
        colors: {
          'editor.background': bg,
          'editor.foreground': fg,
          'scrollbarSlider.background': scrollbarThumb,
          'scrollbarSlider.hoverBackground': scrollbarThumbHover,
          'scrollbarSlider.activeBackground': scrollbarThumbHover,
        },
      });
    } catch {}
  }
}

export interface SourceEditorProps {
  value: string;
  format: SupportedFormat;
  theme?: 'light' | 'dark';
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onCursorOffset?: (offset: number) => void;
  /** Structured diagnostics to paint as squiggles + Problems. */
  diagnostics?: ParseError[] | null;
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(function SourceEditor(
  { value, format, theme = 'dark', readOnly = false, onChange, onCursorOffset, diagnostics },
  ref,
) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const onChangeRef = useRef(onChange);
  const onCursorRef = useRef(onCursorOffset);
  onChangeRef.current = onChange;
  onCursorRef.current = onCursorOffset;
  const [statusCollapsed, setStatusCollapsed] = useState(false);

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language: LANG[format],
      theme: themeIdOf(theme),
      readOnly,
      automaticLayout: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      tabSize: 2,
      fixedOverflowWidgets: true,
      folding: true,
      foldingStrategy: 'indentation',
      showFoldingControls: 'always',
      placeholder: t('editor.placeholder'),
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
      },
    });
    editorRef.current = editor;
    modelRef.current = editor.getModel();

    editor.onDidChangeModelContent(() => {
      const v = editor.getValue();
      onChangeRef.current?.(v);
    });
    const emitCursor = () => {
      const sel = editor.getSelection();
      if (sel) onCursorRef.current?.(editor.getModel()?.getOffsetAt(sel.getPosition()) ?? 0);
    };
    editor.onDidChangeCursorPosition(emitCursor);
    editor.onDidChangeCursorSelection(emitCursor);

    return () => {
      editor.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value -> model when it changes underneath us.
  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue() !== value) {
      model.setValue(value);
    }
  }, [value]);

  // Sync language when format changes.
  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getLanguageId() !== LANG[format]) {
      monaco.editor.setModelLanguage(model, LANG[format]);
    }
  }, [format]);

  // Sync theme.
  useEffect(() => {
    ensureThemes();
    monaco.editor.setTheme(themeIdOf(theme));
  }, [theme]);

  // Sync read-only.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // Paint diagnostics as Monaco markers (native squiggles + hover + Problems).
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    const markers: monaco.editor.IMarkerData[] = (diagnostics ?? []).map((d) => {
      const start = offsetToLineCol(model.getValue(), d.offset);
      const end = offsetToLineCol(model.getValue(), d.offset + (d.length || 1));
      return {
        startLineNumber: start.line,
        startColumn: start.column,
        endLineNumber: end.line,
        endColumn: end.column,
        message: d.message,
        severity:
          d.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Error,
      };
    });
    monaco.editor.setModelMarkers(model, 'jsona', markers);
  }, [diagnostics]);

  // Imperative API used by the rest of the app.
  useImperativeHandle(ref, () => ({
    scrollToLine(line: number) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    },
    highlight(offset: number) {
      const editor = editorRef.current;
      const model = modelRef.current;
      if (!editor || !model) return;
      const { line, column } = offsetToLineCol(model.getValue(), offset);
      const pos = { lineNumber: line, column };
      editor.revealPositionInCenterIfOutsideViewport(pos);
      editor.setSelection({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column });
    },
  }));

  return (
    <div className="source-editor">
      <div className="source-editor-host" ref={hostRef} />
      {diagnostics && diagnostics.length > 0 && (
        <div className={`editor-statusbar ${statusCollapsed ? 'is-collapsed' : ''}`} role="list">
          <div
            className="editor-statusbar-count"
            role="button"
            tabIndex={0}
            onClick={() => setStatusCollapsed((v) => !v)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatusCollapsed((v) => !v); } }}
            title={statusCollapsed ? t('editor.expandErrors') : t('editor.collapseErrors')}
          >
            <span className={`editor-statusbar-chevron ${statusCollapsed ? '' : 'open'}`} aria-hidden>▸</span>
            {diagnostics.length} {t('editor.errors')}
          </div>
          {!statusCollapsed && (
            <ul className="editor-statusbar-list">
              {diagnostics.slice(0, 50).map((d, i) => (
                <li
                  key={i}
                  className="editor-statusbar-item"
                  role="listitem"
                  onClick={() => editorRef.current?.revealLineInCenter(d.line)}
                  title={`${t('error.line')} ${d.line} · ${t('error.jump')}`}
                >
                  <span className="editor-statusbar-dot" />
                  <span className="editor-statusbar-line">L{d.line}</span>
                  <span className="editor-statusbar-msg">{d.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});
