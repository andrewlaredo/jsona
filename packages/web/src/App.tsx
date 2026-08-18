import { useRef, useState, useCallback, useEffect, useMemo, Suspense, lazy } from 'react';
import { useParseWorker } from './useParseWorker';
import { VirtualTree } from './VirtualTree';
import SearchResults from './SearchResults';
import { SourceEditor, type SourceEditorHandle } from './SourceEditor';
import { ErrorCard } from './ErrorCard';
import { humanizeError } from './errorHumanizer';
import { detectFormat } from 'jsona-core';
import { readShareFromUrl } from './share';
import { nodeAtOffset } from './locate';
import { AiPanel } from './ai/AiPanel';
import { useWorkspace } from './useWorkspace';
import {
  formatJson,
  minifyJson,
  shapeToJson,
  buildGraph,
  type ParseResult,
  type JsonNode,
  type SupportedFormat,
} from 'jsona-core';
import YAML from 'yaml';
import Papa from 'papaparse';
import {
  translate,
  getStoredLocale,
  setStoredLocale,
  type Locale,
} from './i18n';
import { I18nProvider, useT } from './i18n';
import { SAMPLES, type SampleDoc } from './samples';

// Heavy, on-demand views are code-split so the initial bundle stays small.
const GraphView = lazy(() =>
  import('./GraphView').then((m) => ({ default: m.GraphView })),
);
const CompareView = lazy(() =>
  import('./CompareView').then((m) => ({ default: m.CompareView })),
);
const ShareView = lazy(() =>
  import('./ShareView').then((m) => ({ default: m.ShareView })),
);
const ColumnView = lazy(() => import('./ColumnView'));
const FlowView = lazy(() => import('./FlowView'));
const Breadcrumb = lazy(() => import('./Breadcrumb'));

const FORMATS: (SupportedFormat | 'auto')[] = ['auto', 'json', 'yaml', 'toml', 'csv'];
const EXPORT_FORMATS: SupportedFormat[] = ['json', 'yaml', 'toml', 'csv'];
const THEME_KEY = 'jsona.theme';

/** Activity bar destinations. Each maps to a primary right-panel view. */
type ActivityView = 'tree' | 'column' | 'graph' | 'flow' | 'share' | 'compare';

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function astForExport(r: ParseResult): unknown {
  const walk = (n: JsonNode): unknown => {
    if (n.kind === 'object') {
      const o: Record<string, unknown> = {};
      for (const c of n.children ?? []) o[c.key as string] = walk(c);
      return o;
    }
    if (n.kind === 'array') return (n.children ?? []).map(walk);
    return n.value ?? null;
  };
  return walk(r.root);
}

function ViewFallback({ label }: { label: string }) {
  const t = useT();
  return <div className="muted" style={{ padding: 16 }}>{t('view.loading')} {label}…</div>;
}

