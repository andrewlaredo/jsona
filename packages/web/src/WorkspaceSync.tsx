import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace, type WorkspaceConflict, type WorkspaceItem } from './useWorkspace';
import { useT } from './i18n';

type Fmt = 'json' | 'yaml' | 'toml' | 'csv' | 'auto';

interface Props {
  source: string;
  format: Fmt;
  onDocument: (source: string, format: Fmt) => void;
}

export function WorkspaceSync({ source, format, onDocument }: Props) {
  const t = useT();
  const ws = useWorkspace();
  const { apiBase, authenticated, login, tier, items, loading } = ws;

  // Remember which version we last saved/loaded per workspace id, so a
  // subsequent save carries that baseVersion for optimistic-concurrency checks.
  const versionsRef = useRef<Map<string, number>>(new Map());
  const [wsId, setWsId] = useState('');
  const [wsName, setWsName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [conflict, setConflict] = useState<WorkspaceConflict | null>(null);

  useEffect(() => {
    if (authenticated && items.length > 0 && !wsId) setWsId(items[0].id);
  }, [authenticated, items, wsId]);

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 2200);
  }, []);

  const doSave = useCallback(
    async (force = false) => {
      const id = wsId.trim();
      if (!id) return flash('err', t('ws.idRequired'));
      const name = wsName.trim() || id;
      setBusy(true);
      const baseVersion = force ? undefined : versionsRef.current.get(id);
      const res = await ws.save(id, name, source, format === 'auto' ? 'json' : format, {
        baseVersion,
        force,
      });
      setBusy(false);
      if (res.ok) {
        versionsRef.current.set(id, res.version);
        flash('ok', t('ws.saved'));
      } else if (res.conflict) {
        setConflict(res.conflict);
      } else {
        flash('err', res.error || t('ws.saveFail'));
      }
    },
    [wsId, wsName, source, format, ws, t, flash],
  );

  const doLoad = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const item = await ws.load(id);
        if (!item) return flash('err', t('ws.loadFail'));
        versionsRef.current.set(id, item.version ?? 0);
        setWsId(id);
        if (item.name) setWsName(item.name);
        onDocument(item.source ?? '', (item.format as Fmt) ?? 'auto');
        flash('ok', t('ws.loaded'));
      } catch {
        flash('err', t('ws.loadFail'));
      } finally {
        setBusy(false);
      }
    },
    [ws, onDocument, t, flash],
  );

  const doRemove = useCallback(
    async (id: string) => {
      await ws.remove(id);
      flash('ok', t('ws.removed'));
    },
    [ws, t, flash],
  );

  if (!apiBase) {
    return <div className="ws-empty">{t('ws.noServer')}</div>;
  }
  if (!authenticated) {
    return (
      <div className="ws-login">
        <p>{t('ws.loginHint')}</p>
        <button className="btn-sm primary" onClick={ws.loginWithGitHub}>
          {t('ws.login')}
        </button>
      </div>
    );
  }

  return (
    <div className="ws-sync">
      <div className="ws-row">
        <input
          className="ws-input"
          placeholder={t('ws.idPlaceholder')}
          value={wsId}
          onChange={(e) => setWsId(e.target.value)}
        />
        <input
          className="ws-input"
          placeholder={t('ws.namePlaceholder')}
          value={wsName}
          onChange={(e) => setWsName(e.target.value)}
        />
      </div>
      <div className="ws-actions">
        <button className="btn-sm primary" onClick={() => doSave(false)} disabled={busy || !wsId}>
          {t('ws.save')}
        </button>
        <button className="btn-sm" onClick={() => doLoad(wsId)} disabled={busy || !wsId}>
          {t('ws.load')}
        </button>
      </div>

      {msg && <div className={`ws-msg ${msg.kind}`}>{msg.text}</div>}

      <div className="ws-list">
        <div className="ws-list-head">
          <span>{t('ws.list')}</span>
          <span className="ws-login-tag">
            {login} · {t('ws.tier')}: {String(tier).toUpperCase()}
          </span>
        </div>
        {loading ? (
          <div className="ws-empty">{t('parse.parsing')}</div>
        ) : items.length === 0 ? (
          <div className="ws-empty">{t('ws.empty')}</div>
        ) : (
          items.map((it: WorkspaceItem) => (
            <div className="ws-item" key={it.id}>
              <button className="ws-item-load" onClick={() => doLoad(it.id)} title={it.id}>
                <span className="ws-item-name">{it.name}</span>
                <span className="ws-item-meta">
                  {it.format} · v{it.version ?? '?'} · {new Date(it.updatedAt).toLocaleString()}
                </span>
              </button>
              <button className="ws-item-del" onClick={() => doRemove(it.id)} title={t('ws.remove')}>
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {conflict && (
        <ConflictModal
          conflict={conflict}
          localSource={source}
          onUseServer={() => {
            onDocument(conflict.source, (conflict.format as Fmt) ?? 'auto');
            versionsRef.current.set(wsId, conflict.version);
            setWsId(wsId);
            setConflict(null);
            flash('ok', t('ws.usedServer'));
          }}
          onForceMine={() => {
            setConflict(null);
            void doSave(true);
          }}
          onCancel={() => setConflict(null)}
          t={t}
        />
      )}
    </div>
  );
}

interface ModalProps {
  conflict: WorkspaceConflict;
  localSource: string;
  onUseServer: () => void;
  onForceMine: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useT>;
}

function ConflictModal({ conflict, localSource, onUseServer, onForceMine, onCancel, t }: ModalProps) {
  return (
    <div className="ws-modal-mask" onClick={onCancel}>
      <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('ws.conflictTitle')}</h3>
        <p className="ws-conflict-desc">{t('ws.conflictDesc')}</p>
        <div className="ws-diff">
          <div className="ws-diff-col">
            <div className="ws-diff-head server">{t('ws.serverVersion')} (v{conflict.version})</div>
            <pre className="ws-diff-pre">{conflict.source}</pre>
          </div>
          <div className="ws-diff-col">
            <div className="ws-diff-head local">{t('ws.myVersion')}</div>
            <pre className="ws-diff-pre">{localSource}</pre>
          </div>
        </div>
        <div className="ws-modal-actions">
          <button className="btn-sm" onClick={onUseServer}>
            {t('ws.useServer')}
          </button>
          <button className="btn-sm primary" onClick={onForceMine}>
            {t('ws.useMine')}
          </button>
          <button className="btn-sm ghost" onClick={onCancel}>
            {t('ws.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
