// AI service layer (L2). Quota is metered per-account by tier, exactly like the
// share plans. The actual LLM call is BYOK (Bring Your Own Key): if the signed-in
// user has configured their own provider + API key in settings, the server
// forwards the prompt to that endpoint and returns the answer. Otherwise the call
// is blocked with a clear message telling the user to configure their key (jsona
// does not ship its own LLM keys and does not bill for tokens).

import db from './db.js';
import { PLANS, type Tier } from './plans.js';
import {
  decryptKey,
  callProvider,
  type ByokSettings,
  type AiProvider,
} from './byok.js';

export interface AiPlanQuota {
  tier: Tier;
  // Monthly AI "questions" allowance. 0 = unlimited, -1 = not allowed (free).
  monthlyQuestions: number;
}

export const AI_PLANS: Record<Tier, AiPlanQuota> = {
  free: { tier: 'free', monthlyQuestions: 0 }, // AI is a paid add-on
  pro: { tier: 'pro', monthlyQuestions: 200 },
  team: { tier: 'team', monthlyQuestions: 0 }, // team = unlimited
};

// Ensure the usage table exists (idempotent).
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    owner      TEXT NOT NULL,
    month_key  TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, month_key)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_owner ON ai_usage(owner);
`);

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function aiQuotaFor(tier: Tier | null): AiPlanQuota {
  return AI_PLANS[(tier as Tier) || 'free'];
}

export function getAiUsage(owner: string): { used: number; limit: number; tier: string } {
  // owner is the GitHub login; anonymous callers are rejected upstream.
  const row = db.get(
    'SELECT count FROM ai_usage WHERE owner = ? AND month_key = ?',
    [owner, monthKey()],
  ) as unknown as { count: number } | undefined;
  const used = row?.count ?? 0;
  // tier is looked up live so allow-list changes apply immediately
  const acct = db.get('SELECT tier FROM accounts WHERE github_login = ?', [owner]) as
    | { tier: string }
    | undefined;
  const tier = (acct?.tier as Tier) || 'free';
  const limit = aiQuotaFor(tier).monthlyQuestions;
  return { used, limit, tier };
}

/** Returns true if the owner is within quota, false if this call would exceed it. */
export function checkAiQuota(owner: string): { ok: boolean; used: number; limit: number; tier: string } {
  const u = getAiUsage(owner);
  if (u.limit === 0) return { ok: false, ...u };
  if (u.limit < 0) return { ok: true, ...u };
  return { ok: u.used < u.limit, ...u };
}

export function recordAiUsage(owner: string): void {
  db.run(
    `INSERT INTO ai_usage (owner, month_key, count) VALUES (?, ?, 1)
     ON CONFLICT(owner, month_key) DO UPDATE SET count = count + 1`,
    [owner, monthKey()],
  );
}

export interface LlmRequest {
  query: string;
  // Structural summary only — never the document source (privacy boundary).
  summary: unknown;
  selectedPath: string | null;
  locale: string;
}

export interface LlmResponse {
  answer: string;
  generatedSource?: string;
}

/**
 * Load (and decrypt) a user's BYOK configuration. Returns null when the user has
 * not configured a key, so callers can fall back to the blocked-stub path.
 */
export function getByokForOwner(owner: string): ByokSettings | null {
  const row = db.get(
    'SELECT ai_provider, ai_api_key, ai_model FROM accounts WHERE github_login = ?',
    [owner],
  ) as
    | { ai_provider: string | null; ai_api_key: string | null; ai_model: string | null }
    | undefined;
  if (!row || !row.ai_provider || !row.ai_api_key) return null;
  let apiKey = '';
  try {
    apiKey = decryptKey(row.ai_api_key);
  } catch {
    // Key was encrypted under a different master key (e.g. restart without a
    // fixed BYOK_MASTER_KEY). Treat as unconfigured rather than crashing.
    return null;
  }
  return {
    provider: row.ai_provider as AiProvider,
    apiKey,
    model: row.ai_model || '',
  };
}

/**
 * BYOK-backed LLM call.
 *
 * Design note: the request already contains only the structural summary and the
 * selected node path, never the raw document, so the "data zero-upload" promise
 * holds by default. When a user has configured their own key we forward to their
 * endpoint; otherwise we return a clear message instead of a silent stub.
 */
export async function callLlm(req: LlmRequest, owner: string): Promise<LlmResponse> {
  const settings = getByokForOwner(owner);
  if (!settings) {
    return {
      answer:
        '你的账号尚未配置 AI 密钥。请在「AI 设置」中填入你自己的 OpenAI / Anthropic / ' +
        'OpenAI 兼容网关的 API Key（jsona 不托管模型，也不对你的 token 计费）。' +
        '配置保存后，这里会直接调用你自己的模型。',
    };
  }
  try {
    return await callProvider(settings, buildPrompt(req));
  } catch (err) {
    return {
      answer: `调用你的模型时出错：${(err as Error).message}`,
    };
  }
}

/** Assemble a privacy-preserving prompt from the structural summary only. */
function buildPrompt(req: LlmRequest): string {
  const parts: string[] = [];
  parts.push(
    req.locale.startsWith('zh')
      ? '你是一个 JSON/YAML/TOML/CSV 数据结构助手。'
      : 'You are a JSON/YAML/TOML/CSV data-structure assistant.',
  );
  if (req.selectedPath) {
    parts.push(`用户选中的路径：${req.selectedPath}`);
  }
  parts.push('数据结构摘要：\n' + JSON.stringify(req.summary, null, 2));
  parts.push('用户问题：' + req.query);
  parts.push(
    '请只回答与数据结构和查询相关的问题，必要时给出可应用的文档片段（用 ``` 代码块包裹）。',
  );
  return parts.join('\n\n');
}
