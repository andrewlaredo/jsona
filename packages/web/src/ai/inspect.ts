// Local AI helpers (L1). Pure, offline, zero network. Built on jsona-core's
// JsonNode so nothing leaves the browser. These power the "AI" panel's free,
// on-device capabilities: schema inference, null/type statistics, a human
// structural summary, and a field-path manifest.

import type { JsonNode } from 'jsona-core';

export interface TypeStat {
  kind: string;
  count: number;
}

export interface FieldInfo {
  path: string;
  key: string;
  kind: string;
  nullable: boolean;
  sample?: unknown;
  children?: number;
  depth: number;
}

export interface SchemaInferResult {
  rootKind: string;
  nodeCount: number;
  typeDistribution: TypeStat[];
  nullCount: number;
  nullPaths: string[];
  maxDepth: number;
  fieldManifest: FieldInfo[];
}

function walk(n: JsonNode, depth: number, out: SchemaInferResult, fieldList: FieldInfo[]) {
  out.nodeCount++;
  const td = out.typeDistribution.find((x) => x.kind === n.kind);
  if (td) td.count++;
  else out.typeDistribution.push({ kind: n.kind, count: 1 });

  if (depth > out.maxDepth) out.maxDepth = depth;

  if (n.kind === 'null' || n.value === null || n.value === undefined) {
    out.nullCount++;
    if (n.path) out.nullPaths.push(n.path);
  }

  if (n.children && n.children.length) {
    if (n.kind === 'object') {
      for (const c of n.children) {
        fieldList.push({
          path: c.path ?? '',
          key: String(c.key),
          kind: c.kind,
          nullable: c.kind === 'null' || c.value === null || c.value === undefined,
          sample: c.kind === 'object' || c.kind === 'array' ? undefined : c.value,
          children: c.children?.length,
          depth,
        });
        walk(c, depth + 1, out, fieldList);
      }
    } else {
      // array: summarize element kinds without exploding the manifest
      for (const c of n.children) walk(c, depth + 1, out, fieldList);
    }
  }
}

/** Infer schema, type distribution, nulls and a field manifest from an AST. */
export function inferSchema(root: JsonNode): SchemaInferResult {
  const out: SchemaInferResult = {
    rootKind: root.kind,
    nodeCount: 0,
    typeDistribution: [],
    nullCount: 0,
    nullPaths: [],
    maxDepth: 0,
    fieldManifest: [],
  };
  walk(root, 0, out, out.fieldManifest);
  out.typeDistribution.sort((a, b) => b.count - a.count);
  return out;
}

export interface StructuralSummary {
  rootKind: string;
  nodeCount: number;
  maxDepth: number;
  fieldCount: number;
  typeDistribution: TypeStat[];
  nullCount: number;
  topLevelKeys: string[];
}

/** Build a concise, human-readable structural summary (used by the AI panel
 *  and as the payload that gets sent to the cloud LLM in L2). */
export function structuralSummary(root: JsonNode): StructuralSummary {
  const s = inferSchema(root);
  const topLevelKeys =
    root.kind === 'object'
      ? (root.children ?? []).map((c) => String(c.key))
      : root.kind === 'array'
        ? [`[array of ${(root.children ?? []).length} items]`]
        : [];
  return {
    rootKind: s.rootKind,
    nodeCount: s.nodeCount,
    maxDepth: s.maxDepth,
    fieldCount: s.fieldManifest.length,
    typeDistribution: s.typeDistribution,
    nullCount: s.nullCount,
    topLevelKeys,
  };
}

/** Explain a node's structure in one or two plain sentences (offline). */
export function explainNode(node: JsonNode, locale: 'zh-CN' | 'en' = 'zh-CN'): string {
  const zh = locale === 'zh-CN';
  const path = node.path || (zh ? '根节点' : 'root');
  const kind = node.kind;
  if (kind === 'object') {
    const keys = (node.children ?? []).map((c) => String(c.key));
    return zh
      ? `「${path}」是一个对象，包含 ${keys.length} 个字段：${keys.join('、') || '（空）'}。`
      : `「${path}」is an object with ${keys.length} field(s): ${keys.join(', ') || '(empty)'}.`;
  }
  if (kind === 'array') {
    const len = (node.children ?? []).length;
    const kinds = new Set((node.children ?? []).map((c) => c.kind));
    return zh
      ? `「${path}」是一个数组，共 ${len} 个元素，元素类型：${[...kinds].join('、') || '未知'}。`
      : `「${path}」is an array of ${len} item(s), element kind(s): ${[...kinds].join(', ') || 'unknown'}.`;
  }
  return zh
    ? `「${path}」是 ${kind} 类型，值为 ${node.value === null ? 'null' : JSON.stringify(node.value)}。`
    : `「${path}」is of type ${kind}, value ${node.value === null ? 'null' : JSON.stringify(node.value)}.`;
}

/** Find paths by substring match (offline "ask" fallback). */
export function findPathsLike(root: JsonNode, q: string): string[] {
  const needle = q.toLowerCase();
  const out: string[] = [];
  const walk = (n: JsonNode) => {
    if (n.path && n.path.toLowerCase().includes(needle)) out.push(n.path);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}
