// ReactFlow-based visualization of the parsed AST.
//
// Each JSON node becomes a graph node; parent -> child edges draw the document
// tree. Selecting a node in ReactFlow highlights it in the tree + source views
// (via onSelect), and an externally selectedId is reflected back into the graph
// (via setSelectedNodes / selected styling) — full bidirectional linkage.
//
// Folding: object/array nodes can be collapsed so all descendants are hidden
// from the canvas. A folded card shows a "⊞ +N" badge and re-expands on click.
// Deep levels (depth >= FOLD_DEFAULT_DEPTH) start folded so a large document
// doesn't try to render every card at once.
//
// Layout: a hierarchical tree layout (depth -> column, in-order leaf-cursor ->
// row) keeps subtrees non-overlapping and minimizes edge crossings far better
// than a naive per-depth stack. Large documents switch to a compact (slim) card
// and level-of-detail rendering so the canvas stays smooth and legible.

import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { JsonNode, NodeKind } from 'jsona-core';
import { useT } from './i18n';

interface Props {
  root: JsonNode;
  selectedId?: string | null;
  onSelect?: (node: JsonNode) => void;
  t?: (k: string) => string;
}

// ---- Geometry constants ---------------------------------------------------
const COL_W = 280; // horizontal gap between depth levels
const V_GAP = 18; // vertical gap between sibling cards
const HEAD_H = 34;
const FIELD_H = 24;
const LEAF_H = 40; // base height for a leaf value block (auto-grows with text)
const MORE_H = 18;

// Scale at which detail cards collapse to slim heads (level-of-detail).
const LOD_ZOOM = 0.55;

// Above this node count we default to compact (slim) cards for performance.
const COMPACT_THRESHOLD = 600;

interface ChildField {
  label: string;
  kind: JsonNode['kind'];
  value: unknown;
}
interface JsonCardData {
  label: string;
  kind: JsonNode['kind'];
  value?: unknown;
  children: ChildField[];
  selected: boolean;
  collapsed: boolean;
  hiddenCount: number;
  hasChildren: boolean;
  slim: boolean; // level-of-detail: render only the header
  compact: boolean; // compact mode: slimmer padding, smaller cap on inline fields
  onToggle?: (id: string) => void;
}

// Distinct accent color per kind. These mirror the Graph view palettes so the
// two visualizations feel like one system. We resolve against CSS variables at
// render time (see useKindColors) so light/dark themes stay in sync.
const KIND_KEYS: NodeKind[] = ['object', 'array', 'string', 'number', 'boolean', 'null'];
const KIND_VARS: Record<NodeKind, string> = {
  object: '--graph-object',
  array: '--graph-array',
  string: '--graph-string',
  number: '--graph-number',
  boolean: '--graph-boolean',
  null: '--graph-null',
};
// Hard fallbacks in case the CSS vars are unavailable.
const KIND_FALLBACK: Record<NodeKind, string> = {
  object: '#58a6ff',
  array: '#d29922',
  string: '#3fb950',
  number: '#f0883e',
  boolean: '#db61a2',
  null: '#8b949e',
};

function previewValue(v: unknown, cap = 80): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'string') return v.length > cap ? v.slice(0, cap) + '…' : v;
  const s = String(v);
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

