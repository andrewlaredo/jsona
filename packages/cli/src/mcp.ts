// jsona MCP Server (L3), implemented with the official @modelcontextprotocol/sdk.
//
// Exposes jsona's local parse/query/convert engine to external AI agents as
// Model Context Protocol tools. Transports:
//
//   stdio  — `jsona mcp`                              (local agents)
//   http   — `jsona mcp --http [--port N]`            (remote agents, Streamable HTTP + SSE)
//   http+  — `jsona mcp --http --auth`                (remote agents, OAuth 2.1 protected)
//   ws     — `jsona mcp --ws [--port N]`              (remote agents over WebSocket)
//
// Client capabilities exercised by the tools below:
//   - `jsona_ask`   uses MCP *sampling* (server → client LLM, sampling/createMessage)
//   - `jsona_roots` reads MCP *roots* (server → client roots/list)
// Both degrade to a clear error if the connected client does not advertise the
// corresponding capability.
//
// MCP primitives exposed:
//   - Resources: `jsona://help` (static) and `jsona://samples/{format}` (template)
//   - Prompts:   `jsona_explain`, `jsona_validate`
//
// No database, no network egress beyond what the agent itself sends: the agent
// supplies a document and jsona returns structure/query results computed
// entirely in-process. This keeps the "data zero-upload" promise even when an
// LLM orchestrates the work.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { JSONRPCMessage, SamplingMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { McpOAuthStore } from './mcp-oauth.js';
import {
  parse,
  queryPath,
  astToFormat,
  type JsonNode,
  type SupportedFormat,
} from 'jsona-core';

/** Local structural summary. Mirrors packages/web/src/ai/inspect.ts but stays
 *  self-contained so the MCP server has no dependency on the web package. */
function structuralSummary(root: JsonNode) {
  let nodeCount = 0;
  let maxDepth = 0;
  const typeDist: Record<string, number> = {};
  let nullCount = 0;
  const walk = (n: JsonNode, depth: number) => {
    nodeCount++;
    typeDist[n.kind] = (typeDist[n.kind] ?? 0) + 1;
    if (depth > maxDepth) maxDepth = depth;
    if (n.kind === 'null' || n.value === null || n.value === undefined) nullCount++;
    for (const c of n.children ?? ([] as JsonNode[])) walk(c, depth + 1);
  };
  walk(root, 0);
  const topLevelKeys =
    root.kind === 'object'
      ? (root.children ?? []).map((c) => String(c.key))
      : root.kind === 'array'
        ? [`[array of ${(root.children ?? []).length} items]`]
        : [];
  return {
    rootKind: root.kind,
    nodeCount,
    maxDepth,
    nullCount,
    typeDistribution: Object.entries(typeDist).map(([kind, count]) => ({ kind, count })),
    topLevelKeys,
  };
}

const FORMATS = ['auto', 'json', 'yaml', 'toml', 'csv'] as const;
type FormatArg = (typeof FORMATS)[number];

/** Example documents used by the `jsona://samples/{format}` resource. */
const SAMPLE_DOCS: Record<string, string> = {
  json: '{\n  "name": "Ada",\n  "age": 36,\n  "roles": ["admin", "author"],\n  "active": true\n}',
  yaml: 'name: Ada\nage: 36\nroles:\n  - admin\n  - author\nactive: true\n',
  toml: 'name = "Ada"\nage = 36\nactive = true\nroles = ["admin", "author"]\n',
  csv: 'name,age,role\nAda,36,admin\nBob,29,author\n',
};

/** Shared parse step: auto-detect unless a format is forced. Throws with a
 *  friendly message on invalid input so the tool surfaces a tool error. */
function parseInput(source: string, fmt: FormatArg) {
  const resolved: SupportedFormat | undefined =
    fmt === 'auto' ? undefined : (fmt as SupportedFormat);
  try {
    return parse(source, { format: resolved });
  } catch (e) {
    throw new Error(
      `failed to parse document${fmt !== 'auto' ? ` as ${fmt}` : ''}: ${(e as Error).message}`,
    );
  }
}