/** Minimal inline SVG icons for the activity bar / tool buttons. */
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'tree':
      return (<svg {...common}><path d="M4 6h7M4 12h7M4 18h7" /><path d="M14 6h6M14 12h6M14 18h6" /><circle cx="11" cy="6" r="1.4" /><circle cx="11" cy="12" r="1.4" /><circle cx="11" cy="18" r="1.4" /></svg>);
    case 'column':
      return (<svg {...common}><rect x="3" y="4" width="6" height="16" rx="1" /><rect x="11" y="4" width="6" height="16" rx="1" /><rect x="19" y="4" width="2" height="16" rx="1" /></svg>);
    case 'graph':
      return (<svg {...common}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="9" cy="18" r="2" /><path d="M7.5 7.2 16.4 8.6M7 8 8.4 16" /></svg>);
    case 'flow':
      return (<svg {...common}><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h10" /></svg>);
    case 'share':
      return (<svg {...common}><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.3 10.8 15.7 7.2M8.3 13.2 15.7 16.8" /></svg>);
    case 'compare':
      return (<svg {...common}><path d="M12 3v18" /><path d="M7 8 4 12l3 4" /><path d="M17 8l3 4-3 4" /></svg>);
    case 'search':
      return (<svg {...common}><circle cx="11" cy="11" r="6" /><path d="m20 20-3.5-3.5" /></svg>);
    case 'document':
      return (<svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>);
    case 'sparkles':
      return (<svg {...common}><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M12 7l1.5 3.5L17 12l-3.5 1.5L12 17l-1.5-3.5L7 12l3.5-1.5z" /></svg>);
    case 'sun':
      return (<svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
    case 'moon':
      return (<svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" /></svg>);
    case 'globe':
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" /></svg>);
    case 'check':
      return (<svg {...common}><path d="M20 6 9 17l-5-5" /></svg>);
    case 'x':
      return (<svg {...common}><path d="M18 6 6 18M6 6l12 12" /></svg>);
    case 'panel':
      return (<svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></svg>);
    case 'format':
      return (<svg {...common}><path d="M4 6h16M4 12h10M4 18h13" /><path d="M16 10l2 2-2 2" /></svg>);
    case 'minify':
      return (<svg {...common}><path d="M4 8h9M4 14h6" /><path d="M15 6l3 3-3 3" /><path d="M15 12l3 3-3 3" /></svg>);
    case 'help':
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.1.9-1.1 1.7" /><path d="M12 17h.01" /></svg>);
    case 'clear':
      return (<svg {...common}><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><path d="M10 11v6M14 11v6" /></svg>);
    default:
      return null;
  }
}

export function App() {
  const { result, error, diagnostics, progress, parsing, parseAsync } = useParseWorker();
  const workspace = useWorkspace();
  const [aiOpen, setAiOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [source, setSource] = useState('');
  const [format, setFormat] = useState<SupportedFormat | 'auto'>('auto');
  const editorRef = useRef<SourceEditorHandle>(null);
  const [treeQuery, setTreeQuery] = useState('');
  const [selected, setSelected] = useState<JsonNode | null>(null);
  const [hlVersion, setHlVersion] = useState(0);
  const [rightView, setRightView] = useState<ActivityView>('tree');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [fmtOpen, setFmtOpen] = useState(false); // mobile format dropdown
  const [rightPct, setRightPct] = useState(48); // right panel width %
  const [toast, setToast] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [locale, setLocale] = useState<Locale>(getStoredLocale());
  const [theme, setTheme] = useState<'dark' | 'light'>(
    (typeof localStorage !== 'undefined' && (localStorage.getItem(THEME_KEY) as 'dark' | 'light')) || 'dark',
  );
  const [errorCollapsed, setErrorCollapsed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);
  const resizing = useRef(false);

  const t = useCallback((k: string) => translate(locale, k), [locale]);

  // Apply theme to <html data-theme> so CSS variables switch.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Keep <html lang> in sync with the active UI locale (SPA: updated at runtime).
  useEffect(() => {
    document.documentElement.setAttribute('lang', locale);
  }, [locale]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2000);
  }, []);

  const runParse = useCallback(
    (txt: string, fmt: SupportedFormat | 'auto') => {
      setSource(txt);
      parseAsync(txt, fmt === 'auto' ? undefined : { format: fmt });
    },
    [parseAsync],
  );

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then((txt) => runParse(txt, format));
  }

  function onSourceChange(txt: string) {
    setSource(txt);
    parseAsync(txt, format === 'auto' ? undefined : { format });
  }

  function onFormatChange(f: SupportedFormat | 'auto') {
    setFormat(f);
    if (source.trim()) parseAsync(source, f === 'auto' ? undefined : { format: f });
  }

  function loadSample(sample: SampleDoc) {
    runParse(sample.text, sample.format);
    setFormat(sample.format);
    setRightView('tree');
    setPanelCollapsed(false);
  }

  function onSelect(node: JsonNode) {
    setSelected(node);
    setHlVersion((v) => v + 1);
  }

  // Reverse locate: caret moved in the source editor -> select the tree node.
  // The highlight is deliberately NOT re-flashed here, otherwise the editor
  // would scroll itself while the user is typing/clicking. We also derive the
  // caret line/column for the status bar from the source string by offset.
  const onCursor = useCallback(
    (offset: number) => {
      const upTo = source.slice(0, offset);
      const line = upTo.split('\n').length;
      const col = offset - upTo.lastIndexOf('\n');
      setCursorLine(line);
      setCursorCol(col);
      if (!result) return;
      const hit = nodeAtOffset(result.root, offset);
      if (hit) setSelected((prev) => (prev?.id === hit.id ? prev : hit));
    },
    [source, result],
  );

  // Inline edit from the column view: splice the new literal into the source
  // Resolve a node by id from the parsed AST (keeps offsets/path correct).
  const findNodeById = useCallback(
    (id: string): JsonNode | null => {
      if (!result) return null;
      let found: JsonNode | null = null;
      const walk = (n: JsonNode) => {
        if (n.id === id) {
          found = n;
          return;
        }
        for (const c of n.children ?? []) walk(c);
      };
      walk(result.root);
      return found;
    },
    [result],
  );

  // Graph renders the full document without sampling (Canvas force-directed
  // layout handles large node counts).
  const graphData = useMemo(() => {
    if (!result) return null;
    return buildGraph(result.root);
  }, [result]);

  // No sampling: the full graph renders directly.

  // After a re-parse the AST is rebuilt, so the previously selected node object
  // is stale (its offsets no longer match the new source). Re-resolve it by
  // path, which is stable across edits, and drop the selection if it vanished.
  useEffect(() => {
    if (!result) {
      setSelected(null);
      return;
    }
    setSelected((prev) => {
      if (!prev) return prev;
      let hit: JsonNode | null = null;
      const walk = (n: JsonNode) => {
        if (hit) return;
        if (n.path === prev.path) {
          hit = n;
          return;
        }
        for (const c of n.children ?? []) walk(c);
      };
      walk(result.root);
      return hit;
    });
  }, [result]);

  // Decode a shared document from the URL hash on first mount.
  useEffect(() => {
    let cancelled = false;
    readShareFromUrl().then((payload) => {
      if (cancelled || !payload) return;
      setFormat(payload.format);
      runParse(payload.source, payload.format);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcut: Ctrl/Cmd+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drag-to-resize the right panel. Pointer events on the resizer update the
  // right panel width as a percentage of the workspace.
  const onResizerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizing.current = true;
    const move = (ev: PointerEvent) => {
      if (!resizing.current) return;
      const ws = document.querySelector('.workspace') as HTMLElement | null;
      if (!ws) return;
      const rect = ws.getBoundingClientRect();
      const pct = ((rect.right - ev.clientX) / rect.width) * 100;
      setRightPct(Math.min(75, Math.max(20, pct)));
    };
    const up = () => {
      resizing.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  // When a tree node is selected (or selection changes), flash its span in the editor.
  useEffect(() => {
    if (selected && selected.start !== undefined) {
      editorRef.current?.highlight(selected.start);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlVersion]);

  // --- Shaping ---
  function doFormat() {
    if (!result) return;
    try {
      runParse(formatJson(source, format === 'auto' ? undefined : { format }), format);
      showToast(t('toast.formatted'));
    } catch (e) {
      showToast(t('toast.parseFail') + (e as Error).message);
    }
  }
  function doMinify() {
    if (!result) return;
    try {
      runParse(minifyJson(source, format === 'auto' ? undefined : { format }), format);
      showToast(t('toast.minified'));
    } catch (e) {
      showToast(t('toast.minifyFail') + (e as Error).message);
    }
  }
  function doSortKeys() {
    if (!result) return;
    try {
      runParse(shapeToJson(result, { pretty: true, sort: true }), format);
      showToast(t('toast.sorted'));
    } catch (e) {
      showToast(t('toast.sortFail') + (e as Error).message);
    }
  }

  function exportAs(f: SupportedFormat) {
    if (!result) return;
    const plain = astForExport(result);
    let content = '';
    let mime = 'text/plain';
    let ext = f;
    try {
      if (f === 'json') {
        content = shapeToJson(result, { pretty: true });
        mime = 'application/json';
      } else if (f === 'yaml') {
        content = YAML.stringify(plain);
        mime = 'text/yaml';
      } else if (f === 'toml') {
        content = shapeToJson(result, { pretty: true });
        ext = 'json';
        mime = 'application/json';
      } else if (f === 'csv') {
        content = Papa.unparse(Array.isArray(plain) ? (plain as unknown[]) : [plain]);
        mime = 'text/csv';
      }
      download(`jsona-export.${ext}`, content, mime);
      showToast(`${t('toast.exported')} ${f.toUpperCase()}`);
    } catch (e) {
      showToast(t('toast.exportFail') + (e as Error).message);
    }
  }

  function switchLocale() {
    const next: Locale = locale === 'zh-CN' ? 'en' : 'zh-CN';
    setLocale(next);
    setStoredLocale(next);
    document.documentElement.setAttribute('lang', next);
  }

  // --- Command palette ---
  const commands = useMemo(() => {
    const list: { id: string; label: string; hint?: string; run: () => void; disabled?: boolean }[] = [
      { id: 'open', label: t('cmd.open'), hint: '上传', run: () => fileInput.current?.click() },
      { id: 'format', label: t('cmd.format'), hint: 'Format', run: doFormat, disabled: !result },
      { id: 'minify', label: t('cmd.minify'), hint: 'Minify', run: doMinify, disabled: !result },
      { id: 'sort', label: t('cmd.sort'), run: doSortKeys, disabled: !result },
      ...EXPORT_FORMATS.map((f) => ({
        id: `export-${f}`,
        label: `${t('cmd.export')} ${f.toUpperCase()}`,
        hint: 'Export',
        run: () => exportAs(f),
        disabled: !result,
      })),
      { id: 'view-tree', label: `${t('cmd.switch')} ${t('view.tree')}`, run: () => { setRightView('tree'); setPanelCollapsed(false); } },
      { id: 'view-column', label: `${t('cmd.switch')} ${t('view.column')}`, run: () => { setRightView('column'); setPanelCollapsed(false); } },
      { id: 'view-graph', label: `${t('cmd.switch')} ${t('view.graph')}`, run: () => { setRightView('graph'); setPanelCollapsed(false); } },
      { id: 'view-flow', label: `${t('cmd.switch')} ${t('view.flow')}`, run: () => { setRightView('flow'); setPanelCollapsed(false); } },
      { id: 'view-share', label: `${t('cmd.switch')} ${t('view.share')}`, run: () => { setRightView('share'); setPanelCollapsed(false); } },
      { id: 'view-compare', label: `${t('cmd.switch')} ${t('view.compare')}`, run: () => { setRightView('compare'); setPanelCollapsed(false); } },
    ];
    return list;
  }, [result, doFormat, doMinify, doSortKeys, exportAs, t]);

  const ACTIVITY: { id: ActivityView; labelKey: string; icon: string }[] = [
    { id: 'tree', labelKey: 'view.tree', icon: 'tree' },
    { id: 'column', labelKey: 'view.column', icon: 'column' },
    { id: 'graph', labelKey: 'view.graph', icon: 'graph' },
    { id: 'flow', labelKey: 'view.flow', icon: 'flow' },
    { id: 'share', labelKey: 'view.share', icon: 'share' },
    { id: 'compare', labelKey: 'view.compare', icon: 'compare' },
  ];

  const rightTitle = t(`view.${rightView}`);

  const valid = !error && !!result;

  return (
    <I18nProvider locale={locale} setLocale={setLocale}>
      <div className="app">
      {/* ---------------- Top bar ---------------- */}
      <header className="topbar">
        <div className="topbar-left">
          <button className="brand" onClick={() => { setSource(''); setSelected(null); }} title={t('app.subtitle')}>
            <span className="brand-mark">jsona</span>
          </button>
          <div className="format-switch" title={t('topbar.open')}>
            {FORMATS.map((f) => (
              <button
                key={f}
                className={format === f ? 'fmt active' : 'fmt'}
                onClick={() => onFormatChange(f)}
              >
                {f === 'auto' ? t('format.auto') : f.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="format-switch-mobile">
            <button
              className="fmt-toggle"
              onClick={() => setFmtOpen((o) => !o)}
              aria-expanded={fmtOpen}
            >
              {format === 'auto' ? t('format.auto') : format.toUpperCase()}
              <span className="fmt-caret">▾</span>
            </button>
            {fmtOpen && (
              <div className="fmt-menu">
                {FORMATS.map((f) => (
                  <button
                    key={f}
                    className={format === f ? 'fmt-item active' : 'fmt-item'}
                    onClick={() => { onFormatChange(f); setFmtOpen(false); }}
                  >
                    {f === 'auto' ? t('format.auto') : f.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="topbar-center">
          <button className="command-btn" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={15} />
            <span>{t('topbar.command')}</span>
            <kbd>⌘K</kbd>
          </button>
        </div>

        <div className="topbar-right">
          <button className="tool-btn" onClick={() => fileInput.current?.click()}>
            <Icon name="document" size={15} /> <span className="tb-label">{t('topbar.open')}</span>
          </button>
          <button className="tool-btn" onClick={doFormat} disabled={!result}>
            <Icon name="format" size={15} /> <span className="tb-label">{t('topbar.format')}</span>
          </button>
          <button className="tool-btn" onClick={doMinify} disabled={!result}>
            <Icon name="minify" size={15} /> <span className="tb-label">{t('topbar.minify')}</span>
          </button>
          <button className="tool-btn ai" onClick={() => setAiOpen(true)} title={t('topbar.ai')}>
            <Icon name="sparkles" size={15} /> <span className="tb-label">{t('topbar.ai')}</span>
          </button>
          <span className="topbar-divider" />
          <button className="icon-btn" title={t('topbar.theme')} onClick={() => setTheme((p) => (p === 'dark' ? 'light' : 'dark'))}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
          <button className="icon-btn" title={t('topbar.lang')} onClick={switchLocale}>
            <Icon name="globe" size={16} />
            <span className="lang-label">{locale === 'zh-CN' ? t('lang.zh') : t('lang.en')}</span>
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.yaml,.yml,.toml,.csv,.txt"
          style={{ display: 'none' }}
          onChange={onFile}
        />
      </header>

      {/* ---------------- Body: activity bar + editor + panel ---------------- */}
      <div className="body">
        {/* Activity bar */}
        <nav className="activity-bar" aria-label={t('topbar.lang')}>
          {ACTIVITY.map((a) => (
            <button
              key={a.id}
              className={rightView === a.id && !panelCollapsed ? 'activity active' : 'activity'}
              title={t(a.labelKey)}
              onClick={() => { setRightView(a.id); setPanelCollapsed(false); }}
            >
              <Icon name={a.icon} />
              <span className="activity-label">{t(a.labelKey)}</span>
            </button>
          ))}
          <div className="activity-bottom">
            <button
              className={panelCollapsed ? 'activity active' : 'activity'}
              title={t('view.source')}
              onClick={() => setPanelCollapsed((c) => !c)}
            >
              <Icon name="panel" />
              <span className="activity-label">{panelCollapsed ? t('panel.expand') : t('panel.collapse')}</span>
            </button>
            <button
              className="activity"
              title={t('topbar.help')}
              onClick={() => setHelpOpen(true)}
            >
              <Icon name="help" />
              <span className="activity-label">{t('topbar.help')}</span>
            </button>
          </div>
        </nav>

        {/* Main split: source editor (left) + secondary view (right, draggable) */}
        <div className="workspace">
          <section className="editor-pane" style={{ flexBasis: panelCollapsed ? '100%' : `${100 - rightPct}%` }}>
            <div className="pane-head">
              <span className="pane-title">
                <Icon name="document" size={14} /> {t('view.source')}
              </span>
              {result && (
                <span className="pane-meta">
                  {result.formatLabel} · {result.nodeCount} {t('status.nodes')}
                </span>
              )}
              <button
                className="pane-action"
                title={t('view.clear')}
                aria-label={t('view.clear')}
                onClick={() => { setSource(''); }}
                disabled={!source}
              >
                <Icon name="clear" size={14} />
              </button>
            </div>
            <div className="pane-body has-editor">
              <SourceEditor
                ref={editorRef}
                value={source}
                format={result?.format ?? (format === 'auto' ? detectFormat(source) || 'json' : format)}
                theme={theme}
                onChange={onSourceChange}
                onCursorOffset={onCursor}
              />
            </div>
          </section>

          {!panelCollapsed && (
            <>
              <div
                className="resizer"
                onPointerDown={onResizerDown}
                role="separator"
                aria-orientation="vertical"
                title={t('view.source')}
              />
              <section className="view-pane" style={{ flexBasis: `${rightPct}%` }}>
                <div className="pane-head">
                  <span className="pane-title">{rightTitle}</span>
                  {(rightView === 'tree' || rightView === 'column') && (
                    <input
                      className="search inline"
                      placeholder={t('view.search')}
                      value={treeQuery}
                      onChange={(e) => setTreeQuery(e.target.value)}
                    />
                  )}
                  <div className="pane-actions">
                    {/* View tabs: quick switch among the secondary views */}
                    {ACTIVITY.map((a) => (
                      <button
                        key={a.id}
                        className={rightView === a.id ? 'vt-tab active' : 'vt-tab'}
                        onClick={() => setRightView(a.id)}
                      >
                        {t(a.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pane-body">
                  {result ? (
                    <div className="view-scroll" key={rightView}>
                      {rightView === 'tree' && (
                        <>
                          {selected && (
                            <Suspense fallback={null}>
                              <Breadcrumb root={result.root} selectedId={selected.id} onSelect={onSelect} />
                            </Suspense>
                          )}
                          {treeQuery.trim() ? (
                            <SearchResults
                              root={result.root}
                              query={treeQuery}
                              onPick={(n) => { setRightView('tree'); onSelect(n); }}
                            />
                          ) : (
                            <VirtualTree
                              root={result.root}
                              query={treeQuery}
                              selectedId={selected?.id ?? null}
                              onSelect={onSelect}
                            />
                          )}
                        </>
                      )}
                      {rightView === 'column' && (
                        <Suspense fallback={<ViewFallback label={t('view.column')} />}>
                          <ColumnView
                            root={result.root}
                            source={source}
                            query={treeQuery}
                            onUpdate={setSource}
                            selectedId={selected?.id ?? null}
                            onSelect={onSelect}
                          />
                        </Suspense>
                      )}
                      {rightView === 'flow' && (
                        <Suspense fallback={<ViewFallback label={t('view.flow')} />}>
                          <FlowView root={result.root} selectedId={selected?.id ?? null} onSelect={onSelect} />
                        </Suspense>
                      )}
                      {rightView === 'share' && (
                        <Suspense fallback={<ViewFallback label={t('view.share')} />}>
                          <ShareView source={source} format={format} onDocument={(s, f) => runParse(s, f)} />
                        </Suspense>
                      )}
                      {rightView === 'compare' && (
                        <Suspense fallback={<ViewFallback label={t('view.compare')} />}>
                          <CompareView format={format} onSelect={onSelect} />
                        </Suspense>
                      )}
                      {rightView === 'graph' &&
                        (graphData ? (
                          <Suspense fallback={<ViewFallback label={t('view.graph')} />}>
                            <GraphView
                              graph={graphData}
                              selectedId={selected?.id ?? undefined}
                              onSelect={(id: string) => { const n = findNodeById(id); if (n) setSelected(n); }}
                            />
                          </Suspense>
                        ) : (
                          <div className="muted" style={{ padding: 16 }}>{t('view.graph')}…</div>
                        ))}
                    </div>
                  ) : (
                    <div className="welcome">
                      <div className="welcome-head">
                        <span className="welcome-glyph">jsona</span>
                        <span className="welcome-tagline">{t('welcome.tagline')}</span>
                        <p className="welcome-sub">{t('welcome.sub')}</p>
                        <div className="welcome-features">
                          {t('welcome.features').split('·').map((f) => (
                            <span key={f.trim()} className="feature-badge">{f.trim()}</span>
                          ))}
                        </div>
                      </div>
                      <div className="welcome-samples">
                        <span className="welcome-label">{t('welcome.trySample')}</span>
                        <div className="sample-row">
                          {SAMPLES.map((s) => (
                            <button key={s.id} className="sample-chip" data-fmt={s.format} onClick={() => loadSample(s)}>
                              <span className="sample-fmt">{s.format.toUpperCase()}</span>
                              <span className="sample-name">{t(s.labelKey)}</span>
                              <span className="sample-go">→</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="welcome-hint">
                        {t('welcome.hint1')} <kbd>⌘K</kbd> {t('welcome.hint2')}
                        {' · '}{t('welcome.hint3')}
                      </p>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      {/* ---------------- Status bar ---------------- */}
      <footer className="statusbar">
        <div className="status-left">
          <span className={valid ? 'st-ok' : error ? 'st-err' : 'st-idle'}>
            <Icon name={valid ? 'check' : error ? 'x' : 'document'} size={13} />
            {valid ? t('status.valid') : error ? t('status.invalid') : t('status.none')}
          </span>
          {selected && <span className="st-sep">·</span>}
          {selected && <span className="st-path">{selected.path}</span>}
        </div>
        <div className="status-right">
          {result && <span>{result.nodeCount} {t('status.nodes')}</span>}
          {result && <span className="st-sep">·</span>}
          <span>{t('status.line')} {cursorLine}, {t('status.col')} {cursorCol}</span>
          <span className="st-sep">·</span>
          <span className="st-fmt">{format === 'auto' ? 'AUTO' : format.toUpperCase()}</span>
          <span className="st-sep">·</span>
          <a className="st-copy" href="https://www.jsona.cn/" target="_blank" rel="noopener noreferrer">© {new Date().getFullYear()} jsona</a>
        </div>
      </footer>

      {/* ---------------- Command palette ---------------- */}
      {paletteOpen && (
        <div className="palette-overlay" onClick={() => setPaletteOpen(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <div className="palette-input">
              <Icon name="search" size={16} />
              <input
                autoFocus
                placeholder={t('palette.placeholder')}
                onChange={() => {}}
              />
              <kbd>Esc</kbd>
            </div>
            <ul className="palette-list">
              {commands.map((c) => (
                <li key={c.id}>
                  <button
                    className="palette-item"
                    disabled={c.disabled}
                    onClick={() => { c.run(); setPaletteOpen(false); }}
                  >
                    <span className="palette-label">{c.label}</span>
                    {c.hint && <span className="palette-hint">{c.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ---------------- AI panel ---------------- */}
      {aiOpen && (
        <div className="ai-overlay" onClick={() => setAiOpen(false)}>
          <div className="ai-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ai-modal-head">
              <span><Icon name="sparkles" size={16} /> {t('topbar.ai')}</span>
              <button className="icon-btn" onClick={() => setAiOpen(false)} title={t('ai.close')}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <AiPanel
              result={result}
              selected={selected}
              locale={locale}
              tier={workspace.tier as 'free' | 'pro' | 'team' | null}
              login={workspace.login ?? null}
              format={format}
              onApplyToDocument={(s, f) => runParse(s, f)}
            />
          </div>
        </div>
      )}

      {helpOpen && (
        <div className="ai-overlay" onClick={() => setHelpOpen(false)}>
          <div className="ai-modal help-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ai-modal-head">
              <span><Icon name="help" size={16} /> {t('help.title')}</span>
              <button className="icon-btn" onClick={() => setHelpOpen(false)} title={t('ai.close')}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="help-body">
              <section className="help-section">
                <h4>{t('help.getStarted')}</h4>
                <ul>
                  <li>{t('help.paste')}</li>
                  <li>{t('help.openFile')}</li>
                  <li>{t('help.sample')}</li>
                </ul>
              </section>
              <section className="help-section">
                <h4>{t('help.views')}</h4>
                <ul>
                  <li><b>{t('view.tree')}</b> — {t('help.tree')}</li>
                  <li><b>{t('view.column')}</b> — {t('help.column')}</li>
                  <li><b>{t('view.graph')}</b> — {t('help.graph')}</li>
                  <li><b>{t('view.compare')}</b> — {t('help.compare')}</li>
                  <li><b>{t('view.share')}</b> — {t('help.share')}</li>
                  <li><b>{t('topbar.ai')}</b> — {t('help.ai')}</li>
                </ul>
              </section>
              <section className="help-section">
                <h4>{t('help.shortcuts')}</h4>
                <ul>
                  <li><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> — {t('help.cmdk')}</li>
                  <li><kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> — {t('help.format')}</li>
                </ul>
              </section>
              <p className="help-foot">{t('help.foot')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      {toast && <div className="toast-float">{toast}</div>}

      {/* Parsing / error / sample banners */}
      {parsing && progress >= 0 && (
        <div className="banner">
          <div className="progress-inline">
            <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="muted">{t('parse.parsing')} {Math.round(progress * 100)}%</span>
        </div>
      )}
      {error && (() => {
        // In auto mode, the parser may mis-classify unambiguous input (e.g. a CSV
        // whose leading invisible char pushed `detectFormat` into the JSON branch
        // and then tripped on the first letter). Offer a one-click escape hatch:
        // re-parse with a format chosen by the user.
        const offerFormatSwitch = format === 'auto' && detectFormat(source) === 'csv';
        return (
          <>
            <ErrorCard
              error={humanizeError(error, source, format === 'auto' ? detectFormat(source) : format, t)}
              source={source}
              diagnostics={diagnostics ?? undefined}
              onJump={(line) => editorRef.current?.scrollToLine(line)}
              onFix={(fixed) => {
                onSourceChange(fixed);
                const he = humanizeError(error, fixed, format === 'auto' ? detectFormat(fixed) : format, t);
                if (he.line != null) editorRef.current?.scrollToLine(he.line);
              }}
              collapsed={errorCollapsed}
              onToggle={() => setErrorCollapsed((v) => !v)}
            />
            {offerFormatSwitch && (
              <button
                className="btn-sm errcard-csv-btn"
                onClick={() => onFormatChange('csv')}
                title={t('error.csvReparseHint')}
              >
                {t('error.csvReparse')}
              </button>
            )}
          </>
        );
      })()}
      </div>
    </I18nProvider>
  );
}