// Treease-style detail card rendered on the canvas.
function JsonCard({ data }: NodeProps<JsonCardData>) {
  const t = useT();
  const color = `var(${KIND_VARS[data.kind]}, ${KIND_FALLBACK[data.kind]})`;
  const cap = data.compact ? 4 : 6;
  const shown = data.children.slice(0, cap);
  const extra = data.children.length - shown.length;
  const canFold = data.hasChildren;

  // Level-of-detail: when slim, render only the header row.
  if (data.slim) {
    return (
      <div
        className={'rf-node rf-slim' + (data.selected ? ' selected' : '')}
        style={{ borderColor: data.selected ? 'var(--accent)' : color, color }}
      >
        <Handle type="target" position={Position.Left} className="rf-handle" />
        <div className="rf-slim-head">
          <span className="rf-dot" style={{ background: color }} />
          <span className="rf-label" title={data.label}>
            {data.label}
          </span>
          <span className="rf-kind" style={{ color }}>
            {data.kind}
          </span>
        </div>
        <Handle type="source" position={Position.Right} className="rf-handle" />
      </div>
    );
  }

  return (
    <div
      className={'rf-node' + (data.selected ? ' selected' : '')}
      style={{ borderColor: data.selected ? 'var(--accent)' : color, color }}
    >
      <Handle type="target" position={Position.Left} className="rf-handle" />
      <div className="rf-head">
        <span className="rf-dot" style={{ background: color }} />
        <span className="rf-label" title={data.label}>
          {data.label}
        </span>
        <span className="rf-kind" style={{ color }}>
          {data.kind}
        </span>
        {canFold && (
          <button
            type="button"
            className="rf-fold-btn"
            title={data.collapsed ? t('flow.expand') : t('flow.collapse')}
            onClick={(e) => {
              e.stopPropagation();
              data.onToggle?.((data as any).__id);
            }}
          >
            {data.collapsed ? '⊞' : '⊟'}
          </button>
        )}
      </div>
      {data.collapsed ? (
        <div className="rf-collapsed">+{data.hiddenCount} {t('flow.collapsedBadge')}</div>
      ) : data.children.length === 0 ? (
        <div className="rf-leaf-val">{previewValue(data.value, 200)}</div>
      ) : (
        <div className="rf-fields">
          {shown.map((c, i) => {
            const isScalar = c.kind !== 'object' && c.kind !== 'array';
            return (
              <div className={'rf-field' + (isScalar ? ' scalar' : '')} key={i}>
                <span className="rf-fk" title={c.label}>
                  {c.label}
                </span>
                <span
                  className={'rf-fv kind-' + c.kind + (isScalar ? ' multiline' : '')}
                  title={previewValue(c.value, 400)}
                >
                  {fieldValueLabel(c.kind, c.value)}
                </span>
              </div>
            );
          })}
          {extra > 0 && <div className="rf-more">+{extra} {t('flow.moreFields')}</div>}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="rf-handle" />
    </div>
  );
}

const nodeTypes: NodeTypes = { json: JsonCard };

// ---- Theme-aware kind colors --------------------------------------------
// Reads the CSS custom properties declared in styles.css so the graph follows
// the active light/dark theme. Falls back to hard-coded hex if unresolved.
function useKindColors(): Record<NodeKind, string> {
  const [colors, setColors] = useState<Record<NodeKind, string>>(() => ({ ...KIND_FALLBACK }));
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const next = { ...KIND_FALLBACK };
      for (const k of KIND_KEYS) {
        const v = cs.getPropertyValue(KIND_VARS[k]).trim();
        if (v) next[k] = v;
      }
      setColors(next);
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    window.addEventListener('resize', read);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', read);
    };
  }, []);
  return colors;
}

// ---- Hierarchical tree layout --------------------------------------------
// Returns x/y for every (visible) node. Depth sets the column; a pre-order
// traversal assigns each leaf node the next free vertical slot while a parent
// is centered over the vertical span of its children. Sibling subtrees never
// overlap and edge crossings are minimized — the standard tree-drawing result.
interface Layout {
  pos: Record<string, { x: number; y: number }>;
}
function computeLayout(root: JsonNode, collapsed: Set<string>): Layout {
  const pos: Record<string, { x: number; y: number }> = {};
  const cursor = { v: 0 };

  const place = (n: JsonNode, depth: number): void => {
    const isCollapsed = collapsed.has(n.id);
    const kids = n.children ?? [];
    const x = depth * COL_W;
    const h = cardHeight(n, isCollapsed, false);
    if (isCollapsed || kids.length === 0) {
      pos[n.id] = { x, y: cursor.v };
      cursor.v += h + V_GAP;
      return;
    }
    const childTops: number[] = [];
    let maxBottom = cursor.v;
    for (const c of kids) {
      place(c, depth + 1);
      childTops.push(pos[c.id].y);
      maxBottom = Math.max(maxBottom, pos[c.id].y + cardHeight(c, false, false));
    }
    const firstTop = childTops[0];
    const lastBottom = pos[kids[kids.length - 1].id].y + cardHeight(kids[kids.length - 1], false, false);
    pos[n.id] = { x, y: (firstTop + lastBottom) / 2 - h / 2 };
    // advance the cursor past the tallest child subtree
    cursor.v = maxBottom + V_GAP;
  };

  place(root, 0);
  return { pos };
}

function scalarFieldLines(value: unknown, compact: boolean): number {
  const v = previewValue(value, 120);
  const cols = compact ? 22 : 24;
  return Math.min(3, Math.max(1, Math.ceil(v.length / cols)));
}

function cardHeight(node: JsonNode, collapsed: boolean, compact: boolean): number {
  const kids = node.children ?? [];
  if (collapsed) return HEAD_H + 26;
  if (kids.length === 0) {
    const v = previewValue(node.value, 200);
    const lines = Math.min(4, Math.ceil(v.length / 26));
    return HEAD_H + Math.max(LEAF_H, lines * 16 + 12);
  }
  const cap = compact ? 4 : 6;
  const shown = kids.slice(0, cap);
  let h = HEAD_H;
  for (const c of shown) {
    if (c.kind === 'object' || c.kind === 'array') {
      h += FIELD_H; // key + kind badge, single row
    } else {
      const lines = scalarFieldLines(c.value, compact);
      h += 16 + lines * 15; // key height + value lines
    }
  }
  if (kids.length > cap) h += MORE_H;
  return h;
}

