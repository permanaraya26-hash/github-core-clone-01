// app.ts — the HTTP server: routing, auth, body reading and JSON plumbing.
// main.ts imports createApp() from here and owns the entry <-> env lifecycle;
// this file owns the forge's surface.
//
// Routing:
//   GET  /healthz                              -> 200 {"ok":true} (no auth)
//   /*.git/info/refs, /*.git/git-upload-pack, /*.git/git-receive-pack -> git smart HTTP
//   POST /api/graphql                          -> GraphQL (one document or a batch)
//   POST /mcp                                  -> MCP JSON-RPC 2.0
//   /api/v3/*                                  -> REST v3
//   anything else                              -> 404 JSON
//
// Every response carries a non-empty X-GitHub-Request-Id. Every JSON body is
// application/json; errors are {"message": ...} and never HTML. A handler that
// throws answers 500 JSON instead of crashing the server.
//
// Auth: the trial token is MAKEFUN_SHOP_TOKEN. When it is set, only that bearer
// token is accepted; when it is unset (local practice), any non-empty bearer
// token is accepted. A missing token is always 401.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, type GitRequestContext } from './githttp.ts';
import { executeGraphQLBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAuthorized(req: IncomingMessage): boolean {
  const auth = headerValue(req.headers, 'authorization');
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  if (expected === '') return true;
  return token === expected;
}

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, { 'content-length': 0, 'x-github-request-id': requestId, ...extraHeaders });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

/** Parse a request body as JSON when it looks like JSON; report a malformed body. */
function parseJsonBody(body: Buffer, contentType: string | undefined): { json: unknown; malformed: boolean } {
  if (body.length === 0) return { json: null, malformed: false };
  const text = body.toString('utf8');
  const trimmed = text.trim();
  if (trimmed === '') return { json: null, malformed: false };
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const declaredJson = contentType !== undefined && contentType.toLowerCase().includes('json');
  if (!looksJson && !declaredJson) return { json: null, malformed: false };
  try {
    return { json: JSON.parse(text) as unknown, malformed: false };
  } catch {
    return { json: null, malformed: true };
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = store.nextRequestId();
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const segments = splitPath(pathname);
      const authorized = isAuthorized(req);

      // The env's boot probe: 200 {"ok":true}, no auth.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, requestId, 200, { ok: true });
        return;
      }

      const body = await readBody(req);
      const contentType = headerValue(req.headers, 'content-type');

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
        const gitCtx: GitRequestContext = {
          method,
          segments,
          query: url.searchParams,
          headers: {
            'git-protocol': headerValue(req.headers, 'git-protocol'),
          },
          body,
          authorized,
        };
        const gitResponse = handleGit(store, gitCtx);
        if (gitResponse !== null) {
          sendRaw(res, requestId, gitResponse.status, gitResponse.contentType, gitResponse.body);
          return;
        }
        sendJson(res, requestId, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL: POST /api/graphql (one document, or an array for batching).
      if (method === 'POST' && pathname === '/api/graphql') {
        if (!authorized) {
          sendJson(res, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        const parsed = parseJsonBody(body, contentType);
        if (parsed.malformed) {
          sendJson(res, requestId, 400, { message: 'Invalid JSON body' });
          return;
        }
        const result = executeGraphQLBody(store, parsed.json);
        sendJson(res, requestId, 200, result);
        return;
      }

      // MCP: POST /mcp (the raw body decides the parse error).
      if (method === 'POST' && pathname === '/mcp') {
        if (!authorized) {
          sendJson(res, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        const mcp = handleMcp(store, body);
        sendRaw(res, requestId, mcp.status, mcp.contentType, mcp.body, { 'mcp-protocol-version': '2026-07-28' });
        return;
      }

      // REST v3.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const parsed = parseJsonBody(body, contentType);
        const restReq: RestRequest = {
          method,
          segments,
          pathname,
          query: url.searchParams,
          headers: {
            'content-type': contentType,
          },
          body,
          json: parsed.json,
          jsonMalformed: parsed.malformed,
          host: headerValue(req.headers, 'host') ?? 'localhost',
          authorized,
        };
        const response = handleRest(store, restReq);
        if (response !== null) {
          sendJson(res, requestId, response.status, response.body, response.headers ?? {});
          return;
        }
        sendJson(res, requestId, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, requestId, 404, { message: 'Not Found' });
    } catch (err) {
      try {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      } catch {
        // Logging must never break the answer.
      }
      if (!res.headersSent) {
        sendJson(res, requestId, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });
}
