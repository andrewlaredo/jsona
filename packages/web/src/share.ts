import type { SupportedFormat } from 'jsona-core';

// Local-first sharing: the document is gzipped, base64url-encoded, and placed in
// the URL fragment (#doc=...). No server is involved — the data never leaves the
// browser except inside the link the user chooses to share.
//
// Server short links (optional, opt-in): POST /api/share -> { url: "/s/:id" }.
// The web client reads /s/:id (or #/s/:id) by fetching GET /api/share/:id.

const PREFIX = '#doc=';

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzip(input: string): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  const out = new Uint8Array(buf);
  const fixed = new Uint8Array(out.byteLength);
  fixed.set(out);
  return fixed;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

export interface SharePayload {
  source: string;
  format: SupportedFormat | 'auto';
}

/** Build a full shareable URL for the given document (stored in the URL hash). */
export async function buildShareUrl(payload: SharePayload): Promise<string> {
  const meta = JSON.stringify({
    f: payload.format === 'auto' ? 'auto' : payload.format,
    s: payload.source,
  });
  const compressed = await gzip(meta);
  const base = location.origin + location.pathname;
  return base + PREFIX + bytesToBase64url(compressed);
}

export interface ServerShareOpts {
  /** When true, quota/plan rejections (413/409/402) throw a localized Error
   *  with an upgrade hint instead of silently returning null. */
  alertQuotaUp?: boolean;
  apiBase?: string;
  password?: string;
}

/**
 * Create a server-side short link. Returns the URL. When `alertQuotaUp` is set
 * and the server rejects the share because of plan limits, rejects with an
 * Error describing the limit and how to upgrade. When the server is
 * unreachable, rejects with a generic error so the caller can show it.
 */
export async function buildServerShareUrl(
  payload: SharePayload,
  opts: ServerShareOpts = {},
): Promise<string> {
  const apiBase = opts.apiBase || (typeof window !== 'undefined' && (window as any).JSONA_API) || '';
  if (!apiBase) throw new Error('no server configured');
  const res = await fetch(`${apiBase}/api/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: payload.source,
      format: payload.format === 'auto' ? 'auto' : payload.format,
      password: opts.password,
    }),
  });
  if (res.ok) {
    const json = (await res.json()) as { url?: string };
    return json.url ?? '';
  }
  let msg = 'server share failed';
  try {
    const json = await res.json();
    if (json.error) msg = json.error as string;
  } catch {
    /* non-JSON */
  }
  if (opts.alertQuotaUp && (res.status === 413 || res.status === 409 || res.status === 402)) {
    throw new Error(`${msg} — upgrade at /pricing`);
  }
  throw new Error(msg);
}

/** Read a document from the current URL (hash or server short link), if present. */
export async function readShareFromUrl(): Promise<SharePayload | null> {
  if (location.hash.startsWith(PREFIX)) {
    try {
      const b64 = location.hash.slice(PREFIX.length);
      const bytes = base64urlToBytes(b64);
      const json = await gunzip(bytes);
      const meta = JSON.parse(json) as { f: SupportedFormat | 'auto'; s: string };
      return { source: meta.s, format: meta.f };
    } catch {
      return null;
    }
  }

  const shortId = extractShortId(location.pathname) ?? extractHashShortId(location.hash);
  if (shortId) return readServerShare(shortId);
  return null;
}

function extractShortId(pathname: string): string | null {
  const m = pathname.match(/\/s\/([\w\-]+)/);
  return m ? m[1] : null;
}

function extractHashShortId(hash: string): string | null {
  const m = hash.match(/#\/s\/([\w\-]+)/);
  return m ? m[1] : null;
}

async function readServerShare(id: string): Promise<SharePayload | null> {
  const bases = [apiBaseUrl(), '']; // relative first, then configured
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/api/share/${id}`);
      if (res.ok) {
        const json = (await res.json()) as { source: string; format: SupportedFormat | 'auto' };
        return { source: json.source, format: json.format };
      }
    } catch {
      // try next base
    }
  }
  return null;
}

let _apiBase = '';
export function setApiBase(url: string) {
  _apiBase = url;
}
function apiBaseUrl(): string {
  return _apiBase;
}

/** Approximate size of the share link (characters) for the UI warning. */
export function shareUrlLength(payload: SharePayload): number {
  const raw = JSON.stringify({ f: payload.format, s: payload.source }).length;
  return Math.ceil(raw * 1.4) + PREFIX.length + location.origin.length + location.pathname.length;
}
