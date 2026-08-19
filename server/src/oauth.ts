// Minimal GitHub OAuth (read-only identity). Optional: only used when
// GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are configured. Sessions are signed
// cookies; no password, no email scope, just login + avatar for workspace sync.

import express from 'express';
import { randomBytes, createHmac } from 'node:crypto';
import { accounts } from './db.js';
import { tierFromAllowList } from './plans.js';

const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const ALLOWED = (process.env.GITHUB_ALLOWED_USERS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:8787';

export const oauthEnabled = Boolean(CLIENT_ID && CLIENT_SECRET);

function sign(value: string): string {
  const h = createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${h}`;
}

export function verifySession(cookie?: string): string | null {
  if (!cookie) return null;
  const idx = cookie.lastIndexOf('.');
  if (idx < 0) return null;
  const value = cookie.slice(0, idx);
  const mac = cookie.slice(idx + 1);
  const expected = createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  if (mac !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (obj.exp && obj.exp < Date.now()) return null;
    return obj.login as string;
  } catch {
    return null;
  }
}

export function sessionCookieFor(login: string): string {
  const payload = Buffer.from(
    JSON.stringify({ login, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }),
  ).toString('base64url');
  return sign(payload);
}

export const oauthRouter = express.Router();

oauthRouter.get('/login', (req, res) => {
  if (!oauthEnabled) return res.status(501).json({ error: 'oauth disabled' });
  const state = randomBytes(16).toString('hex');
  const isPopup = req.query.popup === '1';
  res.cookie('gh_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 600_000 });
  // Remember whether the flow was launched from a popup window so /callback can
  // render a close-page instead of a full redirect (keeps the SPA intact).
  res.cookie('gh_popup', isPopup ? '1' : '0', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 600_000,
  });
  const redirect = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
    CLIENT_ID,
  )}&redirect_uri=${encodeURIComponent(PUBLIC_URL + '/api/oauth/callback')}&scope=read:user&state=${state}`;
  res.redirect(redirect);
});

oauthRouter.get('/callback', async (req, res) => {
  if (!oauthEnabled) return res.status(501).json({ error: 'oauth disabled' });
  const { code, state } = req.query as Record<string, string>;
  const expectedState = req.cookies?.gh_state;
  if (!code || !state || state !== expectedState) {
    return res.status(400).send('invalid state');
  }
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: PUBLIC_URL + '/api/oauth/callback',
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) return res.status(400).send('token exchange failed');
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'User-Agent': 'jsona-share-server',
      },
    });
    const user = (await userRes.json()) as {
      login: string;
      avatar_url: string;
      name: string | null;
    };
    if (ALLOWED.length && !ALLOWED.includes(user.login.toLowerCase())) {
      return res.status(403).send('This GitHub account is not authorized to sync workspaces.');
    }
    // Persist a lightweight account record (token stored for future API use).
    const tier = tierFromAllowList(user.login) ?? 'free';
    accounts.upsert(user.login, user.avatar_url, user.name, tokenJson.access_token, tier);
    // Cross-site: the web client lives on a different domain (e.g. www.jsona.cn)
    // than the share server (share.jsona.cn), so the session cookie MUST be
    // `sameSite: 'none'` + `secure` to be sent on cross-origin fetch requests
    // (which also require `credentials: 'include'` on the client). On plain http
    // (local dev) `secure` is dropped so the cookie still works.
    const isHttps = PUBLIC_URL.startsWith('https:');
    res.cookie('gh_session', sessionCookieFor(user.login), {
      httpOnly: true,
      sameSite: 'none',
      secure: isHttps,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
    // Close-page mode: the flow was opened in a popup. Notify the opener and
    // close ourselves so the SPA (still mounted in the opener) just refreshes
    // its auth state without a full navigation (no source-box content lost).
    if (req.cookies?.gh_popup === '1') {
      const origin = req.headers.origin || '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html><html><head><meta charset="utf-8"><title>jsona</title></head>
<body><script>
  (function () {
    try { window.opener && window.opener.postMessage({ type: 'jsona:oauth:done' }, '*'); } catch (e) {}
    try { window.close(); } catch (e) {}
    document.body.textContent = '登录成功，窗口将自动关闭。';
  })();
</script></body></html>`);
      return;
    }
    res.redirect('/api/oauth/me');
  } catch (e) {
    res.status(500).send('oauth error: ' + (e as Error).message);
  }
});

oauthRouter.get('/me', (req, res) => {
  const login = verifySession(req.cookies?.gh_session);
  if (!login) return res.json({ authenticated: false });
  const row = accounts.get(login);
  const tier = row?.tier || 'free';
  res.json({ authenticated: true, login, tier });
});

oauthRouter.post('/logout', (req, res) => {
  res.clearCookie('gh_session');
  res.json({ ok: true });
});