export function createMcpServer(): McpServer {
  // In-process cache for the client's roots. The MCP spec lets the client push
  // `notifications/roots/list_changed` so a server can refresh lazily, but the
  // SDK (v1.30) does not yet expose a server-side subscription hook — so we
  // cache the last `roots/list` result for a short TTL and let the tool force a
  // refresh on demand. See `jsona_roots` below.
  const ROOTS_TTL_MS = 30_000;
  let rootsCache: { at: number; roots: { uri: string; name: string | null }[] } | null = null;

  const server = new McpServer({
    name: 'jsona',
    version: '0.2.0',
  });

  server.registerTool(
    'jsona_query',
    {
      title: 'Query a document by JSON-path',
      description:
        'Query a JSON/YAML/TOML/CSV document by dot/bracket JSON-path and return the matching node(s). The agent supplies the document text and a path like "users.0.email". Returns {found, value, path}.',
      inputSchema: {
        source: z.string().describe('Document text in any supported format.'),
        path: z.string().describe('Dot/bracket JSON-path, e.g. "a.b[0].c".'),
        format: z
          .enum(['auto', 'json', 'yaml', 'toml', 'csv'])
          .default('auto')
          .describe('Force input format. auto detects from content.'),
      },
    },
    async ({ source, path, format }) => {
      const res = parseInput(source, format as FormatArg);
      const node = queryPath(res.root, path);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { found: Boolean(node), value: node ? node.value : null, path: node?.path ?? null },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'jsona_schema',
    {
      title: 'Structural summary of a document',
      description:
        'Return a structural summary of a document: root kind, node count, max depth, type distribution, null count and top-level keys. Cheaper than returning the whole document.',
      inputSchema: {
        source: z.string().describe('Document text in any supported format.'),
        format: z
          .enum(['auto', 'json', 'yaml', 'toml', 'csv'])
          .default('auto')
          .describe('Force input format. auto detects from content.'),
      },
    },
    async ({ source, format }) => {
      const res = parseInput(source, format as FormatArg);
      return { content: [{ type: 'text', text: JSON.stringify(structuralSummary(res.root), null, 2) }] };
    },
  );

  server.registerTool(
    'jsona_convert',
    {
      title: 'Convert between formats',
      description:
        'Convert a document from one supported format to another (json/yaml/toml/csv).',
      inputSchema: {
        source: z.string().describe('Document text in any supported format.'),
        to: z
          .enum(['json', 'yaml', 'toml', 'csv'])
          .describe('Target output format.'),
        format: z
          .enum(['auto', 'json', 'yaml', 'toml', 'csv'])
          .default('auto')
          .describe('Force input format. auto detects from content.'),
      },
    },
    async ({ source, to, format }) => {
      const res = parseInput(source, format as FormatArg);
      const out = astToFormat(res.root, to);
      return {
        content: [{ type: 'text', text: JSON.stringify({ format: to, mime: out.mime, text: out.text }, null, 2) }],
      };
    },
  );

  // --- Client capability: sampling (server → client LLM) -------------------
  // MCP lets a *server* ask the *client* to run an LLM completion via
  // `sampling/createMessage`. We expose it as a tool so an agent can, e.g.,
  // ask the client's model to explain a JSON document in plain language.
  // Requires the client to advertise `sampling` in its initialization
  // capabilities (SDK clients enable this by default).
  server.registerTool(
    'jsona_ask',
    {
      title: 'Ask the client LLM to describe a document (sampling)',
      description:
        'Use the client LLM (MCP "sampling" capability) to explain, summarise, or answer a question about a JSON/YAML/TOML/CSV document. The document is sent to the client, not to jsona servers. Requires the client to support `sampling`.',
      inputSchema: {
        source: z.string().describe('Document text in any supported format.'),
        question: z.string().describe('What you want the LLM to say about the document.'),
        format: z
          .enum(['auto', 'json', 'yaml', 'toml', 'csv'])
          .default('auto')
          .describe('Force input format. auto detects from content.'),
        systemPrompt: z
          .string()
          .optional()
          .describe('Optional system prompt steering the LLM (e.g. "You are a strict JSON reviewer").'),
        maxTokens: z
          .number()
          .int()
          .min(1)
          .max(4096)
          .default(512)
          .describe('Maximum tokens for the LLM response.'),
      },
    },
    async ({ source, question, format, systemPrompt, maxTokens }) => {
      const caps = server.server.getClientCapabilities();
      if (!caps?.sampling) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'This client does not advertise the `sampling` capability, so jsona cannot ask its LLM. Connect a client that supports MCP sampling (e.g. the official SDK Client with sampling enabled).',
            },
          ],
        };
      }
      // We parse only to confirm validity; the raw text is forwarded to the
      // client LLM so it sees the document exactly as the agent supplied it.
      parseInput(source, format as FormatArg);
      const messages: SamplingMessage[] = [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Document:\n${source}\n\nTask: ${question}`,
          },
        },
      ];
      try {
        const result = await server.server.createMessage({
          messages,
          maxTokens,
          ...(systemPrompt ? { systemPrompt } : {}),
        });
        const text =
          result.content.type === 'text' ? result.content.text : JSON.stringify(result.content);
        const out = {
          role: result.role,
          model: result.model,
          stopReason: result.stopReason,
          text,
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text', text: `sampling/createMessage failed: ${(e as Error).message}` }],
        };
      }
    },
  );

  // --- Client capability: roots (server reads client filesystem roots) ------
  // MCP "roots" let the client expose a set of filesystem/URI roots the server
  // may read from. jsona exposes a tool to list them so an agent can discover
  // what document collections the client has made available.
  server.registerTool(
    'jsona_roots',
    {
      title: 'List the client roots (roots capability)',
      description:
        'List the roots the connected client has exposed via the MCP `roots` capability (typically filesystem:// URIs the client allows the server to read). Requires the client to support `roots`. Results are cached for 30s; pass refresh=true to force a fresh roots/list.',
      inputSchema: {
        refresh: z
          .boolean()
          .default(false)
          .describe('Bypass the 30s cache and re-query the client for its current roots.'),
      },
    },
    async ({ refresh }) => {
      const caps = server.server.getClientCapabilities();
      if (!caps?.roots) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'This client does not advertise the `roots` capability, so jsona cannot list its roots. Connect a client that supports MCP roots (e.g. the official SDK Client with a roots list provider).',
            },
          ],
        };
      }
      const cached = rootsCache && !refresh && Date.now() - rootsCache.at < ROOTS_TTL_MS;
      if (cached) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { count: rootsCache!.roots.length, cached: true, roots: rootsCache!.roots },
                null,
                2,
              ),
            },
          ],
        };
      }
      try {
        const result = await server.server.listRoots();
        const roots = (result.roots ?? []).map((r) => ({ uri: r.uri, name: r.name ?? null }));
        rootsCache = { at: Date.now(), roots };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: roots.length, cached: false, roots }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text', text: `roots/list failed: ${(e as Error).message}` }],
        };
      }
    },
  );

  // --- MCP Resources --------------------------------------------------------
  // Resources let a client discover and read documents the server exposes
  // without invoking a tool. We provide:
  //   - `jsona://help`      static doc: what jsona's MCP server can do
  //   - `jsona://samples/{format}` template: a small example document in the
  //     requested format (json|yaml|toml|csv), so an agent can `read` it and
  //     then exercise jsona_convert / jsona_query against a known shape.
  const HELP_DOC = [
    '# jsona MCP Server',
    '',
    'jsona exposes local JSON/YAML/TOML/CSV tooling to AI agents over MCP.',
    '',
    '## Tools',
    '- `jsona_query` — query a document by JSON-path',
    '- `jsona_schema` — structural summary of a document',
    '- `jsona_convert` — convert between json/yaml/toml/csv',
    '- `jsona_ask` — ask the *client* LLM (sampling) to describe a document',
    '- `jsona_roots` — list the *client* roots (filesystem/URI roots)',
    '',
    '## Resources',
    '- `jsona://help` — this document',
    '- `jsona://samples/{format}` — an example document (json|yaml|toml|csv)',
    '',
    '## Prompts',
    '- `jsona_explain` — instruct an LLM how to explain a document',
    '- `jsona_validate` — instruct an LLM to validate a document',
    '',
    'All computation is in-process; no document leaves the agent unless the',
    'agent itself sends it. Privacy: jsona_ask uses client-side sampling, so',
    'your LLM sees the document, not jsona servers.',
  ].join('\n');

  server.registerResource(
    'jsona-help',
    'jsona://help',
    { title: 'jsona MCP capabilities', description: 'What the jsona MCP server can do.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: HELP_DOC }],
    }),
  );

  server.registerResource(
    'jsona-samples',
    new ResourceTemplate('jsona://samples/{format}', {
      list: undefined,
      complete: { format: (value: string) => SAMPLE_DOCS_Cbf(value) },
    }),
    {
      title: 'Example documents by format',
      description: 'A small example document in the requested format (json|yaml|toml|csv).',
    },
    async (uri, variables) => {
      const fmt = String(variables.format).toLowerCase();
      const doc = SAMPLE_DOCS[fmt];
      if (!doc) {
        throw new Error(
          `unknown format "${fmt}". Supported: ${Object.keys(SAMPLE_DOCS).join(', ')}`,
        );
      }
      const mime = fmt === 'json' ? 'application/json' : fmt === 'csv' ? 'text/csv' : 'text/plain';
      return { contents: [{ uri: uri.href, mimeType: mime, text: doc }] };
    },
  );

  // --- MCP Prompts ----------------------------------------------------------
  // Prompts are reusable instruction sets an agent can `get` and hand to its
  // LLM. They complement tools (which execute) with guidance (which steers).
  server.registerPrompt(
    'jsona_explain',
    {
      title: 'Explain a document',
      description: 'Instruct an LLM how to explain a JSON/YAML/TOML/CSV document using jsona.',
      argsSchema: {
        format: z
          .enum(['auto', 'json', 'yaml', 'toml', 'csv'])
          .default('auto')
          .describe('The document format (used to tailor the guidance).'),
        question: z.string().optional().describe('A specific question to answer about the document.'),
      },
    },
    async ({ format, question }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'You are a data-structure expert. Using the jsona MCP tools, first run ' +
              '`jsona_schema` to understand the document shape, then `jsona_query` for any ' +
              `specific fields. The document is ${format === 'auto' ? 'in an unknown' : format} format.` +
              (question ? ` Answer this question: ${question}` : ' Provide a concise explanation of its structure and purpose.'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'jsona_validate',
    {
      title: 'Validate a document',
      description: 'Instruct an LLM to validate a document using jsona tools.',
      argsSchema: {
        source: z.string().describe('The document text to validate.'),
        format: z
          .enum(['auto', 'json', 'yaml', 'toml', 'csv'])
          .default('auto')
          .describe('Force input format; auto detects.'),
      },
    },
    async ({ source, format }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Validate the following document. Use `jsona_schema` to confirm its structure and ' +
              '`jsona_query` to spot-check fields. Report any malformed or inconsistent parts.\n\n' +
              `Format hint: ${format}\n\nDocument:\n${source}`,
          },
        },
      ],
    }),
  );

  return server;
}

