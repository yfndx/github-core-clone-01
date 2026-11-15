// The HTTP server: one process, one store, four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP) plus the /healthz probe the env uses to find the entry.
//
// Authentication: every surface except GET /healthz and the three public REST roots
// (GET /api/v3, GET /api/v3/meta, GET /api/v3/rate_limit) requires the exact bearer
// token MAKEFUN_SHOP_TOKEN. A missing or wrong token is HTTP 401 JSON {message}.
// The token names the scenario viewer (adaiversen); a repo under any other owner is
// a 404, never a 403. Every REST reply is application/json and carries a non-empty
// X-GitHub-Request-Id; an unknown route is a JSON 404; a malformed JSON body is a
// JSON 400. The server never dies on a bad request: malformed pkt-lines, bad JSON,
// and unknown routes all get a clean error reply and the process keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { dispatchRest, requestId } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpRequest, parseMcpBody } from './mcp.ts';
import { Store } from './store.ts';

const DEV_TOKEN = 'dev-token';

function expectedToken(): string {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token) return token;
  process.stderr.write('[entry] MAKEFUN_SHOP_TOKEN is not set: accepting the dev token only\n');
  return DEV_TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(text)),
    'X-GitHub-Request-Id': requestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

const PUBLIC_REST_GETS = new Set(['/api/v3', '/api/v3/', '/api/v3/meta', '/api/v3/rate_limit']);

export function createApp(): Server {
  const store = new Store();
  const token = expectedToken();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await handle(req, res, store, token);
      } catch (error) {
        // Never let one bad request kill the process (repo-survives-errors).
        process.stderr.write(`[entry] handler error: ${error instanceof Error ? error.message : String(error)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store, token: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot probe: unauthenticated, answered twice at startup.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP. The auth check happens inside handleGit's caller path: every git
  // request carries the trial token, and an unknown repo is a JSON 404.
  if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const handled = await handleGit(req, res, store);
    if (handled) return;
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const envelope = executeGraphQL(body, store);
    sendJson(res, 200, envelope);
    return;
  }

  // MCP (Streamable HTTP).
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseMcpBody(raw);
    if (!parsed.ok) {
      // A JSON parse failure is HTTP 400 with JSON-RPC -32700, id null.
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId() });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const outcome = handleMcpRequest(parsed.value, store);
    if (outcome.body === null) {
      // A notification: HTTP 202, empty body.
      res.writeHead(202, { 'X-GitHub-Request-Id': requestId() });
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // REST v3. The three public roots do not need a token; everything else does.
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    if (!(method === 'GET' && PUBLIC_REST_GETS.has(path)) && !isAuthorized(req, token)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
    const outcome = dispatchRest(method, path, url.searchParams, raw, { store, token, baseUrl });
    if (outcome === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, outcome.status, outcome.body, outcome.headers ?? {});
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
