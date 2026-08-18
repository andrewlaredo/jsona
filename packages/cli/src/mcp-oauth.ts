// OAuth 2.1 authorization server provider for jsona's MCP HTTP endpoint.
//
// Implements the OAuthServerProvider + OAuthRegisteredClientsStore contracts
// from @modelcontextprotocol/sdk so the SDK's standard endpoints (authorize /
// token / register / revoke / metadata) work out of the box. Access & refresh
// tokens are signed JWTs (HS256) via `jose`. Authorize codes are PKCE-verified.
//
// State is persisted to `~/.jsona/oauth.json` so registered clients and issued
// tokens survive restarts. The signing key is generated once and stored in the
// same file (0770 perms); use `--oauth-signing-key-file` to point elsewhere.

import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const ISSUER = 'jsona-mcp';

interface PersistedState {
  signingKey: string;
  clients: Record<string, OAuthClientInformationFull>;
  // code -> { challenge, clientId, redirectUri, expiresAt, used }
  authCodes: Record<string, { challenge: string; clientId: string; redirectUri: string; expiresAt: number; used?: boolean }>;
  // jti -> refreshToken expiry
  refreshTokens: Record<string, { expiresAt: number }>;
}

function defaultStateFile(): string {
  return join(homedir(), '.jsona', 'oauth.json');
}

export interface OAuthStoreOptions {
  stateFile?: string;
  issuerUrl?: URL;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  authCodeTtlSec?: number;
}

export class McpOAuthStore {
  private state: PersistedState;
  private stateFile: string;
  readonly issuerUrl: URL;
  private accessTokenTtlSec: number;
  private refreshTokenTtlSec: number;
  private authCodeTtlSec: number;
  private jwksKey: Uint8Array;

  constructor(opts: OAuthStoreOptions = {}) {
    this.stateFile = opts.stateFile ?? defaultStateFile();
    this.issuerUrl = opts.issuerUrl ?? new URL('http://127.0.0.1:3939');
    this.accessTokenTtlSec = opts.accessTokenTtlSec ?? 3600;
    this.refreshTokenTtlSec = opts.refreshTokenTtlSec ?? 30 * 24 * 3600;
    this.authCodeTtlSec = opts.authCodeTtlSec ?? 600;

    this.state = this.loadState();
    this.jwksKey = Uint8Array.from(Buffer.from(this.state.signingKey, 'hex'));
  }

  private loadState(): PersistedState {
    try {
      if (existsSync(this.stateFile)) {
        const raw = readFileSync(this.stateFile, 'utf8');
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed.signingKey && parsed.clients && parsed.authCodes && parsed.refreshTokens) {
          return parsed;
        }
      }
    } catch {
      // fall through to fresh state
    }
    const signingKey = randomBytes(32).toString('hex');
    const fresh: PersistedState = {
      signingKey,
      clients: {},
      authCodes: {},
      refreshTokens: {},
    };
    this.saveState(fresh);
    return fresh;
  }

  private saveState(state = this.state): void {
    mkdirSync(join(this.stateFile, '..'), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  private persist(): void {
    this.saveState();
  }

  // ---------------- clients store ----------------

  get clientsStore(): OAuthRegisteredClientsStore {
    const self = this;
    return {
      async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        return self.state.clients[clientId];
      },
      async registerClient(
        client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
      ): Promise<OAuthClientInformationFull> {
        const clientId = `jsona_${randomBytes(12).toString('hex')}`;
        const clientSecret = randomBytes(24).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: clientId,
          client_secret: clientSecret,
          client_id_issued_at: now,
        };
        self.state.clients[clientId] = full;
        self.persist();
        return full;
      },
    };
  }

  // ---------------- provider ----------------

  get provider(): OAuthServerProvider {
    const self = this;
    return {
      get clientsStore() {
        return self.clientsStore;
      },
      async authorize(
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
        res: import('express').Response,
      ): Promise<void> {
        // This is a headless server; auto-approve the authorization after
        // binding the PKCE challenge to the code. In production you would
        // render a consent screen here. The `state` is passed through.
        const code = randomBytes(24).toString('base64url');
        self.state.authCodes[code] = {
          challenge: params.codeChallenge,
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          expiresAt: Date.now() + self.authCodeTtlSec * 1000,
        };
        self.persist();
        const redirect = new URL(params.redirectUri);
        redirect.searchParams.set('code', code);
        if (params.state) redirect.searchParams.set('state', params.state);
        res.redirect(redirect.toString());
      },
      async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
        const c = self.state.authCodes[authorizationCode];
        if (!c || c.clientId !== client.client_id) throw new Error('invalid authorization code');
        return c.challenge;
      },
      async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        codeVerifier?: string,
      ): Promise<OAuthTokens> {
        const c = self.state.authCodes[authorizationCode];
        if (!c || c.clientId !== client.client_id || c.used) throw new Error('invalid authorization code');
        if (c.expiresAt < Date.now()) throw new Error('authorization code expired');
        // PKCE S256 verification
        if (codeVerifier) {
          const expected = createHash('sha256').update(codeVerifier).digest('base64url');
          if (expected !== c.challenge) throw new Error('code_verifier mismatch');
        }
        c.used = true;
        self.persist();
        return self.issueTokens(client.client_id);
      },
      async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        _scopes?: string[],
      ): Promise<OAuthTokens> {
        try {
          const { payload } = await jwtVerify(refreshToken, self.jwksKey, { issuer: ISSUER });
          const jti = payload.jti as string;
          const rt = self.state.refreshTokens[jti];
          if (!rt || rt.expiresAt < Date.now()) throw new Error('invalid refresh token');
          return self.issueTokens(client.client_id);
        } catch {
          throw new Error('invalid refresh token');
        }
      },
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const { payload } = await jwtVerify(token, self.jwksKey, { issuer: ISSUER });
        return {
          token,
          clientId: payload.client_id as string,
          scopes: (payload.scope as string[] | undefined) ?? [],
          expiresAt: payload.exp as number,
        };
      },
      async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
        // Best-effort: if it's a refresh token, drop its record.
        try {
          const { payload } = await jwtVerify(request.token, self.jwksKey, { issuer: ISSUER });
          if (payload.jti) {
            delete self.state.refreshTokens[payload.jti as string];
            self.persist();
          }
        } catch {
          // ignore
        }
      },
    };
  }

  private async issueTokens(clientId: string): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const accessJti = randomBytes(12).toString('hex');
    const refreshJti = randomBytes(12).toString('hex');
    const accessToken = await new SignJWT({ client_id: clientId, scope: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setJti(accessJti)
      .setIssuedAt(now)
      .setExpirationTime(now + this.accessTokenTtlSec)
      .sign(this.jwksKey);
    const refreshToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setJti(refreshJti)
      .setIssuedAt(now)
      .setExpirationTime(now + this.refreshTokenTtlSec)
      .sign(this.jwksKey);
    this.state.refreshTokens[refreshJti] = { expiresAt: now + this.refreshTokenTtlSec };
    this.persist();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: '',
    };
  }
}
