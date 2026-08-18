import type { HumanizedError } from './errorHumanizer';
import type { ParseError } from 'jsona-core';
import { useT } from './i18n';

interface ErrorCardProps {
  error: HumanizedError;
  source: string;
  diagnostics?: ParseError[];
  onJump?: (line: number) => void;
  onFix?: (fixed: string) => void;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function ErrorCard({
  error,
  source,
  diagnostics,
  onJump,
  onFix,
  collapsed = false,
  onToggle,
}: ErrorCardProps) {
  const t = useT();
  const count = (diagnostics && diagnostics.length > 0) ? diagnostics.length : 1;
  const firstLine = error.line ?? '?';
  const firstMsg = count > 0 && diagnostics
    ? `${t('error.line')} ${diagnostics[0].line} · ${diagnostics[0].message}`
    : '';
  const failTitle = error.title || t('error.parseFail');

  const fixFn = typeof error.fix === 'function' ? (error.fix as (s: string) => string) : undefined;

  return (
    <section
      className={`errcard ${collapsed ? 'is-collapsed' : ''}`}
      role="alert"
      aria-expanded={!collapsed}
    >
      <header className="errcard-head" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.(); } }}
        title={collapsed ? t('error.expand') : t('error.collapse')}
      >
        <span className={`errcard-chevron ${collapsed ? '' : 'open'}`} aria-hidden>
          ▸
        </span>
        <span className="errcard-title">
          {count > 1 ? `⚠ ${failTitle} ×${count}` : `⚠ ${failTitle}`}
        </span>
        {collapsed && firstMsg && (
          <span className="errcard-collapsed-hint">{firstMsg}</span>
        )}
      </header>

      {!collapsed && (
        <div className="errcard-body">
          <p className="errcard-message">
            {t('error.line')} {firstLine} · {failTitle} · {error.hint}
          </p>

          {diagnostics && diagnostics.length > 0 && (
            <ul className="errcard-list">
              {diagnostics.slice(0, 60).map((d, i) => (
                <li
                  key={i}
                  className="errcard-row"
                  onClick={() => d.line != null && onJump?.(d.line)}
                  title={d.line != null ? `${t('error.jump')} ${d.line}` : undefined}
                >
                  <span className="errcard-row-line">L{d.line}</span>
                  <span className="errcard-row-msg">{d.message}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="errcard-actions">
            {fixFn && onFix && (
              <button className="btn-sm" onClick={() => onFix!(fixFn(source))}>
                {error.fixLabel ?? t('error.applyFix')}
              </button>
            )}
            {error.hint && <span className="errcard-hint">{error.hint}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
