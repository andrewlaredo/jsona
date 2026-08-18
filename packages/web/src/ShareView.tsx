import { useEffect, useMemo, useRef, useState } from 'react';
import { parse, detectFormat, astToFormat, downloadMeta, type SupportedFormat } from 'jsona-core';
import { buildShareUrl, buildServerShareUrl, shareUrlLength, type SharePayload } from './share';
import { useT } from './i18n';
import { WorkspaceSync } from './WorkspaceSync';

type Fmt = SupportedFormat | 'auto';

interface Props {
  source: string;
  format: Fmt;
  onDocument: (source: string, format: Fmt) => void;
}

const FORMATS: { key: Fmt; label: string; desc: string; glyph: string }[] = [
  { key: 'json', label: 'JSON', desc: 'structured · universal', glyph: '{ }' },
  { key: 'yaml', label: 'YAML', desc: 'indented · readable', glyph: '—:' },
  { key: 'toml', label: 'TOML', desc: 'key-value · clean', glyph: '=' },
  { key: 'auto', label: 'AUTO', desc: 'detect source format', glyph: '⚡' },
];

export function ShareView({ source, format, onDocument }: Props) {
  const t = useT();
  const [fmt, setFmt] = useState<Fmt>(format);
  const [url, setUrl] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [serverUrl, setServerUrl] = useState<string>('');
  const [serverBusy, setServerBusy] = useState(false);
  const [serverErr, setServerErr] = useState<string>('');
  const linkRef = useRef<HTMLInputElement>(null);
  const fbTimer = useRef<number | undefined>(undefined);

  // 当源或格式变化时，重建可分享链接。
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const payload: SharePayload = { source, format: fmt === 'auto' ? 'json' : fmt };
    buildShareUrl(payload)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, fmt]);

  useEffect(() => () => window.clearTimeout(fbTimer.current), []);

  const len = useMemo(
    () => (url ? shareUrlLength({ source, format: fmt === 'auto' ? 'json' : fmt }) : 0),
    [url, source, fmt],
  );
  const hasSource = source.trim().length > 0;

  const flash = (msg: string) => {
    setFeedback(msg);
    setCopied(true);
    window.clearTimeout(fbTimer.current);
    fbTimer.current = window.setTimeout(() => {
      setFeedback('');
      setCopied(false);
    }, 1800);
  };

  const copy = async (text: string, okMsg: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        flash(okMsg);
      } else {
        flash(t('share.linkFallback'));
      }
    } catch {
      flash(t('share.linkFallback'));
    }
  };

  const download = () => {
    // Resolve the actual format: explicit choice, or auto-detect from source.
    const effective: SupportedFormat = fmt === 'auto' ? detectFormat(source) : fmt;
    let content = source;
    let mime = 'text/plain;charset=utf-8';
    try {
      const { root } = parse(source, fmt === 'auto' ? undefined : { format: fmt });
      const out = astToFormat(root, effective);
      content = out.text;
      mime = `${out.mime};charset=utf-8`;
    } catch {
      // If (re)serialization fails, fall back to the raw source as-is.
    }
    const { ext } = downloadMeta(effective);
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `document.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash(t('share.downloaded'));
  };

  return (
    <div className="panel share-view">
      <div className="panel-head">
        <span className="panel-title">
          <span className="panel-title-glyph">↗</span>
          {t('share.title')}
        </span>
        <span className="share-meta">{t('share.subtitle')}</span>
      </div>

      <div className="panel-body share-body">
        {!hasSource ? (
          <div className="share-empty">
            <span className="share-empty-glyph">↗</span>
            <span>{t('share.empty')}</span>
          </div>
        ) : (
          <>
            {/* 编码格式 */}
            <section className="share-card">
              <div className="share-card-head">
                <span className="share-card-idx">1</span>
                <h3>{t('share.format')}</h3>
              </div>
              <div className="share-formats">
                {FORMATS.map((f) => (
                  <button
                    key={f.key}
                    className={`share-format${fmt === f.key ? ' active' : ''}`}
                    onClick={() => {
                      setFmt(f.key);
                      if (f.key !== 'auto') onDocument(source, f.key);
                    }}
                    title={f.desc}
                  >
                    <span className="share-format-glyph">{f.glyph}</span>
                    <span className="share-format-label">{f.key === 'auto' ? t('share.formatAuto') : f.label}</span>
                    <span className="share-format-desc">{f.desc}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* 分享链接 */}
            <section className="share-card">
              <div className="share-card-head">
                <span className="share-card-idx">2</span>
                <h3>{t('share.link')}</h3>
              </div>
              <p className="share-hint">{t('share.linkHint')}</p>
              <div className="share-link-row">
                <input ref={linkRef} className="share-link-input" value={busy ? t('parse.parsing') : url} readOnly />
                <button
                  className="btn-sm primary"
                  onClick={() => copy(url, t('share.copied'))}
                  disabled={busy || !url}
                >
                  {t('share.copyLink')}
                </button>
                <button
                  className="btn-sm ghost"
                  onClick={() => window.open(url, '_blank', 'noopener')}
                  disabled={busy || !url}
                >
                  {t('share.openLink')}
                </button>
              </div>
              <div className="share-link-meta">
                {t('share.link')} · {len} {t('share.perLength')}
              </div>

              {/* 服务端短链（受档位配额约束） */}
              <div className="server-share">
                <button
                  className="btn-sm"
                  onClick={async () => {
                    setServerErr('');
                    setServerBusy(true);
                    try {
                      const u = await buildServerShareUrl(
                        { source, format: fmt === 'auto' ? 'json' : fmt },
                        { alertQuotaUp: true },
                      );
                      setServerUrl(u);
                    } catch (e: any) {
                      setServerUrl('');
                      setServerErr(e?.message || t('share.serverFail'));
                    } finally {
                      setServerBusy(false);
                    }
                  }}
                  disabled={serverBusy || !hasSource}
                >
                  {serverBusy ? t('parse.parsing') : t('share.serverCreate')}
                </button>
                {serverUrl && (
                  <div className="server-share-row">
                    <input className="share-link-input" value={serverUrl} readOnly />
                    <button className="btn-sm primary" onClick={() => copy(serverUrl, t('share.copied'))}>
                      {t('share.copyLink')}
                    </button>
                  </div>
                )}
                {serverErr && <div className="share-quota-err">⚠ {serverErr}</div>}
              </div>
            </section>

            {/* 源内容 */}
            <section className="share-card">
              <div className="share-card-head">
                <span className="share-card-idx">3</span>
                <h3>{t('share.source')}</h3>
              </div>
              <div className="share-source">
                <pre className="share-source-pre">
                  {source.length > 4000 ? `${source.slice(0, 4000)}…` : source}
                </pre>
              </div>
              <p className="share-hint">{t('share.sourceHint')}</p>
              <div className="share-actions">
                <button className="btn-sm" onClick={() => copy(source, t('share.copied'))} disabled={!hasSource}>
                  {t('share.copySource')}
                </button>
                <button className="btn-sm" onClick={download} disabled={!hasSource}>
                  {t('share.download')}
                </button>
              </div>
            </section>

            {/* 工作区同步（多设备冲突合并） */}
            <section className="share-card">
              <div className="share-card-head">
                <span className="share-card-idx">4</span>
                <h3>{t('share.workspace')}</h3>
              </div>
              <p className="share-hint">{t('ws.hint')}</p>
              <WorkspaceSync source={source} format={fmt} onDocument={onDocument} />
            </section>
          </>
        )}

        {feedback && <div className={`share-toast${copied ? ' show' : ''}`}>{feedback}</div>}
      </div>
    </div>
  );
}
