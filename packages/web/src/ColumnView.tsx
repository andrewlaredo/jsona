import { useState, useEffect, useMemo, useRef } from 'react';
import type { JsonNode } from 'jsona-core';
import { useT } from './i18n';

interface Props {
  /** Root of the parsed document (used for cross-level search & path expansion). */
  root: JsonNode | null;
  /** Convenience: the same as root, kept for the original signature. */
  node?: JsonNode | null;
  source: string;
  /** Cross-level search query (driven by the shared top search box, like the tree view). */
  query?: string;
  onUpdate: (next: string) => void;
  /** Currently selected node id (syncs from tree / source editor). */
  selectedId?: string | null;
  /** Called when a column row is activated; selects the node (highlights source). */
  onSelect?: (node: JsonNode) => void;
}

interface Column {
  path: string;
  items: JsonNode[];
}

/** Walk the document and return a list of nodes whose path matches the query. */
function searchAll(root: JsonNode, query: string): JsonNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: JsonNode[] = [];
  const walk = (n: JsonNode) => {
    const key = (n.key ?? '').toLowerCase();
    const val = n.kind === 'object' || n.kind === 'array' ? '' : String(n.value ?? '').toLowerCase();
    if (key.includes(needle) || val.includes(needle) || (n.path ?? '').toLowerCase().includes(needle)) {
      out.push(n);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Resolve the chain of ancestors (including the node itself) for a path. */
function pathChain(root: JsonNode, targetPath: string): JsonNode[] {
  const segments = targetPath.split('.');
  const chain: JsonNode[] = [];
  let cur = root;
  let acc = '';
  for (const seg of segments) {
    if (!cur || !cur.children) break;
    const child = cur.children.find((c) => c.key === seg || c.key === String(Number(seg)));
    if (!child) break;
    acc = acc ? `${acc}.${String(child.key ?? '')}` : String(child.key ?? '');
    chain.push(child);
    cur = child;
  }
  return chain;
}

export function ColumnView({ root, node, source, query = '', onUpdate, selectedId, onSelect }: Props) {
  const t = useT();
  const base = root ?? node ?? null;
  const [columns, setColumns] = useState<Column[]>([]);
  const [activePath, setActivePath] = useState<string>('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [isJson, setIsJson] = useState(true);
  const [toast, setToast] = useState<string>('');
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Rebuild the root column whenever the tree changes.
  useEffect(() => {
    setColumns(base ? [{ path: '', items: base.children ?? [] }] : []);
    setActivePath('');
    setEditing(null);
  }, [base]);

  useEffect(() => {
    if (!source.trim()) {
      setIsJson(true);
      return;
    }
    try {
      JSON.parse(source);
      setIsJson(true);
    } catch {
      setIsJson(false);
    }
  }, [source]);

  // When an external selection arrives (tree / source click), expand the column
  // chain down to that node so the column view stays in sync with the source.
  useEffect(() => {
    if (!selectedId || !base) return;
    // Find the node by id to get its path.
    const found: JsonNode[] = [];
    const walk = (n: JsonNode) => {
      if (found.length) return;
      if (n.id === selectedId) {
        found.push(n);
        return;
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(base);
    const hit = found[0];
    if (!hit || !hit.path) return;
    const hitPath = hit.path;
    const chain = pathChain(base, hitPath);
    const cols: Column[] = [{ path: '', items: base.children ?? [] }];
    let acc = '';
    for (const nodeInChain of chain) {
      const k = String(nodeInChain.key ?? '');
      acc = acc ? `${acc}.${k}` : k;
      cols.push({ path: acc, items: nodeInChain.children ?? [] });
    }
    setColumns(cols);
    setActivePath(hitPath);
  }, [selectedId, base]);

  const handleDrill = (parentPath: string, child: JsonNode) => {
    if (child.kind !== 'object' && child.kind !== 'array') return;
    const childKey = child.key ?? '';
    const childPath = parentPath ? `${parentPath}.${childKey}` : childKey;
    setColumns((prev) => {
      const idx = prev.findIndex((c) => c.path === parentPath);
      if (idx === -1) return prev;
      const next = prev.slice(0, idx + 1);
      next.push({ path: childPath, items: child.children ?? [] });
      return next;
    });
    setActivePath(childPath);
    setEditing(null);
    onSelect?.(child);
  };

  const handleBack = (colIndex: number) => {
    setColumns((prev) => prev.slice(0, colIndex + 1));
    setColumns((prev) => {
      const target = prev[colIndex];
      setActivePath(target ? target.path : '');
      return prev;
    });
    setEditing(null);
  };

  const startEdit = (path: string, value: string) => {
    if (!isJson) return;
    setEditing(path);
    setDraft(value);
  };

  const commitEdit = (path: string) => {
    if (!isJson) {
      setEditing(null);
      return;
    }
    try {
      const parsed = JSON.parse(source);
      const segments = path.split('.').map((s) => (/\d+/.test(s) ? Number(s) : s));
      let cursor: any = parsed;
      for (let i = 0; i < segments.length - 1; i++) cursor = cursor[segments[i]];
      const last = segments[segments.length - 1];
      let newVal: any = draft;
      if (draft === 'true') newVal = true;
      else if (draft === 'false') newVal = false;
      else if (draft === 'null') newVal = null;
      else if (draft !== '' && !isNaN(Number(draft))) newVal = Number(draft);
      cursor[last] = newVal;
      onUpdate(JSON.stringify(parsed, null, 2));
      showToast(t('column.editSaved'));
    } catch {
      /* ignore malformed edits */
    }
    setEditing(null);
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 1600);
  };

  const renderValue = (child: JsonNode) => {
    if (child.kind === 'object' || child.kind === 'array') {
      const count = child.children?.length ?? 0;
      return `${child.kind === 'array' ? '[' : '{'} ${count} ${child.kind === 'array' ? ']' : '}'}`;
    }
    return String(child.value ?? '');
  };

  // Cross-level search: when a query is present, expand the chain to the first
  // matching node and render its column; also collect all matches for a picker.
  const searchMatches = useMemo(() => (base && query.trim() ? searchAll(base, query) : []), [base, query]);
  const searchColumns = useMemo(() => {
    if (!base || !query.trim() || searchMatches.length === 0) return null;
    const first = searchMatches[0];
    const chain = pathChain(base, first.path ?? '');
    const cols: Column[] = [{ path: '', items: base.children ?? [] }];
    let acc = '';
    for (const n of chain) {
      const k = String(n.key ?? '');
      acc = acc ? `${acc}.${k}` : k;
      cols.push({ path: acc, items: n.children ?? [] });
    }
    return cols;
  }, [base, query, searchMatches]);

  const displayColumns = searchColumns ?? columns;

  // Auto-follow: whenever the number of visible columns changes (drill-in,
  // back, or external selection expanding the chain), scroll the horizontal
  // bar to reveal the newest (right-most) column.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [displayColumns.length]);

  return (
    <div className="panel column-view">
      <div className="column-head">
        <div className="column-actions">
          {query.trim() && (
            <span className="column-search-count">
              {searchMatches.length} {t('search.resultsCount')}
            </span>
          )}
        </div>
      </div>
      <div className="cv-scroller" ref={scrollerRef}>
        {searchMatches.length > 0 ? (
          <div className="cv-search-list">
            {searchMatches.slice(0, 100).map((m) => (
              <div
                key={m.id}
                className={`cv-row${m.id === selectedId ? ' active' : ''}`}
                onClick={() => {
                  onSelect?.(m);
                  const chain = pathChain(base!, m.path ?? '');
                  const cols: Column[] = [{ path: '', items: base!.children ?? [] }];
                  let acc = '';
                  for (const n of chain) {
                    const k = String(n.key ?? '');
                    acc = acc ? `${acc}.${k}` : k;
                    cols.push({ path: acc, items: n.children ?? [] });
                  }
                  setColumns(cols);
                  setActivePath(m.path ?? '');
                }}
                title={m.path ?? ''}
              >
                <span className="cv-key">{m.key ?? (m.path ?? '$')}</span>
                <span className="cv-val muted">{m.path ?? ''}</span>
                {m.kind !== 'object' && m.kind !== 'array' && (
                  <span className={`cv-val kind-${m.kind}`}>{String(m.value ?? '')}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          displayColumns.map((col, ci) => (
            <div className="cv-col" key={col.path || `root-${ci}`}>
              <div className="cv-col-head">
                {ci > 0 && (
                  <button
                    className="cv-mini"
                    title={t('column.back')}
                    onClick={() => handleBack(ci - 1)}
                    style={{ opacity: 1 }}
                  >
                    ‹
                  </button>
                )}
                <span className="cv-col-title">{col.path || t('column.root')}</span>
                <span className="cv-col-count">{col.items.length}</span>
              </div>
              <div className="cv-col-body">
                {col.items.length === 0 ? (
                  <div className="cv-empty">{t('column.empty')}</div>
                ) : (
                  col.items.map((child) => {
                    const key = child.key ?? '';
                    const path = col.path ? `${col.path}.${key}` : key;
                    const isExpandable = child.kind === 'object' || child.kind === 'array';
                    const isEditing = editing === path;
                    const isActive = activePath === path || child.id === selectedId;
                    return (
                      <div
                        key={path}
                        className={`cv-row${isActive ? ' active' : ''}`}
                        onClick={() => {
                          if (isEditing) return;
                          if (isExpandable) handleDrill(col.path, child);
                          else onSelect?.(child);
                        }}
                      >
                        <span className={`cv-arrow${isExpandable ? '' : ' hidden'}`}>
                          {isExpandable ? '▸' : ''}
                        </span>
                        <span className="cv-key" title={path}>
                          {key}
                        </span>
                        <span className={`cv-val kind-${child.kind}`}>
                          {isEditing ? (
                            <input
                              className="cv-edit"
                              autoFocus
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit(path);
                                if (e.key === 'Escape') setEditing(null);
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            renderValue(child)
                          )}
                        </span>
                        {!isEditing && !isExpandable && (
                          <button
                            className="cv-mini"
                            title={t('column.edit')}
                            onClick={(e) => {
                              e.stopPropagation();
                              startEdit(path, String(child.value ?? ''));
                            }}
                            disabled={!isJson}
                          >
                            ✎
                          </button>
                        )}
                        {isEditing && (
                          <>
                            <button
                              className="cv-mini"
                              title={t('column.editSave')}
                              onClick={(e) => {
                                e.stopPropagation();
                                commitEdit(path);
                              }}
                              style={{ opacity: 1 }}
                            >
                              ✓
                            </button>
                            <button
                              className="cv-mini"
                              title={t('column.editCancel')}
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditing(null);
                              }}
                              style={{ opacity: 1 }}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ))
        )}
        {query.trim() && searchMatches.length === 0 && (
          <div className="cv-empty" style={{ padding: 16 }}>
            {t('column.noMatch')}
          </div>
        )}
      </div>
      {toast && <div className="cv-toast">{toast}</div>}
    </div>
  );
}

export default ColumnView;
