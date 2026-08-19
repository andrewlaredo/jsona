import { useState, useEffect, useCallback } from 'react';
import { setApiBase } from './share';

// Optional GitHub-account workspace sync. Anonymous usage (no server) is fully
// supported; this hook only activates when a share server is configured and the
// user signs in via GitHub.

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '';

export interface WorkspaceItem {
  id: string;
  name: string;
  format: string;
  updatedAt: number;
  version?: number;
  source?: string;
}

export interface WorkspaceConflict {
  version: number;
  name: string;
  source: string;
  format: string;
}

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; conflict?: WorkspaceConflict; error?: string };

export function useWorkspace() {
  const [authenticated, setAuthenticated] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [tier, setTier] = useState<string>('free');
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setApiBase(API_BASE);
    if (!API_BASE) return; // server-less mode
    fetchMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchMe = useCallback(async () => {
    if (!API_BASE) return;
    try {
      const res = await fetch(`${API_BASE}/api/oauth/me`, { credentials: 'include' });
      const json = (await res.json()) as {
        authenticated: boolean;
        login?: string;
        tier?: string;
      };
      setAuthenticated(json.authenticated);
      setLogin(json.login ?? null);
      if (json.authenticated) setTier(json.tier ?? 'free');
      if (json.authenticated) refreshList();
    } catch {
      setAuthenticated(false);
    }
  }, []);

  const refreshList = useCallback(async () => {
    if (!API_BASE) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/workspace`, { credentials: 'include' });
      if (res.ok) {
        const json = (await res.json()) as {
          items: Array<{
            id: string;
            name: string;
            format: string;
            updated_at: number;
            version?: number;
          }>;
        };
        setItems(
          json.items.map((it) => ({
            id: it.id,
            name: it.name,
            format: it.format,
            updatedAt: it.updated_at,
            version: it.version,
          })),
        );
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const loginWithGitHub = useCallback(() => {
    if (!API_BASE) return;
    // Open OAuth in a popup so the SPA (and the user's in-progress source
    // content) stays mounted. The popup posts `jsona:oauth:done` back here on
    // success, then we just refresh auth state instead of reloading the page.
    const url = `${API_BASE}/api/oauth/login?popup=1`;
    const popup = window.open(
      url,
      'jsona_oauth',
      'width=520,height=720,left=200,top=120,noopener=no',
    );
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      if (popup && !popup.closed) {
        try {
          popup.close();
        } catch {
          /* ignore */
        }
      }
      fetchMe();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== API_BASE) return;
      if (e.data && e.data.type === 'jsona:oauth:done') finish();
    };
    window.addEventListener('message', onMessage);
    // Fallback: if the popup is closed by hand (or blocks postMessage), still
    // try to refresh auth state once it's gone.
    const poll = window.setInterval(() => {
      if (popup && popup.closed) {
        window.clearInterval(poll);
        finish();
      }
    }, 800);
    // Safety net so the interval/poll can't linger forever.
    window.setTimeout(() => {
      window.clearInterval(poll);
      finish();
    }, 120_000);
  }, [fetchMe]);

  const logout = useCallback(async () => {
    if (!API_BASE) return;
    await fetch(`${API_BASE}/api/oauth/logout`, { method: 'POST' });
    setAuthenticated(false);
    setLogin(null);
    setItems([]);
  }, []);

  const save = useCallback(
    async (
      id: string,
      name: string,
      source: string,
      format: string,
      opts?: { baseVersion?: number; force?: boolean },
    ): Promise<SaveResult> => {
      if (!API_BASE) return { ok: false, error: 'no server configured' };
      const body: Record<string, unknown> = { name, source, format };
      // force = overwrite the server version; otherwise send the version we
      // last loaded so the server can reject stale writes (conflict).
      if (!opts?.force && typeof opts?.baseVersion === 'number') {
        body.baseVersion = opts.baseVersion;
      }
      const res = await fetch(`${API_BASE}/api/workspace/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await refreshList();
        const data = await res.json().catch(() => ({ version: undefined }));
        return { ok: true, version: data.version };
      }
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        if (data.conflict) return { ok: false, conflict: data.conflict };
        return { ok: false, error: data.error || 'conflict' };
      }
      let error = 'save failed';
      try {
        const data = await res.json();
        if (data.error) error = data.error;
      } catch {
        /* non-JSON body */
      }
      return { ok: false, error };
    },
    [refreshList],
  );

  const load = useCallback(
    async (id: string): Promise<WorkspaceItem | null> => {
      if (!API_BASE) throw new Error('no server configured');
      const res = await fetch(`${API_BASE}/api/workspace/${id}`, { credentials: 'include' });
      if (!res.ok) throw new Error('load failed');
      const data = (await res.json()) as {
        id: string;
        name: string;
        source: string;
        format: string;
        version?: number;
      };
      return { ...data, updatedAt: data.version ?? 0 };
    },
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!API_BASE) throw new Error('no server configured');
      await fetch(`${API_BASE}/api/workspace/${id}`, { method: 'DELETE' });
      await refreshList();
    },
    [refreshList],
  );

  return {
    apiBase: API_BASE,
    authenticated,
    login,
    tier,
    items,
    loading,
    loginWithGitHub,
    logout,
    save,
    load,
    remove,
    refreshList,
  };
}
