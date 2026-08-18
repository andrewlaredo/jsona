// L2 frontend API client for the cloud AI endpoint. Privacy boundary:
// ONLY the structural summary (schema/type counts/paths) and the selected
// node's PATH are ever sent. The full document source is NOT transmitted
// unless the user explicitly opts in (future work; not wired this round).
// The LLM call on the server is BYOK: the user configures their own provider
// + API key in settings, and the server forwards to that endpoint. jsona does
// not ship its own keys and does not bill for tokens.

import type { Locale } from '../i18n';
import type { StructuralSummary } from './inspect';

export interface AiSettings {
  provider: 'openai' | 'anthropic' | 'openai-compatible' | '';
  apiKeyMasked: string | null;
  model: string;
  hasKey: boolean;
  baseUrl?: string;
}

export interface AiSettingsInput {
  provider: AiSettings['provider'];
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface AskPayload {
  query: string;
  summary: StructuralSummary;
  selectedPath: string | null;
  locale: Locale;
  tier: 'free' | 'pro' | 'team';
}

export interface AskResult {
  answer: string;
  generatedSource?: string;
}

export class AiQuotaError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export async function askCloudAi(p: AskPayload): Promise<AskResult> {
  const res = await fetch('/api/ai', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  if (res.status === 402) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new AiQuotaError(j.error || 'AI quota exceeded', j.code || 'quota_ai');
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `AI request failed (${res.status})`);
  }
  return (await res.json()) as AskResult;
}

export async function fetchAiQuota(): Promise<{ tier: string; used: number; limit: number; byok: boolean } | null> {
  const res = await fetch('/api/ai/quota', { credentials: 'include' });
  if (!res.ok) return null;
  return (await res.json()) as { tier: string; used: number; limit: number; byok: boolean };
}

export async function getAiSettings(): Promise<AiSettings | null> {
  const res = await fetch('/api/ai/settings', { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('failed to load AI settings');
  return (await res.json()) as AiSettings;
}

export async function putAiSettings(input: AiSettingsInput): Promise<void> {
  const res = await fetch('/api/ai/settings', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `AI settings save failed (${res.status})`);
  }
}
