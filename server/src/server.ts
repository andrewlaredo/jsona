import express from 'express';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { shares, workspaces, accounts } from './db.js';
import { oauthRouter, oauthEnabled, verifySession } from './oauth.js';
import { rateLimit, maxBytes } from './ratelimit.js';
import { PLANS, ANON_QUOTA, ABSOLUTE_MAX_BYTES, isUnlimited, formatBytes, type Tier } from './plans.js';
import { callLlm, checkAiQuota, recordAiUsage, getAiUsage, getByokForOwner } from './ai.js';
import { encryptKey } from './byok.js';

const app = express();

// Behind a reverse proxy the socket address is the proxy's, so let Express
// resolve the real client IP from X-Forwarded-For when explicitly trusted.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', true);

app.disable('x-powered-by');

// Minimal cookie parsing (only `gh_session` is ever read), avoiding an extra
// dependency. Previously req.cookies was undefined, so auth always failed.
app.use((req, _res, next) => {
  const header = req.headers.cookie;
  const jar: Record<string, string> = {};
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) jar[k] = decodeURIComponent(v);
    }
  }
  (req as express.Request & { cookies: Record<string, string> }).cookies = jar;
  next();
});

app.use(express.json({ limit: '8mb' }));

// CORS: allow the web client (possibly a different origin) to call the API.
const ALLOWED_ORIGINS = (process.env.PUBLIC_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SHARE_TTL = Number(process.env.SHARE_TTL || 604800);
const WORKSPACE_TTL = Number(process.env.WORKSPACE_TTL || 2592000);

// Abuse limits (all overridable via env).
const MAX_SHARE_BYTES = Number(process.env.MAX_SHARE_BYTES || 4_000_000);
const WRITE_MAX = Number(process.env.RATE_WRITE_MAX || 20); // per window, per IP
const READ_MAX = Number(process.env.RATE_READ_MAX || 120);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const MAX_WORKSPACES = Number(process.env.MAX_WORKSPACES_PER_USER || 50);

// Writes are expensive and are the abuse vector, so they get a tight budget;
// reads are cheap and only need a coarse ceiling.
const writeLimiter = rateLimit({ bucket: 'w', windowMs: RATE_WINDOW_MS, max: WRITE_MAX });
const readLimiter = rateLimit({ bucket: 'r', windowMs: RATE_WINDOW_MS, max: READ_MAX });

// --- Share short links (quota enforced per plan tier) ---
function resolveQuota(login: string | null): { quota: (typeof PLANS)[Tier]; login: string | null } {
  if (!login) return { quota: ANON_QUOTA, login: null };
  const row = accounts.get(login);
  const tier = (row?.tier as Tier) || 'free';
  return { quota: PLANS[tier] ?? PLANS.free, login };
}

function hashPassword(pw: string): string {
  return createHash('sha256').update(`jsona:${pw}`).digest('base64url');
}

app.post('/api/share', maxBytes(ABSOLUTE_MAX_BYTES + 1_000_000), writeLimiter, (req, res) => {
  const { source, format, password } = req.body ?? {};
  if (typeof source !== 'string' || typeof format !== 'string') {
    return res.status(400).json({ error: 'source and format are required' });
  }
  // Quota: anonymous shares use the free tier; signed-in users use their tier.
  const login = verifySession(req.cookies?.gh_session);
  const { quota } = resolveQuota(login);
  if (source.length > quota.maxBytes) {
    return res.status(413).json({
      error: `document too large for your plan (${quota.label} allows ${formatBytes(quota.maxBytes)})`,
      code: 'quota_bytes',
      tier: quota.tier,
      maxBytes: quota.maxBytes,
    });
  }
  if (login && !isUnlimited(quota) && shares.countFor(login) >= quota.maxShares) {
    return res.status(409).json({
      error: `share limit reached for your plan (${quota.label}: ${quota.maxShares} links)`,
      code: 'quota_shares',
      tier: quota.tier,
      maxShares: quota.maxShares,
    });
  }
  // Password protection is a Team-only feature.
  let pwHash: string | undefined;
  if (typeof password === 'string' && password.length > 0) {
    if (!quota.password) {
      return res.status(402).json({
        error: 'password-protected shares require the Team plan',
        code: 'quota_password',
        tier: quota.tier,
      });
    }
    pwHash = hashPassword(password);
  }
  const id = nanoid(10);
  const now = Date.now();
  const ttlMs = quota.ttlDays > 0 ? quota.ttlDays * 86400_000 : SHARE_TTL * 1000;
  const expires = ttlMs > 0 ? now + ttlMs : null;
  shares.insert({
    id,
    owner: login ?? '',
    source,
    format,
    password: pwHash ?? null,
    created_at: now,
    expires_at: expires,
  });
  res.json({
    id,
    url: `${PUBLIC_URL}/s/${id}`,
    expiresAt: expires,
    tier: quota.tier,
    protected: Boolean(pwHash),
  });
});

// Authenticated quota usage for the current account.
app.get('/api/share/quota', readLimiter, (req, res) => {
  const login = verifySession(req.cookies?.gh_session);
  if (!login) return res.status(401).json({ error: 'authentication required' });
  const { quota } = resolveQuota(login);
  res.json({
    tier: quota.tier,
    label: quota.label,
    maxBytes: quota.maxBytes,
    maxShares: quota.maxShares,
    ttlDays: quota.ttlDays,
    password: quota.password,
    usedShares: isUnlimited(quota) ? shares.countFor(login) : shares.countFor(login),
  });
});

app.get('/api/share/:id', readLimiter, (req, res) => {
  const row = shares.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found or expired' });
  // Password-protected shares require the password as ?pw= or header.
  if (row.password) {
    const provided = (req.query.pw as string) || (req.headers['x-share-password'] as string);
    if (!provided || hashPassword(provided) !== row.password) {
      return res.status(401).json({ error: 'password required', code: 'password_required' });
    }
  }
  res.json({ source: row.source, format: row.format });
});

// Serve short-link HTML that the web client can read via the API.
app.get('/s/:id', readLimiter, (req, res) => {
  const row = shares.get(req.params.id);
  if (!row) {
    res.status(404).send('<h1>Link expired or not found</h1>');
    return;
  }
  // The id is user-supplied, so escape it before reflecting it into HTML.
  const safeId = encodeURIComponent(req.params.id);
  res.send(`<!doctype html><html><head><meta charset="utf-8">
    <title>jsona share</title>
    <meta http-equiv="refresh" content="0; url=/#/s/${safeId}">
    </head><body>Redirecting…</body></html>`);
});

// --- Workspace sync (requires GitHub account) ---
function requireAuth(req: express.Request, res: express.Response): string | null {
  const login = verifySession(req.cookies?.gh_session);
  if (!login) {
    res.status(401).json({ error: 'authentication required' });
    return null;
  }
  return login;
}

app.get('/api/workspace', readLimiter, (req, res) => {
  const login = requireAuth(req, res);
  if (!login) return;
  res.json({ items: workspaces.list(login) });
});

app.get('/api/workspace/:id', readLimiter, (req, res) => {
  const login = requireAuth(req, res);
  if (!login) return;
  const row = workspaces.get(req.params.id, login);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    id: row.id,
    name: row.name,
    source: row.source,
    format: row.format,
    version: row.version,
  });
});

