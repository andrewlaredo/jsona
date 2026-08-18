import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import type { JsonNode, NodeKind } from 'jsona-core';
import { ancestorIds } from './locate';
import { useT } from './i18n';

interface FlatRow {
  node: JsonNode;
  depth: number;
  // index of parent row in the flat list, -1 for root (used by keyboard left)
  parentIdx: number;
}

const ROW_HEIGHT = 24;
const OVERSCAN = 12;
const MAX_SCALAR_PREVIEW = 120;

function formatTreeValue(value: string | number | boolean | null | undefined, kind: NodeKind): string {
  if (value === null || value === undefined) return 'null';
  const s = String(value);
  if (kind !== 'string') return s;
  // Collapse line breaks/tabs and redundant whitespace so the fixed-height tree row stays single-line.
  const collapsed = s
    .replace(/\r\n/g, ' ')
    .replace(/[\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length > MAX_SCALAR_PREVIEW) return collapsed.slice(0, MAX_SCALAR_PREVIEW) + '…';
  return collapsed;
}

function flatten(
  node: JsonNode,
  depth: number,
  collapsed: Set<string>,
  query: string,
  out: FlatRow[],
  parentIdx: number,
): void {
  const q = query.toLowerCase();
  const match = q
    ? (node.key ?? '').toLowerCase().includes(q) ||
      (node.value !== undefined && String(node.value).toLowerCase().includes(q))
    : false;
  const idx = out.length;
  out.push({ node, depth, parentIdx });
  if (node.children && node.children.length) {
    const isCollapsed = collapsed.has(node.id);
    // When searching, force-expand nodes that themselves match so the match is visible.
    if (!isCollapsed || match) {
      for (const c of node.children) flatten(c, depth + 1, collapsed, query, out, idx);
    }
  }
}

interface Props {
  root: JsonNode;
  query: string;
  selectedId: string | null;
  onSelect: (node: JsonNode) => void;
}

export function VirtualTree({ root, query, selectedId, onSelect }: Props) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  // Keyboard-driven focused row index (separate from mouse selection).
  const [focusIdx, setFocusIdx] = useState(-1);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flatten(root, 0, collapsed, query.toLowerCase(), out, -1);
    return out;
  }, [root, collapsed, query]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const total = rows.length * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(startIdx, endIdx);

  // Keep the keyboard focus index within range when the list changes.
  useEffect(() => {
    if (focusIdx >= rows.length) setFocusIdx(rows.length - 1);
  }, [rows.length, focusIdx]);

  // Reverse sync: when the selection is driven from outside (e.g. clicking in
  // the source editor), expand the ancestor chain and scroll the row into view.
  const lastExternal = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedId === lastExternal.current) return;
    lastExternal.current = selectedId;
    const ancestors = ancestorIds(root, selectedId);
    if (ancestors.length) {
      setCollapsed((prev) => {
        if (!ancestors.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        for (const id of ancestors) next.delete(id);
        return next;
      });
    }
  }, [selectedId, root]);

  // Once the row exists in the flattened list, focus and reveal it.
  useEffect(() => {
    if (!selectedId) return;
    const idx = rows.findIndex((r) => r.node.id === selectedId);
    if (idx < 0 || idx === focusIdx) return;
    setFocusIdx(idx);
    const el = scrollRef.current;
    if (!el) return;
    const top = idx * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
    // focusIdx intentionally omitted: we only react to selection/rows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, rows]);

  const scrollToIndex = useCallback(
    (idx: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = idx * ROW_HEIGHT;
      if (top < el.scrollTop) el.scrollTop = top - OVERSCAN * ROW_HEIGHT;
      else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
        el.scrollTop = top - el.clientHeight + ROW_HEIGHT + OVERSCAN * ROW_HEIGHT;
    },
    [],
  );

  const moveFocus = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, idx));
      setFocusIdx(clamped);
      scrollToIndex(clamped);
      onSelect(rows[clamped].node);
    },
    [rows, scrollToIndex, onSelect],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!rows.length) return;
      const cur = focusIdx >= 0 ? focusIdx : 0;
      const row = rows[cur];
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          moveFocus(cur + 1);
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          moveFocus(cur - 1);
          break;
        case 'ArrowRight':
        case 'l': {
          e.preventDefault();
          if (row.node.children?.length && collapsed.has(row.node.id)) toggle(row.node.id);
          else if (row.node.children?.length) moveFocus(cur + 1);
          break;
        }
        case 'ArrowLeft':
        case 'h': {
          e.preventDefault();
          if (row.node.children?.length && !collapsed.has(row.node.id)) toggle(row.node.id);
          else if (row.parentIdx >= 0) moveFocus(row.parentIdx);
          break;
        }
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (row.node.children?.length) toggle(row.node.id);
          onSelect(row.node);
          break;
        default:
          break;
      }
    },
    [rows, focusIdx, collapsed, toggle, moveFocus, onSelect],
  );

  return (
    <div
      ref={scrollRef}
      className="vt-scroll"
      tabIndex={0}
      role="tree"
      aria-label={t('tree.aria')}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: total, position: 'relative' }}>
        {visible.map((row, i) => {
          const { node, depth } = row;
          const idx = startIdx + i;
          const hasChildren = !!node.children?.length;
          const isCollapsed = collapsed.has(node.id);
          const selected = node.id === selectedId;
          const focused = idx === focusIdx;
          const q = query.toLowerCase();
          const isMatch =
            q &&
            ((node.key ?? '').toLowerCase().includes(q) ||
              (node.value !== undefined && String(node.value).toLowerCase().includes(q)));
          return (
            <div
              key={node.id}
              className={`vt-row${selected ? ' selected' : ''}${isMatch ? ' match' : ''}${
                focused ? ' focused' : ''
              }`}
              style={{ top: idx * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: depth * 16 + 8 }}
              onClick={() => {
                setFocusIdx(idx);
                onSelect(node);
              }}
            >
              {hasChildren ? (
                <span
                  className="vt-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(node.id);
                  }}
                >
                  {isCollapsed ? '▸' : '▾'}
                </span>
              ) : (
                <span className="vt-toggle vt-leaf" />
              )}
              <span className="vt-key">{node.key !== undefined ? node.key : '(root)'}</span>
              {node.kind === 'object' || node.kind === 'array' ? (
                <span className="vt-kind">
                  {' '}
                  {node.kind === 'array' ? '[' : '{'}
                  {node.children?.length ?? 0}
                  {node.kind === 'array' ? ']' : '}'}
                </span>
              ) : (
                <span className="vt-value" title={node.value === null ? 'null' : String(node.value)}>
                  : {formatTreeValue(node.value, node.kind)}
                  <span className="vt-type"> ({node.kind})</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && query && (
        <div className="muted" style={{ padding: 12 }}>
          {t('tree.noMatch')} {rows.length})
        </div>
      )}
    </div>
  );
}