// Helper for ResourceTemplate autocompletion (kept module-scope to avoid
// inlining a closure in the registerResource call above).
function SAMPLE_DOCS_Cbf(value: string): string[] {
  const wanted = value.toLowerCase();
  return Object.keys(SAMPLE_DOCS).filter((k) => k.startsWith(wanted));
}

/** Start the server on stdio and keep the process alive until stdin closes. */
export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log only diagnostics on a dedicated stream would need an env gate; for a
  // CLI we stay quiet on stdout (protocol channel) after connect.
  process.stderr.write('[jsona] MCP server running over stdio (Ctrl+C to stop)\n');
}

const HTTP_PATH = '/mcp';
const DEFAULT_HTTP_PORT = 3939;

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(payload);
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Start jsona as an MCP Streamable HTTP server (remote agents).
 *
 * The Streamable HTTP transport is per-session: each MCP session gets its own
 * `StreamableHTTPServerTransport` instance keyed by `Mcp-Session-Id`. GET opens
 * an SSE stream, POST delivers JSON-RPC messages (responses stream back over
 * SSE or as a direct reply), DELETE terminates a session.
 *
 * CORS is wide-open so remote agent UIs can call it cross-origin; bind the port
 * to 127.0.0.1 or put it behind a reverse proxy (with auth) when exposing
 * publicly.
 */