app.put('/api/workspace/:id', maxBytes(MAX_SHARE_BYTES + 1_000_000), writeLimiter, (req, res) => {
  const login = requireAuth(req, res);
  if (!login) return;
  const { name, source, format, baseVersion } = req.body ?? {};
  if (typeof source !== 'string' || typeof format !== 'string' || typeof name !== 'string') {
    return res.status(400).json({ error: 'name, source and format are required' });
  }
  if (source.length > MAX_SHARE_BYTES) {
    return res.status(413).json({ error: 'document too large' });
  }
  // Cap storage per account; updating an existing workspace is always allowed.
  const existing = workspaces.get(req.params.id, login);
  if (!existing && workspaces.countFor(login) >= MAX_WORKSPACES) {
    return res.status(409).json({ error: `workspace limit reached (${MAX_WORKSPACES})` });
  }
  // Optimistic concurrency: a client that loaded version N must send
  // baseVersion:N. If the server has since moved past N (another device wrote),
  // refuse the write and hand back the current version so the client can merge.
  if (existing && typeof baseVersion === 'number' && baseVersion !== existing.version) {
    return res.status(409).json({
      error: 'conflict',
      conflict: {
        version: existing.version,
        name: existing.name,
        source: existing.source,
        format: existing.format,
      },
    });
  }
  const now = Date.now();
  const expires = WORKSPACE_TTL > 0 ? now + WORKSPACE_TTL * 1000 : null;
  const nextVersion = (existing?.version ?? 0) + 1;
  workspaces.upsert({
    id: req.params.id,
    owner: login,
    name,
    source,
    format,
    version: nextVersion,
    updated_at: now,
    expires_at: expires,
  });
  res.json({ ok: true, updatedAt: now, version: nextVersion });
});

app.delete('/api/workspace/:id', writeLimiter, (req, res) => {
  const login = requireAuth(req, res);
  if (!login) return;
  workspaces.delete(req.params.id, login);
  res.json({ ok: true });
});