function fieldValueLabel(kind: JsonNode['kind'], value: unknown): string {
  if (kind === 'object') return '{ }';
  if (kind === 'array') return '[ ]';
  return previewValue(value, 120);
}

function FlowViewInner({ root, selectedId, onSelect }: Props) {
  const t = useT();
  const tr = useCallback((k: string) => t(k), [t]);
  const kindColors = useKindColors();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [compact, setCompact] = useState(false);
  const [themeTick, setThemeTick] = useState(0); // forces edge re-style on theme change
  const { fitView } = useReactFlow();
  const rootRef = useRef(root);
  rootRef.current = root;

  const toggleNode = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
  );

  // Force edge re-color when theme variables change (MutationObserver bump).
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick((x) => x + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => obs.disconnect();
  }, []);

  // Default-fold deep nodes so large documents don't render every card.
  useEffect(() => {
    const next = new Set<string>();
    const walk = (n: JsonNode, depth: number) => {
      if (depth >= 3 && (n.children?.length ?? 0) > 0) {
        next.add(n.id);
        return; // don't descend; whole subtree starts hidden
      }
      for (const c of n.children ?? []) walk(c, depth + 1);
    };
    walk(root, 0);
    setCollapsed(next);
  }, [root]);

  // Auto-enable compact mode for very large documents.
  useEffect(() => {
    let count = 0;
    const walk = (n: JsonNode) => {
      count++;
      if (count > COMPACT_THRESHOLD + 1) return;
      for (const c of n.children ?? []) walk(c);
    };
    walk(root);
    setCompact(count > COMPACT_THRESHOLD);
  }, [root]);

  const { nodes, edges, foldedCount, visibleCount } = useMemo(() => {
    const layout = computeLayout(root, collapsed);
    const flat: { node: JsonNode; depth: number }[] = [];
    const walk = (n: JsonNode, depth: number) => {
      flat.push({ node: n, depth });
      if (collapsed.has(n.id)) return;
      for (const c of n.children ?? []) walk(c, depth + 1);
    };
    walk(root, 0);

    const slim = zoom < LOD_ZOOM;
    const rfNodes: Node<JsonCardData>[] = flat.map(({ node, depth }) => {
      const p = layout.pos[node.id];
      const childCount = (node.children ?? []).length;
      const isCollapsed = collapsed.has(node.id);
      const label =
        node.key !== undefined
          ? String(node.key)
          : node.kind === 'object'
            ? '{ }'
            : node.kind === 'array'
              ? '[ ]'
              : String(node.value ?? 'null');
      const children: ChildField[] = (node.children ?? []).map((c) => ({
        label:
          c.key !== undefined ? String(c.key) : c.kind === 'object' ? '{ }' : c.kind === 'array' ? '[ ]' : String(c.value ?? ''),
        kind: c.kind,
        value: c.value,
      }));
      // Count hidden descendants for the folded badge.
      let hidden = 0;
      if (isCollapsed) {
        const stack = [...(node.children ?? [])];
        const seen = new Set<string>();
        while (stack.length) {
          const x = stack.pop()!;
          if (seen.has(x.id)) continue;
          seen.add(x.id);
          hidden++;
          for (const k of x.children ?? []) stack.push(k);
        }
      }
      return {
        id: node.id,
        position: { x: p?.x ?? depth * COL_W, y: p?.y ?? 0 },
        type: 'json',
        data: {
          label,
          kind: node.kind,
          value: node.value,
          children: isCollapsed ? [] : children,
          selected: node.id === selectedId,
          collapsed: isCollapsed,
          hiddenCount: hidden,
          hasChildren: childCount > 0,
          slim,
          compact,
          onToggle: (id: string) => toggleNode(id),
          ...({ __id: node.id } as any),
        } as JsonCardData & { __id: string },
      } satisfies Node<JsonCardData>;
    });

    // Edges: object -> child = solid with arrow; array -> item = dashed.
    const rfEdges: Edge[] = [];
    const seen = new Set<string>();
    const visibleIds = new Set(flat.map((f) => f.node.id));
    for (const { node } of flat) {
      if (collapsed.has(node.id)) continue;
      const isArray = node.kind === 'array';
      for (const c of node.children ?? []) {
        if (!visibleIds.has(c.id)) continue;
        const id = `${node.id}->${c.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const color = kindColors[node.kind] ?? '#888';
        rfEdges.push({
          id,
          source: node.id,
          target: c.id,
          type: 'smoothstep',
          markerEnd: { type: 'arrowclosed' as any, color, width: 14, height: 14 },
          style: {
            stroke: color,
            strokeWidth: isArray ? 1.2 : 1.6,
            strokeDasharray: isArray ? '4 3' : undefined,
            opacity: 0.55,
          },
        });
      }
    }
    return {
      nodes: rfNodes,
      edges: rfEdges,
      foldedCount: collapsed.size,
      visibleCount: flat.length,
    };
    // themeTick + compact + zoom + selectedId affect styling; include them.
  }, [root, selectedId, collapsed, compact, zoom, kindColors, themeTick, toggleNode]);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const collapseAll = useCallback(() => {
    const next = new Set<string>();
    const walk = (n: JsonNode) => {
      if ((n.children?.length ?? 0) > 0) next.add(n.id);
      for (const c of n.children ?? []) walk(c);
    };
    walk(rootRef.current);
    setCollapsed(next);
    requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }));
  }, [fitView]);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_e, n) => {
      const find = (cur: JsonNode): JsonNode | null => {
        if (cur.id === n.id) return cur;
        for (const c of cur.children ?? []) {
          const hit = find(c);
          if (hit) return hit;
        }
        return null;
      };
      const live = find(rootRef.current);
      if (live) onSelect?.(live);
    },
    [onSelect],
  );

  const onMove = useCallback((_e: any, viewport: { zoom: number }) => {
    setZoom(viewport.zoom);
  }, []);

  const edgeColor = useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    return cs.getPropertyValue('--rf-edge').trim() || 'rgba(140,160,190,0.5)';
  }, [themeTick]);

  if (nodes.length === 0) {
    return <div className="empty">{t('flow.empty')}</div>;
  }

  return (
    <div className="flow-view rf-wrap">
      <div className="rf-toolbar">
        <button type="button" className="rf-btn" onClick={expandAll} title={tr('graph.expandAll') ?? 'Expand all'}>
          {tr('graph.expandAll') ?? 'Expand all'}
        </button>
        <button type="button" className="rf-btn" onClick={collapseAll} title={tr('graph.collapseAll') ?? 'Collapse all'}>
          {tr('graph.collapseAll') ?? 'Collapse all'}
        </button>
        {visibleCount > COMPACT_THRESHOLD && (
          <button
            type="button"
            className={'rf-btn' + (compact ? ' active' : '')}
            onClick={() => setCompact((v) => !v)}
            title={t('flow.compactHint')}
          >
            {t('flow.compact')}
          </button>
        )}
        <span className="rf-hint">
          {tr('flow.foldHint') ?? 'Click the ⊟/⊞ on a node to fold / unfold'} ·{' '}
          {tr('flow.folded') ?? 'folded'} {foldedCount} ·{' '}
          {visibleCount} {t('flow.nodes')}
        </span>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onMove={onMove}
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.75, maxZoom: 1.2, duration: 300 }}
        minZoom={0.05}
        maxZoom={2.5}
        nodesConnectable={false}
        nodesDraggable
        onlyRenderVisibleElements={visibleCount > 800}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
        className="rf-canvas"
        defaultEdgeOptions={{ style: { stroke: edgeColor } }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => kindColors[(n.data?.kind as NodeKind) ?? 'object'] ?? '#888'}
          nodeStrokeColor={(n) => kindColors[(n.data?.kind as NodeKind) ?? 'object'] ?? '#888'}
          maskColor="rgba(0,0,0,0.45)"
          className="rf-minimap"
        />
        <Legend colors={kindColors} />
      </ReactFlow>
    </div>
  );
}

// On-canvas legend (custom node, non-interactive).
function Legend({ colors }: { colors: Record<NodeKind, string> }) {
  const t = useT();
  const items: { kind: NodeKind; label: string; dash?: boolean }[] = [
    { kind: 'object', label: t('flow.kind.object') },
    { kind: 'array', label: t('flow.kind.array'), dash: true },
    { kind: 'string', label: t('flow.kind.string') },
    { kind: 'number', label: t('flow.kind.number') },
    { kind: 'boolean', label: t('flow.kind.boolean') },
    { kind: 'null', label: t('flow.kind.null') },
  ];
  return (
    <div className="rf-legend">
      <div className="rf-legend-title">{t('flow.legendTitle')}</div>
      {items.map((it) => (
        <div className="rf-legend-row" key={it.kind}>
          <span
            className="rf-legend-line"
            style={{
              background: colors[it.kind],
              height: 3,
              width: 18,
              borderRadius: 2,
              backgroundImage: it.dash
                ? `repeating-linear-gradient(90deg, ${colors[it.kind]} 0 4px, transparent 4px 7px)`
                : undefined,
            }}
          />
          <span className="rf-legend-dot" style={{ background: colors[it.kind] }} />
          <span className="rf-legend-label">{it.label}</span>
        </div>
      ))}
      <div className="rf-legend-note">{t('flow.legendNote')}</div>
    </div>
  );
}

export default function FlowView(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowViewInner {...props} />
    </ReactFlowProvider>
  );
}