export async function runHttpMcpServer(opts?: {
  port?: number;
  host?: string;
}): Promise<void> {
  const port = opts?.port ?? DEFAULT_HTTP_PORT;
  const host = opts?.host ?? '127.0.0.1';
  // The SDK's Protocol (McpServer) supports exactly one transport per instance,
  // so each MCP session gets its own McpServer. Tools are stateless pure
  // functions over the document text passed per-call, so per-session instances
  // are safe and cheap.
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== HTTP_PATH) {
      writeJson(res, 404, { error: `not found: ${url.pathname} (use ${HTTP_PATH})` });
      return;
    }

    const sessionId = getHeader(req, 'mcp-session-id');

    // Session termination
    if (req.method === 'DELETE') {
      if (sessionId) {
        const s = sessions.get(sessionId);
        if (s) {
          sessions.delete(sessionId);
          await s.transport.close().catch(() => undefined);
        }
      }
      writeJson(res, 200, {});
      return;
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      return;
    }

    // Find or create the per-session transport + its own McpServer.
    // Note: the generated session id only exists AFTER the first (initialize)
    // request is handled, so we register the session post-handle below.
    let session: { transport: StreamableHTTPServerTransport; server: McpServer } | undefined = sessionId
      ? sessions.get(sessionId)
      : undefined;
    const isNew = !session;
    if (isNew) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server = createMcpServer();
      await server.connect(transport);
      session = { transport, server };
    }
    const active = session as { transport: StreamableHTTPServerTransport; server: McpServer };

    try {
      await active.transport.handleRequest(req, res);
      if (isNew && active.transport.sessionId) {
        sessions.set(active.transport.sessionId, active);
      }
    } catch (err) {
      const message = (err as Error).message;
      process.stderr.write(`[jsona] mcp http error: ${message}\n`);
      if (!res.headersSent) writeJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  process.stderr.write(
    `[jsona] MCP Streamable HTTP server listening on http://${host}:${port}${HTTP_PATH} (Ctrl+C to stop)\n`,
  );

  const shutdown = () => {
    void (async () => {
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      sessions.clear();
      server.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Start jsona's MCP endpoint behind the SDK's standard OAuth 2.1 flow.
 *
 * - `.well-known/oauth-authorization-server` metadata (mcpAuthRouter)
 * - dynamic client registration, authorize (PKCE), token, revoke
 * - `/mcp` requires a valid Bearer access token
 *
 * Use the SDK's StreamableHTTPServerTransport on an Express app. Each session
 * still gets its own McpServer (Protocol = one transport per instance).
 */
export async function runAuthHttpMcpServer(opts?: {
  port?: number;
  host?: string;
  stateFile?: string;
  issuerUrl?: string;
}): Promise<void> {
  const port = opts?.port ?? DEFAULT_HTTP_PORT;
  const host = opts?.host ?? '127.0.0.1';
  const issuerUrl = new URL(opts?.issuerUrl ?? `http://${host}:${port}`);

  const store = new McpOAuthStore({
    stateFile: opts?.stateFile,
    issuerUrl,
  });

  // Build the Express app by hand. `createMcpExpressApp` mounts express.json()
  // globally, which would consume the /mcp request body before
  // StreamableHTTPServerTransport.handleRequest can read it (it parses the raw
  // body itself). So we register /mcp FIRST (raw body), then mount the JSON
  // parser + OAuth router for everything else.
  const app = express();
  app.disable('x-powered-by');

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  // /mcp is protected by Bearer auth; the verifier is the same store that
  // issued the token (HS256 JWT).
  app.use(
    HTTP_PATH,
    requireBearerAuth({ verifier: store.provider }),
    async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (req.method === 'DELETE') {
        if (sessionId) {
          const s = sessions.get(sessionId);
          if (s) {
            sessions.delete(sessionId);
            await s.transport.close().catch(() => undefined);
          }
        }
        res.json({});
        return;
      }

      let session: { transport: StreamableHTTPServerTransport; server: McpServer } | undefined = sessionId
        ? sessions.get(sessionId)
        : undefined;
      const isNew = !session;
      if (isNew) {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        const server = createMcpServer();
        await server.connect(transport);
        session = { transport, server };
      }
      const active = session as { transport: StreamableHTTPServerTransport; server: McpServer };

      try {
        await active.transport.handleRequest(req, res);
        if (isNew && active.transport.sessionId) {
          sessions.set(active.transport.sessionId, active);
        }
      } catch (err) {
        const message = (err as Error).message;
        process.stderr.write(`[jsona] mcp http error: ${message}\n`);
        if (!res.headersSent) res.status(500).json({ error: message });
      }
    },
  );

  // OAuth endpoints (registered after /mcp so their JSON body parser does not
  // consume /mcp request bodies).
  app.use(express.json());
  app.use(mcpAuthRouter({ provider: store.provider, issuerUrl }));

  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(port, host);
    srv.once('listening', resolve);
    srv.once('error', reject);
  });
  process.stderr.write(
    `[jsona] MCP HTTP server with OAuth listening on http://${host}:${port}${HTTP_PATH} (Ctrl+C to stop)\n` +
      `[jsona] OAuth metadata: http://${host}:${port}/.well-known/oauth-authorization-server\n`,
  );

  const shutdown = () => {
    void (async () => {
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      sessions.clear();
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Start jsona's MCP endpoint over WebSocket (per MCP spec, the client connects
 * with subprotocol `mcp`). Each connection gets its own McpServer + transport.
 *
 * WebSocketServer from `ws` handles the upgrade; we adapt its WebSocket into
 * the SDK Transport interface (start/send/close + callbacks). No HTTP REST
 * surface is exposed here — it is a pure WS endpoint.
 */
export async function runWsMcpServer(opts?: { port?: number; host?: string }): Promise<void> {
  const port = opts?.port ?? 3939;
  const host = opts?.host ?? '127.0.0.1';

  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket: WebSocket) => {
    const mcpServer = createMcpServer();
    const transport = new WsTransport(socket);
    void mcpServer.connect(transport).catch((err) => {
      process.stderr.write(`[jsona] ws connect error: ${(err as Error).message}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  process.stderr.write(
    `[jsona] MCP WebSocket server listening on ws://${host}:${port}/ (Ctrl+C to stop)\n`,
  );

  const shutdown = () => {
    void (async () => {
      for (const c of wss.clients) c.close();
      server.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Minimal MCP Transport adapter over a `ws` WebSocket. */
class WsTransport {
  private socket: WebSocket;
  private closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      if (this.onmessage) {
        try {
          this.onmessage(JSON.parse(data.toString()) as JSONRPCMessage);
        } catch (err) {
          this.onerror?.(err as Error);
        }
      }
    });
    socket.on('close', () => {
      this.closed = true;
      this.onclose?.();
    });
    socket.on('error', (err) => this.onerror?.(err as Error));
  }

  async start(): Promise<void> {
    // ws already connected before this adapter is constructed
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

/** Print the tool catalog (JSON) and exit — for `jsona mcp --manifest`. */
export function printManifest(): void {
  process.stdout.write(
    JSON.stringify(
      {
        name: 'jsona',
        transports: ['stdio', 'http', 'http-auth', 'websocket'],
        run: {
          stdio: 'jsona mcp',
          http: 'jsona mcp --http --port 3939  (endpoint: /mcp, MCP Streamable HTTP + SSE)',
          httpAuth: 'jsona mcp --http --auth --port 3939  (OAuth 2.1 protected, dynamic client registration)',
          websocket: 'jsona mcp --ws --port 3939  (subprotocol: mcp)',
        },
        tools: [
          { name: 'jsona_query', description: 'Query a document by JSON-path and return matches.' },
          { name: 'jsona_schema', description: 'Structural summary of a document (cheap, no full payload).' },
          { name: 'jsona_convert', description: 'Convert between json/yaml/toml/csv.' },
          { name: 'jsona_ask', description: 'Client-LLM sampling: ask the client LLM to describe/summarise a document.' },
          { name: 'jsona_roots', description: 'Roots capability: list filesystem/URI roots the client exposes (30s cache, refresh=true to bypass).' },
        ],
        resources: [
          { uri: 'jsona://help', description: 'Static doc: what the jsona MCP server can do.' },
          { uri: 'jsona://samples/{format}', description: 'Template: an example document (json|yaml|toml|csv).' },
        ],
        prompts: [
          { name: 'jsona_explain', description: 'Instruct an LLM how to explain a document using jsona.' },
          { name: 'jsona_validate', description: 'Instruct an LLM to validate a document using jsona.' },
        ],
      },
      null,
      2,
    ) + '\n',
  );
}
