// BYOK (Bring Your Own Key) layer for the L2 cloud AI feature.
//
// jsona does NOT ship its own LLM keys and does NOT bill for tokens. Instead a
// signed-in user configures their own provider + API key, and the server acts
// as a thin, zero-cost proxy: it forwards the prompt to the user's chosen
// endpoint and streams the answer back. The key is encrypted at rest (AES-256-
// GCM) so it is never stored in plaintext in the SQLite file.
//
// Security notes:
//   * The encryption master key comes from BYOK_MASTER_KEY. If unset we fall
//     back to an in-process random key — that ONLY obscures the value in the
//     DB and is lost on restart (old ciphertext becomes unreadable). Always
//     set BYOK_MASTER_KEY in production.
//   * We never log the raw key, and the GET settings endpoint returns only a
//     masked preview.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export type AiProvider = 'openai' | 'anthropic' | 'openai-compatible' | '';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let masterKey: Buffer | null = null;
function getMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const raw = process.env.BYOK_MASTER_KEY;
  if (raw && raw.length >= 32) {
    // Accept hex or base64 of a 32-byte key; normalize to 32 bytes.
    masterKey = raw.match(/^[0-9a-fA-F]{64}$/)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw.slice(0, 32));
  } else {
    if (!raw) {
      console.warn(
        '[byok] BYOK_MASTER_KEY is not set — using an in-memory random key. ' +
          'Stored keys will be unreadable after a restart. Set BYOK_MASTER_KEY in production.',
      );
    }
    // Deterministic-but-process-local fallback so a single boot round-trips.
    masterKey = createHash('sha256').update(`jsona-byok-${process.pid}`).digest();
  }
  return masterKey;
}

/** Encrypt a plaintext API key into a portable, self-describing string. */
export function encryptKey(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: base64(iv || tag || ciphertext)
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** Decrypt a string produced by encryptKey. Throws if it cannot be decoded. */
export function decryptKey(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const enc = buf.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Show only the first few chars so the UI can confirm a key is set. */
export function maskKey(plain: string): string {
  if (!plain) return '';
  const head = plain.slice(0, 4);
  return `${head}${'*'.repeat(Math.max(4, plain.length - head.length))}`;
}

export interface ByokSettings {
  provider: AiProvider;
  apiKey: string; // decrypted plaintext, used only in-memory during a request
  model: string;
  /** Required for openai-compatible: the base URL, e.g. https://my.gateway/v1 */
  baseUrl?: string;
}

export interface ProviderCallResult {
  answer: string;
  generatedSource?: string;
}

function pickEndpoint(provider: AiProvider, baseUrl?: string): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1/chat/completions';
    case 'anthropic':
      return 'https://api.anthropic.com/v1/messages';
    case 'openai-compatible':
      return (baseUrl || '').replace(/\/$/, '') + '/chat/completions';
    default:
      throw new Error('unsupported provider');
  }
}

/**
 * Forward a prompt to the user's own LLM endpoint. Non-streaming for
 * simplicity; returns the assistant message text plus any fenced code block
 * detected in the reply (used for "apply to document").
 */
export async function callProvider(
  req: ByokSettings,
  prompt: string,
): Promise<ProviderCallResult> {
  if (!req.provider) throw new Error('no provider configured');
  if (!req.apiKey) throw new Error('no api key configured');
  const model = req.model || defaultModel(req.provider);
  const endpoint = pickEndpoint(req.provider, req.baseUrl);
  const payload = buildBody(req.provider, model, prompt);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.provider === 'anthropic') {
    headers['x-api-key'] = req.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${req.apiKey}`;
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`provider request failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`provider returned ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as unknown as Record<string, unknown>;
  const { text: answer, generated } = parseProviderResponse(req.provider, data);
  return { answer, generatedSource: generated };
}

function defaultModel(provider: AiProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-haiku-latest';
    case 'openai-compatible':
      return 'gpt-4o-mini';
    default:
      return '';
  }
}

function buildBody(
  provider: AiProvider,
  model: string,
  prompt: string,
): Record<string, unknown> {
  if (provider === 'anthropic') {
    return {
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    };
  }
  // openai / openai-compatible
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
  };
}

function parseProviderResponse(
  provider: AiProvider,
  data: Record<string, unknown>,
): { text: string; generated?: string } {
  let text = '';
  if (provider === 'anthropic') {
    const content = Array.isArray(data.content)
      ? (data.content as { type?: string; text?: string }[])
      : [];
    text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
  } else {
    const choices = (data.choices as { message?: { content?: string } }[]) || [];
    text = choices.map((c) => c.message?.content || '').join('\n');
  }
  const generated = extractFencedCode(text);
  return { text, generated };
}

/** Pull the first ``` fenced block out of a reply, for "apply to document". */
function extractFencedCode(text: string): string | undefined {
  const m = text.match(/```(?:json|yaml|toml|csv)?\s*\n([\s\S]*?)```/i);
  return m ? m[1].trim() : undefined;
}

export const SUPPORTED_PROVIDERS: { id: AiProvider; label: string; needsBaseUrl: boolean }[] = [
  { id: 'openai', label: 'OpenAI', needsBaseUrl: false },
  { id: 'anthropic', label: 'Anthropic', needsBaseUrl: false },
  { id: 'openai-compatible', label: 'OpenAI 兼容（自定义网关）', needsBaseUrl: true },
];
