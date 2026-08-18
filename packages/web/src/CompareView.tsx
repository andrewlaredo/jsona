import { useEffect, useMemo, useState } from 'react';
import { parse, diffTrees, queryPath, detectFormat, type DiffEntry, type JsonNode, type SupportedFormat, type ParseResult, type NodeKind } from 'jsona-core';
import { humanizeError, type HumanizedError } from './errorHumanizer';
import { useT } from './i18n';

interface Props {
  format: SupportedFormat | 'auto';
  /** Locate a changed node in the main tree + source view. */
  onSelect?: (node: JsonNode) => void;
}

type FilterOp = DiffEntry['op'] | 'all';

const PAGE_SIZE = 200;
const DEBOUNCE_MS = 250;

function parseOrNull(src: string, format: SupportedFormat | 'auto', t?: (k: string) => string): ParseResult | { error: HumanizedError } {
  try {
    return parse(src, format === 'auto' ? undefined : { format });
  } catch (e) {
    const raw = (e as Error).message;
    const fmt = format === 'auto' ? detectFormat(src) : format;
    return { error: humanizeError(raw, src, fmt, t) };
  }
}

/** A top-level section of a path, used to group diffs into "dimensions". */
function topGroup(path: string): string {
  const m = path.match(/^\.([^.[\]]+)/);
  return m ? m[1] : '(root)';
}

function kindLabel(kind: NodeKind): string {
  return { object: 'object', array: 'array', string: 'string', number: 'number', boolean: 'boolean', null: 'null' }[kind];
}

function valueText(node?: JsonNode): string {
  if (!node) return '—';
  if (node.kind === 'object') return '{…}';
  if (node.kind === 'array') return '[…]';
  if (node.value === null) return 'null';
  if (typeof node.value === 'string') return JSON.stringify(node.value);
  return String(node.value);
}

/** A user-defined weighting rule for a dimension (top-level group). */
interface WeightRule {
  id: number;
  group: string; // top-level section name, or '' = global default
  weight: number; // 0–5
}

