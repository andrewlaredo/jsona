/**
 * Graph tab — high-density graph viewer built on react-force-graph (2D canvas
 * and 3D WebGL), switchable at runtime.
 *
 * Goal: render thousands of JSON nodes/edges smoothly. Force-graph draws on a
 * single <canvas> (2D) or WebGL scene (3D), so node count scales to many
 * thousands without the per-node DOM cost that ReactFlow's cards impose.
 * Layout is an iterative force simulation (d3-force) that runs in a web worker.
 *
 * Rendering notes (2D):
 *  - Custom `nodeCanvasObject` paints a node, its label (only on hover / heavy
 *    zoom / selection) and a "+N" badge when an object/array has been folded.
 *  - `nodePointerAreaPaint` gives accurate hit-testing.
 *  - `onNodeClick` selects; `onNodeRightClick` toggles folding for objects/
 *    arrays.
 *
 * Density tuning:
 *  - At >500 nodes we drop to a small base radius and only draw labels when
 *    the camera is zoomed past a threshold or the node is selected/hovered.
 *  - `d3-force` charge/link distance are scaled with node count.
 *  - 3D adds an explicit z-force so the cluster spreads in depth instead of
 *    collapsing onto a flat grid.
 *
 * Folding:
 *  - Object/array nodes can be folded so all their descendants are hidden from
 *    `graphData`. The parent is rendered with a +N badge showing the hidden
 *    count. Folding is reversible (right-click or toolbar actions).
 *
 * Theme: canvas colors can't use CSS vars, so we read `data-theme` from the
 * document and switch the palette accordingly, re-painting via `refresh()`.
 *
 * Toolbar:
 *  - 2D / 3D toggle, expand all, collapse all, download PNG.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import type { Graph } from 'jsona-core';
import { useT } from './i18n';
import './styles.css';

// ---------- Theme palette ---------------------------------------------------

interface Palette {
  bg: string;
  nodeFill: string;
  nodeStroke: string;
  text: string;
  textMuted: string;
  edge: string;
  selected: string;
  selectedText: string;
  badgeBg: string;
  badgeText: string;
}

const PALETTES: Record<'light' | 'dark', Palette> = {
  dark: {
    bg: '#010409',
    nodeFill: '#1b2330',
    nodeStroke: '#33415a',
    text: '#e6edf3',
    textMuted: 'rgba(230,237,243,0.6)',
    edge: 'rgba(140,180,255,0.38)',
    selected: '#58a6ff',
    selectedText: '#ffffff',
    badgeBg: '#58a6ff',
    badgeText: '#0b0f15',
  },
  light: {
    bg: '#f7f8fa',
    nodeFill: '#eaf0f6',
    nodeStroke: '#aab6c6',
    text: '#1f2328',
    textMuted: 'rgba(31,35,40,0.6)',
    edge: 'rgba(70,95,130,0.22)',
    selected: '#0969da',
    selectedText: '#ffffff',
    badgeBg: '#0969da',
    badgeText: '#ffffff',
  },
};

// Category colors share hue families with GitHub-style palettes but with a
// slightly more saturated, glassy feel; containers are grouped by shape.
const KIND_COLORS: Record<string, string> = {
  object: '#bc8cff', // purple
  array: '#58a6ff', // blue
  string: '#3fb950', // green
  number: '#f0883e', // orange
  boolean: '#db61a2', // pink
  null: '#8b949e', // gray
};

type Mode = '2d' | '3d';

interface PreparedData {
  nodes: any[];
  links: any[];
  /** id -> hidden descendant count (only set on folded nodes). */
  hiddenCount: Map<string, number>;
  /** id -> true if this is a foldable container (object/array) that can be folded. */
  foldable: Set<string>;
}

// ---------- Component -------------------------------------------------------

interface Props {
  graph: Graph;
  selectedId?: string;
  onSelect?: (id: string) => void;
}

