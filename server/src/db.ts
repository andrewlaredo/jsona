// SQLite-backed store for shares / workspaces / accounts / rate limits.
//
// Uses node-sqlite3-wasm: a real, file-backed SQLite engine compiled to
// WebAssembly. This gives proper SQL, indexes and atomic transactions with
// zero native compilation, which matters because prebuilt better-sqlite3
// binaries are not published for every Node/OS combination.
//
// The exported API is intentionally identical to the previous JSON store, so
// callers did not have to change.

import type { Database as DatabaseType } from 'node-sqlite3-wasm';
import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

// node-sqlite3-wasm ships as CommonJS, so a named ESM import fails at runtime
// even though TypeScript accepts it. Load it through require() instead.
const require = createRequire(import.meta.url);
const { Database } = require('node-sqlite3-wasm') as {
  Database: new (path: string) => DatabaseType;
};

const RAW_PATH = process.env.DB_PATH || './data/share.db';
// Older deployments pointed DB_PATH at a .json file; keep using a sibling .db.
const DB_PATH = RAW_PATH.endsWith('.json') ? RAW_PATH.replace(/\.json$/, '.db') : RAW_PATH;
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// WAL keeps readers from blocking the writer; NORMAL sync is the usual
// durability/throughput trade-off for this kind of service.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

// SQLite's ALTER TABLE ADD COLUMN throws "duplicate column name" when the
// column already exists, so a plain re-run of the DDL is NOT idempotent.
// These helpers make migrations safe to execute on every boot.
function hasColumn(table: string, col: string): boolean {
  const rows = db.all(`PRAGMA table_info(${table})`) as unknown as { name: string }[];
  return rows.some((r) => r.name === col);
}
function addColumnIfMissing(table: string, col: string, ddl: string) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL,
    format      TEXT NOT NULL,
    password    TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
  CREATE INDEX IF NOT EXISTS idx_shares_owner   ON shares(owner);

  CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    name        TEXT NOT NULL,
    source      TEXT NOT NULL,
    format      TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    expires_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ws_owner   ON workspaces(owner, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ws_expires ON workspaces(expires_at);

  CREATE TABLE IF NOT EXISTS accounts (
    github_login TEXT PRIMARY KEY,
    avatar_url   TEXT,
    name         TEXT,
    access_token TEXT NOT NULL,
    tier         TEXT NOT NULL DEFAULT 'free',
    plan_expires_at INTEGER,
    created_at   INTEGER NOT NULL,
    ai_provider  TEXT,
    ai_api_key   TEXT,
    ai_model     TEXT
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    key         TEXT PRIMARY KEY,
    count       INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rl_window ON rate_limits(window_start);
`);

// Migrations for columns introduced after the initial tables were deployed.
addColumnIfMissing('shares', 'owner', `owner TEXT NOT NULL DEFAULT ''`);
addColumnIfMissing('shares', 'password', `password TEXT`);
addColumnIfMissing('workspaces', 'version', `version INTEGER NOT NULL DEFAULT 1`);
addColumnIfMissing('accounts', 'tier', `tier TEXT NOT NULL DEFAULT 'free'`);
addColumnIfMissing('accounts', 'plan_expires_at', `plan_expires_at INTEGER`);
addColumnIfMissing('accounts', 'ai_provider', `ai_provider TEXT`);
addColumnIfMissing('accounts', 'ai_api_key', `ai_api_key TEXT`);
addColumnIfMissing('accounts', 'ai_model', `ai_model TEXT`);

export interface ShareRow {
  id: string;
  owner: string;
  source: string;
  format: string;
  password: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface WorkspaceRow {
  id: string;
  owner: string;
  name: string;
  source: string;
  format: string;
  version: number;
  updated_at: number;
  expires_at: number | null;
}

interface AccountRow {
  github_login: string;
  avatar_url: string | null;
  name: string | null;
  access_token: string;
  tier: string;
  plan_expires_at: number | null;
  created_at: number;
  ai_provider: string | null;
  ai_api_key: string | null;
  ai_model: string | null;
}

export interface AiSettings {
  provider: 'openai' | 'anthropic' | 'openai-compatible' | '';
  /** Masked preview, never the raw secret. */
  apiKeyMasked: string | null;
  model: string;
}

export const shares = {
  insert(r: ShareRow) {
    db.run(
      `INSERT OR REPLACE INTO shares (id, owner, source, format, password, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.owner, r.source, r.format, r.password, r.created_at, r.expires_at],
    );
  },

  get(id: string): ShareRow | undefined {
    const row = db.get('SELECT * FROM shares WHERE id = ?', [id]) as unknown as
      | ShareRow
      | undefined;
    if (!row) return undefined;
    // Lazily drop rows that outlived their TTL.
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      db.run('DELETE FROM shares WHERE id = ?', [id]);
      return undefined;
    }
    return row;
  },

  purgeExpired() {
    db.run('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?', [Date.now()]);
  },

  count(): number {
    const r = db.get('SELECT COUNT(*) AS c FROM shares') as unknown as { c: number } | undefined;
    return r?.c ?? 0;
  },

  /** Live share count for an owner (used to cap per-account usage by tier). */
  countFor(owner: string): number {
    const r = db.get(
      'SELECT COUNT(*) AS c FROM shares WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)',
      [owner, Date.now()],
    ) as unknown as { c: number } | undefined;
    return r?.c ?? 0;
  },
};