export function CompareView({ format, onSelect }: Props) {
  const t = useT();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [diff, setDiff] = useState<DiffEntry[] | null>(null);
  const [errors, setErrors] = useState<{ a?: HumanizedError; b?: HumanizedError }>({});
  const [filter, setFilter] = useState<FilterOp>('all');
  const [page, setPage] = useState(0);

  // Live compare toggle + custom weights.
  const [live, setLive] = useState(true);
  const [weights, setWeights] = useState<WeightRule[]>([{ id: 0, group: '', weight: 1 }]);
  const [editingWeight, setEditingWeight] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Real-time updates: recompute (debounced) whenever either side changes.
  useEffect(() => {
    if (!live) return;
    const timer = window.setTimeout(() => runDiff(), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, live]);

  function runDiff() {
    const ra = parseOrNull(a, format, t);
    const rb = parseOrNull(b, format, t);
    if ('error' in ra) {
      setErrors({ a: ra.error });
      setDiff(null);
      return;
    }
    if ('error' in rb) {
      setErrors({ b: rb.error });
      setDiff(null);
      return;
    }
    setErrors({});
    setDiff(diffTrees(ra.root, rb.root));
    setPage(0);
  }

  // Locate a diff entry's node in its source document and report it upward so
  // the tree + source view can jump to / highlight it.
  const locate = (d: DiffEntry) => {
    if (!onSelect) return;
    const src = d.op === 'removed' ? a : b;
    if (!src.trim()) return;
    try {
      const res = parse(src, format === 'auto' ? undefined : { format });
      const node = queryPath(res.root, d.path);
      if (node) onSelect(node);
    } catch {
      /* ignore unparseable comparison text */
    }
  };

  const counts = useMemo(() => {
    const base = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    if (!diff) return base;
    for (const d of diff) base[d.op]++;
    return base;
  }, [diff]);

  const filtered = useMemo(() => {
    if (!diff) return [];
    if (filter === 'all') return diff;
    return diff.filter((d) => d.op === filter);
  }, [diff, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, DiffEntry[]>();
    for (const d of filtered) {
      const g = topGroup(d.path);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(d);
    }
    return [...map.entries()].sort((x, y) => y[1].length - x[1].length);
  }, [filtered]);

  // Weighted "impact" score: each changed entry contributes its dimension weight.
  const impact = useMemo(() => {
    if (!diff) return { score: 0 };
    const defaultW = weights.find((w) => w.group === '')?.weight ?? 1;
    let score = 0;
    for (const d of diff) {
      if (d.op === 'unchanged') continue;
      const g = topGroup(d.path);
      const w = weights.find((x) => x.group === g)?.weight ?? defaultW;
      score += w;
    }
    return { score };
  }, [diff, weights]);

  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);

  const pageGroups = useMemo(() => {
    const start = page * PAGE_SIZE;
    const slice = filtered.slice(start, start + PAGE_SIZE);
    const map = new Map<string, DiffEntry[]>();
    for (const d of slice) {
      const g = topGroup(d.path);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(d);
    }
    return [...map.entries()].sort((x, y) => y[1].length - x[1].length);
  }, [filtered, page]);

  const filters: FilterOp[] = ['all', 'added', 'removed', 'changed'];

  const groupNames = useMemo(() => groups.map((g) => g[0]), [groups]);
  const addWeightRule = () => {
    const used = new Set(weights.map((w) => w.group));
    const free = groupNames.find((g) => g !== '' && !used.has(g)) ?? '';
    setWeights((ws) => [...ws, { id: Date.now(), group: free, weight: 2 }]);
  };
  const updateWeight = (id: number, patch: Partial<WeightRule>) =>
    setWeights((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const removeWeight = (id: number) => setWeights((ws) => ws.filter((w) => w.id !== id));

  const toggleGroup = (g: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const hasContent = a.trim() || b.trim();
  const total = diff?.length ?? 0;
  const changedPct = total ? Math.round(((counts.added + counts.removed + counts.changed) / total) * 100) : 0;

  const opLabel: Record<DiffEntry['op'], string> = {
    added: t('compare.op.added'),
    removed: t('compare.op.removed'),
    changed: t('compare.op.changed'),
    unchanged: t('compare.op.unchanged'),
  };
  const opGlyph: Record<DiffEntry['op'], string> = { added: '+', removed: '−', changed: '~', unchanged: '=' };

  return (
    <div className="panel compare-view">
      <div className="panel-head compare-head">
        <span className="panel-title">
          <span className="panel-title-glyph">⇄</span>{t('compare.title')}
        </span>
        <span className="share-meta">
          {hasContent ? (
            <span className={`share-meta-pill ${diff ? 'ok' : 'err'}`}>
              <span className="dot" />
              {diff ? `${total} ${t('compare.totalNodes')} · ${t('compare.diffPct')} ${changedPct}%` : t('compare.parsing')}
            </span>
          ) : (
            <span className="share-meta-pill err">
              <span className="dot" /> {t('compare.pending')}
            </span>
          )}
        </span>

        <label className="cmp-live" title={t('compare.liveHint')}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          <span>{t('compare.live')}</span>
        </label>
        {!live && (
          <button className="btn-sm primary cmp-run" onClick={runDiff}>
            {t('compare.run')}
          </button>
        )}
      </div>

      <div className="panel-body cmp-body">
        <div className="compare-grid">
          <div className="cmp-col">
            <div className="cmp-col-head">
              <span className="cmp-col-badge a">A</span> {t('compare.sideA')}
            </div>
            <textarea
              className="compare-input"
              placeholder={t('compare.placeholderA')}
              spellCheck={false}
              value={a}
              onChange={(e) => setA(e.target.value)}
            />
            {errors.a && (
              <div className="result error cmp-err">
                <b>{errors.a.title}</b>
                {errors.a.line != null && <span className="muted"> · {t('error.line')} {errors.a.line}</span>}
                <div className="muted cmp-err-hint">{errors.a.hint}</div>
              </div>
            )}
          </div>
          <div className="cmp-col">
            <div className="cmp-col-head">
              <span className="cmp-col-badge b">B</span> {t('compare.sideB')}
            </div>
            <textarea
              className="compare-input"
              placeholder={t('compare.placeholderB')}
              spellCheck={false}
              value={b}
              onChange={(e) => setB(e.target.value)}
            />
            {errors.b && (
              <div className="result error cmp-err">
                <b>{errors.b.title}</b>
                {errors.b.line != null && <span className="muted"> · {t('error.line')} {errors.b.line}</span>}
                <div className="muted cmp-err-hint">{errors.b.hint}</div>
              </div>
            )}
          </div>
        </div>

        {!hasContent ? (
          <div className="cmp-empty">
            <span className="cmp-empty-glyph">⇄</span>
            <span>{t('compare.empty')}</span>
          </div>
        ) : (
          diff && (
            <>
              <div className="cmp-overview">
                <div className="cmp-stat">
                  <span className="cmp-stat-num">{total}</span>
                  <span className="cmp-stat-label">{t('compare.totalNodes')}</span>
                </div>
                <div className="cmp-stat op-added">
                  <span className="cmp-stat-num">{counts.added}</span>
                  <span className="cmp-stat-label">{t('compare.added')}</span>
                </div>
                <div className="cmp-stat op-removed">
                  <span className="cmp-stat-num">{counts.removed}</span>
                  <span className="cmp-stat-label">{t('compare.removed')}</span>
                </div>
                <div className="cmp-stat op-changed">
                  <span className="cmp-stat-num">{counts.changed}</span>
                  <span className="cmp-stat-label">{t('compare.changed')}</span>
                </div>
                <div className="cmp-stat">
                  <span className="cmp-stat-num">{impact.score}</span>
                  <span className="cmp-stat-label">{t('compare.impact')}</span>
                </div>
              </div>

              <div className="cmp-bar" title="operation type proportion">
                <span className="cmp-bar-seg op-added" style={{ width: `${total ? (counts.added / total) * 100 : 0}%` }} />
                <span className="cmp-bar-seg op-removed" style={{ width: `${total ? (counts.removed / total) * 100 : 0}%` }} />
                <span className="cmp-bar-seg op-changed" style={{ width: `${total ? (counts.changed / total) * 100 : 0}%` }} />
                <span className="cmp-bar-seg op-unchanged" style={{ width: `${total ? (counts.unchanged / total) * 100 : 0}%` }} />
              </div>

              <div className="cmp-dims">
                <div className="cmp-dims-head">
                  <span className="cmp-dims-title">{t('compare.dimensions')}</span>
                  <button className="btn-sm ghost" onClick={() => setEditingWeight((v) => !v)}>
                    {editingWeight ? t('compare.dimensionHide') : t('compare.dimensionWeight')}
                  </button>
                </div>

                <div className="diff-filters">
                  {filters.map((f) => (
                    <button
                      key={f}
                      className={`diff-chip${filter === f ? ' active' : ''}`}
                      onClick={() => {
                        setFilter(f);
                        setPage(0);
                      }}
                    >
                      {f === 'all' ? `${t('compare.op.all')} ${total}` : `${opLabel[f]} ${counts[f]}`}
                    </button>
                  ))}
                </div>

                <div className="cmp-dimgroups">
                  {groups.map(([g, items]) => {
                    const active = filter !== 'all' ? items.some((d) => d.op === filter) : true;
                    if (!active) return null;
                    const isOpen = expandedGroups.has(g);
                    const defaultW = weights.find((w) => w.group === '')?.weight ?? 1;
                    const w = weights.find((x) => x.group === g)?.weight ?? defaultW;
                    return (
                      <button
                        key={g}
                        className={`cmp-dim${isOpen ? ' open' : ''}`}
                        onClick={() => toggleGroup(g)}
                        title={`${g} · ${items.length} ${t('compare.groupCount')}`}
                      >
                        <span className="cmp-dim-name">{g}</span>
                        <span className="cmp-dim-meta">
                          <span className="cmp-dim-count">{items.length}</span>
                          <span className="cmp-dim-weight" title={t('compare.weight')}>×{w}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {editingWeight && (
                  <div className="cmp-weights">
                    <div className="cmp-weights-head">
                      <span>{t('compare.weightInfo')}</span>
                      <button className="btn-sm ghost" onClick={addWeightRule}>
                        + {t('compare.weightAdd')}
                      </button>
                    </div>
                    <div className="cmp-weight-rows">
                      {weights.map((w) => (
                        <div key={w.id} className="cmp-weight-row">
                          <select
                            className="cmp-weight-sel"
                            value={w.group}
                            onChange={(e) => updateWeight(w.id, { group: e.target.value })}
                          >
                            <option value="">{t('compare.weightGlobal')}</option>
                            {groupNames.map((g) => (
                              <option key={g} value={g}>
                                {g}
                              </option>
                            ))}
                          </select>
                          <input
                            type="range"
                            min={0}
                            max={5}
                            step={1}
                            value={w.weight}
                            className="cmp-weight-range"
                            onChange={(e) => updateWeight(w.id, { weight: Number(e.target.value) })}
                          />
                          <span className="cmp-weight-val">{w.weight}</span>
                          <button className="cmp-weight-del" onClick={() => removeWeight(w.id)} title={t('compare.weightDel')}>
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="diff-list cmp-diff-list">
                {pageGroups.length === 0 && (
                  <div className="cmp-empty small">
                    <span>{t('compare.noDiff')}</span>
                  </div>
                )}
                {pageGroups.map(([g, items]) => {
                  const isOpen = expandedGroups.has(g) || expandedGroups.size === 0;
                  return (
                    <div key={g} className="cmp-group">
                      <button className="cmp-group-head" onClick={() => toggleGroup(g)}>
                        <span className="cmp-group-caret">{isOpen ? '▾' : '▸'}</span>
                        <span className="cmp-group-name">{g}</span>
                        <span className="cmp-group-count">{items.length}</span>
                      </button>
                      {isOpen &&
                        items.map((d) => (
                          <div
                            key={d.path}
                            className={`diff-row op-${d.op}${onSelect ? ' clickable' : ''}`}
                            onClick={onSelect ? () => locate(d) : undefined}
                            title={onSelect ? t('compare.locating') : undefined}
                          >
                            <span className="diff-op" aria-hidden>
                              {opGlyph[d.op]}
                            </span>
                            <span className="diff-op-label">{opLabel[d.op]}</span>
                            <code className="diff-path">{d.path}</code>
                            <span className="diff-vals">
                              {d.op === 'added' && <span className="diff-after">+ {valueText(d.b)}</span>}
                              {d.op === 'removed' && <span className="diff-before">− {valueText(d.a)}</span>}
                              {d.op === 'changed' && (
                                <>
                                  <span className="diff-before">{valueText(d.a)}</span>
                                  <span className="diff-arrow">→</span>
                                  <span className="diff-after">{valueText(d.b)}</span>
                                </>
                              )}
                              {d.op === 'unchanged' && (
                                <span className="diff-unchanged">{valueText(d.a)} · {kindLabel(d.a?.kind ?? 'null')}</span>
                              )}
                            </span>
                          </div>
                        ))}
                    </div>
                  );
                })}
              </div>

              {pageCount > 1 && (
                <div className="diff-pager">
                  <button className="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                    {t('compare.prev')}
                  </button>
                  <span className="muted">
                    {t('compare.page')} {page + 1} {t('compare.pageOf')} {pageCount} · {filtered.length} {t('compare.perPage')}
                  </span>
                  <button
                    className="secondary"
                    disabled={page >= pageCount - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    {t('compare.next')}
                  </button>
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