export function GraphView({ graph, selectedId, onSelect }: Props) {
  const t = useT();
  const tr = (k: string) => t(k);
  const fg2dRef = useRef<any>(null);
  const fg3dRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [mode, setMode] = useState<Mode>('2d');
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Reset fold state whenever the source graph changes.
  useEffect(() => {
    setCollapsed(new Set());
  }, [graph]);

  // Keep latest selectedId in a ref so the paint callback (created once) can
  // read it without being re-created on every selection change.
  const selectedRef = useRef<string | undefined>(selectedId);
  selectedRef.current = selectedId;

  // Track theme from the document element.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => setTheme(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  // Track container size for the canvas.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---------- Build children index + filter by collapse ----------------------
  const prepared: PreparedData = useMemo(() => {
    // Build child index from edges: parent -> set of children.
    const childrenOf = new Map<string, Set<string>>();
    const nodeMap = new Map<string, { id: string; label: string; kind: string; depth: number }>();
    for (const n of graph.nodes) {
      nodeMap.set(n.id, n as any);
      if (n.kind === 'object' || n.kind === 'array') {
        if (!childrenOf.has(n.id)) childrenOf.set(n.id, new Set());
      }
    }
    for (const e of graph.edges) {
      // Skip self-loops.
      if (e.source === e.target) continue;
      let s = childrenOf.get(e.source);
      if (!s) {
        s = new Set();
        childrenOf.set(e.source, s);
      }
      s.add(e.target);
    }

    // Find a root: the node with the smallest depth, or fall back to the first.
    let rootId: string | undefined;
    let minDepth = Infinity;
    for (const n of graph.nodes) {
      if (n.depth < minDepth) {
        minDepth = n.depth;
        rootId = n.id;
      }
    }

    // DFS: include a node and its descendants unless a parent is collapsed.
    const visible = new Set<string>();
    const hiddenCount = new Map<string, number>();
    const stack: string[] = rootId ? [rootId] : graph.nodes.map((n) => n.id);
    while (stack.length) {
      const id = stack.pop()!;
      if (visible.has(id)) continue;
      visible.add(id);
      const kids = childrenOf.get(id);
      if (!kids) continue;
      if (collapsed.has(id)) {
        // Count everything below as hidden.
        let count = 0;
        const sub = [id];
        const seen = new Set<string>([id]);
        while (sub.length) {
          const x = sub.pop()!;
          const ks = childrenOf.get(x);
          if (!ks) continue;
          for (const k of ks) {
            if (seen.has(k)) continue;
            seen.add(k);
            count++;
            sub.push(k);
          }
        }
        hiddenCount.set(id, count);
        continue;
      }
      for (const k of kids) stack.push(k);
    }

    // Build final node list. All visible + collapsed ancestors still in
    // visible (so they can keep showing the badge).
    const nodes = graph.nodes.filter((n) => visible.has(n.id));
    const links = graph.edges
      .filter((e) => visible.has(e.source) && visible.has(e.target))
      .map((e, i) => ({ id: `l${i}`, source: e.source, target: e.target }));

    const foldable = new Set<string>();
    for (const n of graph.nodes) {
      if ((n.kind === 'object' || n.kind === 'array') && childrenOf.get(n.id)?.size) {
        foldable.add(n.id);
      }
    }

    return { nodes, links, hiddenCount, foldable };
  }, [graph, collapsed]);

  const data = useMemo(
    () => ({ nodes: prepared.nodes, links: prepared.links }),
    [prepared],
  );

  // ---------- Density tuning -------------------------------------------------
  const total = graph.nodes.length;
  const baseRadius = total > 1500 ? 2.8 : total > 500 ? 3.4 : 4.2;
  const labelZoomThreshold = total > 1500 ? 2.2 : total > 500 ? 1.7 : 1.4;

  // Force simulation tuning: stronger repulsion for big graphs so they spread
  // instead of collapsing into a hairball.
  useEffect(() => {
    const fg = mode === '2d' ? fg2dRef.current : fg3dRef.current;
    if (!fg) return;
    const n = data.nodes.length;
    const is3d = mode === '3d';
    const charge = n > 1500 ? -240 : n > 500 ? -150 : is3d ? -110 : -70;
    const dist = n > 1500 ? 70 : n > 500 ? 55 : is3d ? 95 : 75;
    try {
      fg.d3Force('charge')?.strength(charge);
      fg.d3Force('link')?.distance(dist);
    } catch {
      /* forces not ready on first paint yet */
    }
  }, [data, mode]);

  // 3D: spread along z so the cluster doesn't flatten into a 2D grid.
  useEffect(() => {
    if (mode !== '3d') return;
    const fg = fg3dRef.current;
    if (!fg) return;
    try {
      // Add or update z-force (only available on the 3D variant).
      fg.d3Force?.('z')?.strength(0.4);
    } catch {
      /* ignore */
    }
  }, [data, mode]);

  // Re-fit when data changes.
  useEffect(() => {
    const id = setTimeout(() => {
      const fg = mode === '2d' ? fg2dRef.current : fg3dRef.current;
      if (!fg) return;
      try {
        // Give small graphs more breathing room so labels don't fill the screen.
        const n = data.nodes.length;
        const is3d = mode === '3d';
        const padding = n < 30 ? (is3d ? 180 : 100) : n < 200 ? (is3d ? 110 : 70) : (is3d ? 70 : 40);
        fg.zoomToFit?.(400, padding);
      } catch {
        /* not ready */
      }
    }, 500);
    return () => clearTimeout(id);
  }, [data, mode]);

  // Repaint on theme change.
  const palette = PALETTES[theme];

  // Soft glow sprites behind 3D nodes.
  const haloTextures = useMemo(() => {
    const make = (c: string) => {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, c + '77');
      g.addColorStop(0.35, c + '33');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    return {
      object: make(KIND_COLORS.object),
      array: make(KIND_COLORS.array),
      string: make(KIND_COLORS.string),
      number: make(KIND_COLORS.number),
      boolean: make(KIND_COLORS.boolean),
      null: make(KIND_COLORS.null),
    };
  }, [theme]);

  useEffect(() => {
    const fg = mode === '2d' ? fg2dRef.current : fg3dRef.current;
    if (fg?.refresh) fg.refresh();
  }, [theme, palette, mode]);

  // ---------- Event handlers -------------------------------------------------
  const onNodeClick = useCallback(
    (node: any) => {
      const id = typeof node === 'object' ? node.id : node;
      onSelect?.(id);
    },
    [onSelect],
  );

  const onNodeRightClick = useCallback((node: any, e: MouseEvent) => {
    if (!node || !prepared.foldable.has(node.id)) return;
    e.preventDefault?.();
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, [prepared.foldable]);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const collapseAll = useCallback(() => {
    // Fold every foldable node that has visible descendants.
    const next = new Set<string>();
    for (const id of prepared.foldable) next.add(id);
    setCollapsed(next);
  }, [prepared.foldable]);

  // ---------- Download PNG ---------------------------------------------------
  const handleDownload = useCallback(() => {
    let url: string | null = null;
    try {
      if (mode === '2d') {
        const canvas = wrapRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
        if (canvas?.toDataURL) url = canvas.toDataURL('image/png');
      } else {
        const fg = fg3dRef.current;
        if (!fg) throw new Error('not ready');
        fg.pauseAnimation();
        fg.renderer().render(fg.scene(), fg.camera());
        const canvas: HTMLCanvasElement = fg.renderer().domElement;
        url = canvas.toDataURL('image/png');
        fg.resumeAnimation();
      }
    } catch {
      url = null;
    }
    if (!url) {
      alert(tr('graph.downloadFail') ?? 'Failed to export image, please retry');
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.download = `jsona-${ymd}-${mode.toUpperCase()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [mode, tr]);

  // ---------- Render ---------------------------------------------------------
  const commonProps = {
    width: size.w,
    height: size.h,
    graphData: data,
    backgroundColor: palette.bg,
    cooldownTicks: graph.nodes.length > 2000 ? 120 : 80,
    d3VelocityDecay: 0.32,
    linkColor: () => palette.edge,
    linkWidth: theme === 'light' ? 0.6 : 1.2,
    linkDirectionalArrowLength: 0,
    onNodeClick,
    onNodeRightClick,
    onBackgroundClick: () => onSelect?.(undefined as any),
    minZoom: 0.05,
    maxZoom: 10,
    nodeLabel: (n: any) => {
      const extra = prepared.hiddenCount.get(n.id);
      const tag = extra ? ` [+${extra}]` : '';
      return `${n.label ?? '(root)'}${n.value ? ' : ' + n.value : ''}${tag}`;
    },
  } as const;

  return (
    <div className="graph-canvas-wrap" ref={wrapRef}>
      <div className="graph-toolbar">
        <div className="graph-mode-toggle" role="group" aria-label="graph mode">
          <button
            type="button"
            className={mode === '2d' ? 'active' : ''}
            onClick={() => setMode('2d')}
            title={tr('graph.mode2d') ?? '2D'}
          >
            {tr('graph.mode2d') ?? '2D'}
          </button>
          <button
            type="button"
            className={mode === '3d' ? 'active' : ''}
            onClick={() => setMode('3d')}
            title={tr('graph.mode3d') ?? '3D'}
          >
            {tr('graph.mode3d') ?? '3D'}
          </button>
        </div>
        <button type="button" className="graph-btn" onClick={expandAll} title={tr('graph.expandAll') ?? 'Expand all'}>
          {tr('graph.expandAll') ?? 'Expand all'}
        </button>
        <button type="button" className="graph-btn" onClick={collapseAll} title={tr('graph.collapseAll') ?? 'Collapse all'}>
          {tr('graph.collapseAll') ?? 'Collapse all'}
        </button>
        <span className="graph-hint">{tr('graph.foldHint') ?? 'Right-click a node to fold / unfold'}</span>
        <button type="button" className="graph-download" onClick={handleDownload} title={tr('graph.download') ?? 'Download PNG'}>
          {tr('graph.download') ?? 'Download PNG'}
        </button>
      </div>

      {size.w > 0 && size.h > 0 && mode === '2d' && (
        <ForceGraph2D
          ref={fg2dRef}
          {...commonProps}
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const selected = node.id === selectedRef.current;
            const isContainer = node.kind === 'object' || node.kind === 'array';
            const baseR = isContainer ? baseRadius + 0.6 : baseRadius;
            const r = selected ? baseR + 2.2 : baseR;
            const color = KIND_COLORS[node.kind as string] ?? palette.nodeStroke;

            // Subtle outer glow for selected node (glass-like emphasis).
            if (selected) {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
              ctx.fillStyle = theme === 'dark'
                ? 'rgba(88,166,255,0.18)'
                : 'rgba(9,105,218,0.16)';
              ctx.fill();
            }

            // Node circle with a soft radial fill for depth.
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            if (selected) {
              ctx.fillStyle = palette.selected;
            } else {
              const gx = Number.isFinite(node.x) ? node.x - r * 0.3 : 0;
              const gy = Number.isFinite(node.y) ? node.y - r * 0.3 : 0;
              const grad = ctx.createRadialGradient(
                gx, gy, Math.max(0.1, r * 0.1),
                Number.isFinite(node.x) ? node.x : 0,
                Number.isFinite(node.y) ? node.y : 0,
                Math.max(0.5, r),
              );
              grad.addColorStop(0, color);
              grad.addColorStop(1, palette.nodeFill);
              ctx.fillStyle = grad;
            }
            ctx.fill();
            ctx.lineWidth = selected ? 2 : 1;
            ctx.strokeStyle = selected ? palette.selected : color;
            ctx.stroke();

            // +N badge for folded containers.
            const hidden = prepared.hiddenCount.get(node.id);
            if (hidden && hidden > 0) {
              const txt = `+${hidden}`;
              const fontSize = Math.max(8, 11 / Math.max(0.5, globalScale / 1.4));
              ctx.font = `bold ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              const tw = ctx.measureText(txt).width;
              const padX = 4;
              const padY = 2;
              const w = tw + padX * 2;
              const h = fontSize + padY * 2;
              const bx = node.x + r + 3;
              const by = node.y - r - 1;
              ctx.fillStyle = palette.badgeBg;
              ctx.beginPath();
              ctx.roundRect(bx, by - h / 2, w, h, Math.min(4, h / 2));
              ctx.fill();
              ctx.fillStyle = palette.badgeText;
              ctx.fillText(txt, bx + w / 2, by);
            }

            // Label only on heavy zoom or selection.
            const showLabel = selected || globalScale > labelZoomThreshold;
            if (showLabel) {
              const raw = node.label || '(root)';
              const label = raw.length > 16 ? raw.slice(0, 15) + '…' : raw;
              // Keep labels small and unobtrusive; they should only appear when
              // zoomed in enough that they won't overlap.
              const fontSize = Math.min(7.5, Math.max(6, 4 * Math.max(0.5, globalScale)));
              ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillStyle = selected ? palette.selectedText : palette.text;
              // Soft halo behind label for legibility over edges.
              const gap = 5;
              const lx = node.x + r + gap;
              const ly = node.y - fontSize / 2;
              if (theme === 'dark') {
                ctx.save();
                ctx.shadowColor = 'rgba(1,4,9,0.9)';
                ctx.shadowBlur = 4;
                ctx.fillText(label, lx, ly);
                ctx.restore();
              } else {
                ctx.save();
                ctx.shadowColor = 'rgba(255,255,255,0.95)';
                ctx.shadowBlur = 4;
                ctx.fillText(label, lx, ly);
                ctx.restore();
              }
            }
          }}
          nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
            const isContainer = node.kind === 'object' || node.kind === 'array';
            const baseR = isContainer ? baseRadius + 0.6 : baseRadius;
            const r = (node.id === selectedRef.current ? baseR + 2.2 : baseR) + 3;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />
      )}

      {size.w > 0 && size.h > 0 && mode === '3d' && (
        <ForceGraph3D
          ref={fg3dRef}
          {...commonProps}
          nodeRelSize={baseRadius * 2.4}
          backgroundColor={palette.bg}
          nodeThreeObjectExtend={false}
          nodeThreeObject={(n: any) => {
            const selected = n.id === selectedRef.current;
            const kind = n.kind as string;
            const color = new THREE.Color(KIND_COLORS[kind] ?? palette.nodeStroke);
            const group = new THREE.Group();

            // Shape by kind so containers stand out from scalars.
            let geometry: THREE.BufferGeometry;
            if (kind === 'object') {
              geometry = new THREE.IcosahedronGeometry(baseRadius * 1.25, 1);
            } else if (kind === 'array') {
              geometry = new THREE.OctahedronGeometry(baseRadius * 1.25, 0);
            } else {
              geometry = new THREE.TetrahedronGeometry(baseRadius * 1.15, 0);
            }

            // Glassy, emissive material.
            // In light mode, tones down emissive glow (looks washed out on a
            // bright background) and leans on solid opaque fill for clarity.
            const isLight = theme === 'light';
            const material = new THREE.MeshPhysicalMaterial({
              color,
              metalness: 0.15,
              roughness: isLight ? 0.45 : 0.3,
              clearcoat: isLight ? 0.4 : 0.7,
              clearcoatRoughness: 0.15,
              emissive: color,
              emissiveIntensity: isLight ? (selected ? 0.55 : 0.18) : selected ? 1.0 : 0.5,
              transparent: true,
              opacity: isLight ? 1 : 0.92,
            });
            const mesh = new THREE.Mesh(geometry, material);
            group.add(mesh);

            // Soft additive glow behind the node for a neon look.
            // On a light background, additive glow washes out to white, so we
            // fade it down (and rely on the solid node for visibility).
            const haloMap = haloTextures[kind as keyof typeof haloTextures] ?? haloTextures.string;
            const haloMat = new THREE.SpriteMaterial({
              map: haloMap,
              transparent: true,
              opacity: isLight ? (selected ? 0.45 : 0.22) : selected ? 1.0 : 0.7,
              depthWrite: false,
              blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
            });
            const halo = new THREE.Sprite(haloMat);
            halo.scale.set(baseRadius * 5, baseRadius * 5, 1);
            group.add(halo);

            // Selected node gets a pulsing ring.
            if (selected) {
              const ringGeo = new THREE.RingGeometry(baseRadius * 1.7, baseRadius * 2.1, 32);
              const ringMat = new THREE.MeshBasicMaterial({
                color: palette.selected,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.85,
              });
              const ring = new THREE.Mesh(ringGeo, ringMat);
              ring.lookAt(0, 0, 1);
              group.add(ring);
            }

            return group;
          }}
          nodeOpacity={0.92}
          nodeResolution={14}
          linkDirectionalParticles={2}
          linkDirectionalParticleSpeed={0.008}
          linkDirectionalParticleWidth={2.2}
          linkDirectionalParticleColor={() => palette.selected}
          linkOpacity={0.45}
          linkWidth={1.2}
          linkColor={(l: any) => (l.__r3d_selected ? palette.selected : palette.edge)}
          rendererConfig={{ preserveDrawingBuffer: true, antialias: true, alpha: false }}
        />
      )}

      {data.nodes.length === 0 && (
        <div className="graph-empty">
          <div className="graph-empty-title">{tr('graph.empty') ?? 'Empty graph'}</div>
        </div>
      )}
    </div>
  );
}