// Path breadcrumb for the tree view.
//
// Shows the ancestor chain of the selected node and lets the user jump back to
// any ancestor. Long chains collapse in the middle so the root and the current
// node always stay visible.

import { useMemo } from 'react';
import type { JsonNode } from 'jsona-core';
import { copyText } from './edit';
import { useT } from './i18n';

interface Props {
  root: JsonNode;
  selectedId?: string;
  onSelect?: (node: JsonNode) => void;
}

/** Ancestor chain from root to the selected node, inclusive. */
function chainTo(root: JsonNode, id?: string): JsonNode[] {
  if (!id) return [];
  const out: JsonNode[] = [];
  const walk = (n: JsonNode): boolean => {
    out.push(n);
    if (n.id === id) return true;
    for (const c of n.children ?? []) {
      if (walk(c)) return true;
    }
    out.pop();
    return false;
  };
  return walk(root) ? out : [];
}

const MAX_VISIBLE = 6;

export default function Breadcrumb({ root, selectedId, onSelect }: Props) {
  const t = useT();
  const chain = useMemo(() => chainTo(root, selectedId), [root, selectedId]);
  if (chain.length === 0) return null;

  const current = chain[chain.length - 1];

  // Collapse the middle of very deep chains: root … last few.
  let items: (JsonNode | 'ellipsis')[] = chain;
  if (chain.length > MAX_VISIBLE) {
    items = [chain[0], 'ellipsis', ...chain.slice(chain.length - (MAX_VISIBLE - 2))];
  }

  return (
    <div className="breadcrumb" role="navigation" aria-label="节点路径">
      {items.map((item, i) =>
        item === 'ellipsis' ? (
          <span className="bc-sep bc-ellipsis" key={`e${i}`} title={t('breadcrumb.collapsed')}>
            …
          </span>
        ) : (
          <span key={item.id} className="bc-item-wrap">
            {i > 0 && <span className="bc-sep">/</span>}
            <button
              className={`bc-item${item.id === current.id ? ' current' : ''}`}
              onClick={() => onSelect?.(item)}
              title={item.path || '$'}
            >
              {i === 0 ? '$' : String(item.key ?? '-')}
            </button>
          </span>
        ),
      )}
      <button
        className="bc-copy"
        title={t('breadcrumb.copyPath')}
        onClick={() => copyText(current.path || '$')}
      >
        ⧉
      </button>
    </div>
  );
}