// --- AI assistant (L2) ---
// Cloud AI is a paid add-on metered per-account by tier. The request body is
// expected to contain ONLY the structural summary and selected path (the web
// client enforces this), never the raw document (privacy boundary).
app.post('/api/ai', writeLimiter, async (req, res) => {
  const login = requireAuth(req, res);
  if (!login) return;
  const { query, summary, selectedPath, locale } = req.body ?? {};
  if (typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'query is required' });
  }
  // BYOK users pay with their own key, so they bypass the plan quota; others
  // are still metered by tier (free = blocked, pro = N/month, team = unlimited).
  const hasByok = getByokForOwner(login) !== null;
  if (!hasByok) {
    const q = checkAiQuota(login);
    if (!q.ok) {
      return res.status(402).json({
        error: 'AI quota exceeded for your plan (or configure your own key in AI settings)',
        code: 'quota_ai',
        tier: q.tier,
        used: q.used,
        limit: q.limit,
      });
    }
  }
  try {
    const out = await callLlm({ query: query.trim(), summary, selectedPath, locale }, login);
    recordAiUsage(login);
    res.json(out);
  } catch (err) {
    console.error('[ai] call failed:', (err as Error).message);
    res.status(502).json({ error: 'AI call failed' });
  }
});

// Authenticated AI quota/usage for the current account.
app.get('/api/ai/quota', readLimiter, (req, res) => {
  const login = requireAuth(req, res);
  if (!login) return;
  const u = getAiUsage(login);
  res.json({ ...u, byok: getByokForOwner(login) !== null });
});

// --- AI settings (BYOK) ---
// GET returns the current provider + a masked key preview (never the raw key).
app.get('/api/ai/settings', readLimiter, (req, res) => {
  const login = requireAuth(req, res);
  if (!login) return;
  const row = accounts.get(login);
  if (!row) return res.status(404).json({ error: 'account not found' });
  res.json({
    provider: row.ai_provider || '',
    apiKeyMasked: row.ai_api_key ? '********' : null,
    model: row.ai_model || '',
    hasKey: Boolean(row.ai_api_key),
  });
});

// PUT saves (or clears) the user's BYOK configuration. The raw key is encrypted
// at rest before being written to the DB. An empty apiKey with a non-empty
// provider means "keep the existing key" (only model/provider change); an empty
// provider clears everything.
app.put('/api/ai/settings', writeLimiter, (req, res) => {
  const login = requireAuth(req, res);
  if (!login) return;
  const { provider, apiKey, model, baseUrl } = req.body ?? {};
  const allowed = ['', 'openai', 'anthropic', 'openai-compatible'];
  if (!allowed.includes(provider)) {
    return res.status(400).json({ error: 'invalid provider' });
  }
  if (provider === 'openai-compatible' && typeof baseUrl !== 'string') {
    return res.status(400).json({ error: 'baseUrl is required for openai-compatible' });
  }
  const existing = accounts.get(login);
  let encrypted: string | null = null;
  if (provider) {
    if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
      encrypted = encryptKey(apiKey.trim());
    } else {
      // Keep the previously stored (encrypted) key unchanged.
      encrypted = existing?.ai_api_key ?? null;
      if (!encrypted) {
        return res.status(400).json({ error: 'apiKey is required when a provider is set' });
      }
    }
  }
  accounts.setAiSettings(
    login,
    provider || null,
    encrypted,
    typeof model === 'string' ? model : null,
  );
  res.json({ ok: true, hasKey: Boolean(encrypted) });
});

// --- OAuth (optional) ---
if (oauthEnabled) {
  // Login/callback hit GitHub, so throttle them to avoid burning quota.
  app.use('/api/oauth', rateLimit({ bucket: 'o', windowMs: RATE_WINDOW_MS, max: 30 }), oauthRouter);
}

// MCP tool catalog for external agents to discover jsona's capabilities.
// The MCP server itself lives in the open-source @jsona/cli package and runs
// over stdio: `jsona mcp` (official @modelcontextprotocol/sdk).
app.get('/api/mcp/manifest', readLimiter, (_req, res) => {
  res.json({
    name: 'jsona',
    transport: 'stdio',
    run: 'jsona mcp',
    install: 'npm i -g @jsona/cli',
    tools: [
      { name: 'jsona_query', description: 'Query a document by JSON-path and return matches.' },
      { name: 'jsona_schema', description: 'Structural summary of a document (cheap, no full payload).' },
      { name: 'jsona_convert', description: 'Convert between json/yaml/toml/csv.' },
    ],
  });
});

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    oauth: oauthEnabled,
    store: 'sqlite',
    shares: shares.count(),
    plans: {
      free: { maxBytes: PLANS.free.maxBytes, maxShares: PLANS.free.maxShares, ttlDays: PLANS.free.ttlDays },
      pro: { maxBytes: PLANS.pro.maxBytes, maxShares: PLANS.pro.maxShares, ttlDays: PLANS.pro.ttlDays },
      team: { maxBytes: PLANS.team.maxBytes, maxShares: PLANS.team.maxShares, ttlDays: PLANS.team.ttlDays, password: true },
    },
  }),
);

// Log unexpected failures without leaking internals to the caller.
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`[jsona-share] listening on ${PORT} (oauth=${oauthEnabled})`);
});
