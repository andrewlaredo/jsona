// Paginated, clickable list of nodes matching the tree search query.
// Clicking a result selects the node (tree + source highlight), providing the
// "搜索结果分页联动" behaviour requested.

import { useMemo, useState } from 'react';
import type { JsonNode } from 'jsona-core';
import { useT } from './i18n';

interface Props {
  root: JsonNode;
  query: string;
  /** Called when a result row is activated. */
  onPick: (node: JsonNode) => void;
  pageSize?: number;
}

function collect(root: JsonNode, q: string): JsonNode[] {
  const needle = q.toLowerCase();
  const out: JsonNode[] = [];
  const walk = (n: JsonNode) => {
    const key = n.key ?? '';
    const val = n.kind === 'object' || n.kind === 'array'
      ? ''
      : String(n.value ?? '');
    if (
      key.toLowerCase().includes(needle) ||
      val.toLowerCase().includes(needle) ||
      (n.path ?? '').toLowerCase().includes(needle)
    ) {
      out.push(n);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

export default function SearchResults({ root, query, onPick, pageSize = 50 }: Props) {
  const t = useT();
  const matches = useMemo(() => collect(root, query), [root, query]);
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const slice = matches.slice(safePage * pageSize, safePage * pageSize + pageSize);

  return (
    <div className="search-results">
      <div className="sr-head">
        {t('search.results')} <strong>{matches.length}</strong> {t('search.resultsCount')}
      </div>
      {matches.length === 0 ? (
        <div className="sr-empty">{t('search.noMatch')}</div>
      ) : (
        <>
          <ul className="sr-list">
            {slice.map((n) => (
              <li
                key={n.id}
                className="sr-item"
                onClick={() => onPick(n)}
                title={`${n.path ?? ''} = ${n.kind === 'object' || n.kind === 'array' ? n.kind : String(n.value ?? '')}`}
              >
                <span className={`sr-key kind-${n.kind}`}>{n.key ?? (n.path ?? '$')}</span>
                <span className="sr-path muted">{n.path ?? '$'}</span>
                {n.kind !== 'object' && n.kind !== 'array' && (
                  <span className="sr-val">{String(n.value ?? '')}</span>
                )}
              </li>
            ))}
          </ul>
          {totalPages > 1 && (
            <div className="sr-pager">
              <button
                className="secondary"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                {t('search.prev')}
              </button>
              <span className="muted">
                {safePage + 1} {t('search.pageOf')} {totalPages}
              </span>
              <button
                className="secondary"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage(safePage + 1)}
              >
                {t('search.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