export const workspaces = {
  upsert(r: WorkspaceRow) {
    db.run(
      `INSERT OR REPLACE INTO workspaces (id, owner, name, source, format, version, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.owner, r.name, r.source, r.format, r.version, r.updated_at, r.expires_at],
    );
  },

  get(id: string, owner: string): WorkspaceRow | undefined {
    const row = db.get('SELECT * FROM workspaces WHERE id = ? AND owner = ?', [
      id,
      owner,
    ]) as unknown as WorkspaceRow | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      db.run('DELETE FROM workspaces WHERE id = ?', [id]);
      return undefined;
    }
    return row;
  },

  list(owner: string): Omit<WorkspaceRow, 'source' | 'version'>[] {
    return db.all(
      `SELECT id, owner, name, format, version, updated_at, expires_at
         FROM workspaces
        WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY updated_at DESC`,
      [owner, Date.now()],
    ) as unknown as Omit<WorkspaceRow, 'source' | 'version'>[];
  },

  delete(id: string, owner: string) {
    db.run('DELETE FROM workspaces WHERE id = ? AND owner = ?', [id, owner]);
  },

  /** Number of live workspaces for an owner (used to cap per-account usage). */
  countFor(owner: string): number {
    const r = db.get(
      'SELECT COUNT(*) AS c FROM workspaces WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)',
      [owner, Date.now()],
    ) as unknown as { c: number } | undefined;
    return r?.c ?? 0;
  },

  purgeExpired() {
    db.run('DELETE FROM workspaces WHERE expires_at IS NOT NULL AND expires_at <= ?', [Date.now()]);
  },
};

export const accounts = {
  upsert(
    login: string,
    avatar_url: string | null,
    name: string | null,
    access_token: string,
    tier = 'free',
  ) {
    db.run(
      `INSERT OR REPLACE INTO accounts (github_login, avatar_url, name, access_token, tier, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [login, avatar_url, name, access_token, tier, Date.now()],
    );
  },

  get(login: string): AccountRow | undefined {
    return db.get('SELECT * FROM accounts WHERE github_login = ?', [login]) as unknown as
      | AccountRow
      | undefined;
  },

  setTier(login: string, tier: string) {
    db.run('UPDATE accounts SET tier = ? WHERE github_login = ?', [tier, login]);
  },

  /**
   * Persist BYOK configuration. `encryptedKey` is expected to already be
   * encrypted by the caller (see byok.ts); this layer only stores opaque
   * bytes. Passing null for `encryptedKey` clears the stored key.
   */
  setAiSettings(
    login: string,
    provider: string | null,
    encryptedKey: string | null,
    model: string | null,
  ) {
    db.run(
      `UPDATE accounts SET ai_provider = ?, ai_api_key = ?, ai_model = ?
       WHERE github_login = ?`,
      [provider, encryptedKey, model, login],
    );
  },
};

/**
 * Fixed-window rate limiter persisted in SQLite.
 *
 * Surviving restarts matters: an in-memory counter resets on every deploy,
 * which is exactly when an abuser would retry. Returns the updated counter so
 * callers can emit accurate `X-RateLimit-*` headers.
 */
export const rateLimits = {
  hit(key: string, windowMs: number, max: number): {
    allowed: boolean;
    remaining: number;
    resetAt: number;
  } {
    const now = Date.now();
    const row = db.get('SELECT count, window_start FROM rate_limits WHERE key = ?', [
      key,
    ]) as unknown as { count: number; window_start: number } | undefined;

    if (!row || now - row.window_start >= windowMs) {
      // Start a fresh window.
      db.run(
        `INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)`,
        [key, 1, now],
      );
      return { allowed: true, remaining: Math.max(0, max - 1), resetAt: now + windowMs };
    }

    const next = row.count + 1;
    db.run('UPDATE rate_limits SET count = ? WHERE key = ?', [next, key]);
    return {
      allowed: next <= max,
      remaining: Math.max(0, max - next),
      resetAt: row.window_start + windowMs,
    };
  },

  purgeExpired(maxWindowMs: number) {
    db.run('DELETE FROM rate_limits WHERE window_start < ?', [Date.now() - maxWindowMs]);
  },
};

/**
 * One-time migration from the previous JSON store. Runs only when a legacy
 * file exists and the SQLite tables are still empty, then renames the old file
 * so the import never repeats.
 */
function migrateLegacyJson() {
  const legacy = RAW_PATH.endsWith('.json') ? RAW_PATH : './data/share.json';
  if (!existsSync(legacy)) return;
  if (shares.count() > 0) return;

  try {
    const parsed = JSON.parse(readFileSync(legacy, 'utf8')) as {
      shares?: Record<string, ShareRow>;
      workspaces?: Record<string, WorkspaceRow>;
      accounts?: Record<string, AccountRow>;
    };

    for (const r of Object.values(parsed.shares ?? {})) shares.insert(r);
    for (const w of Object.values(parsed.workspaces ?? {})) workspaces.upsert(w);
    for (const a of Object.values(parsed.accounts ?? {})) {
      accounts.upsert(a.github_login, a.avatar_url, a.name, a.access_token);
    }

    renameSync(legacy, legacy + '.migrated');
    console.log('[db] migrated legacy JSON store -> SQLite');
  } catch (err) {
    console.warn('[db] legacy JSON migration skipped:', (err as Error).message);
  }
}

migrateLegacyJson();

// Periodic housekeeping for TTLs and stale rate-limit windows.
setInterval(
  () => {
    shares.purgeExpired();
    workspaces.purgeExpired();
    rateLimits.purgeExpired(24 * 60 * 60 * 1000);
  },
  60 * 60 * 1000,
).unref();

// Flush cleanly so WAL contents are checkpointed into the main db file.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    process.exit(0);
  });
}

export default db;
