// mcp.ts — the Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 over
// Streamable HTTP, answered as plain JSON (no SSE needed: the client accepts it).
//
// The modern era (2026-07-28): server/discover answers identity, capabilities and
// supportedVersions in one request; no handshake, no session. The legacy handshake
// (initialize + notifications/initialized) is answered too, for older clients.
// Every tools/list answer is byte-identical (one static array); tool results carry
// both a text block and structuredContent so the suite can read them either way.

import {
  createIssue,
  createPull,
  findPull,
  issueJson,
  pullJson,
  repoJson,
  squashMerge,
  type Store,
} from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function jsonBody(status: number, value: unknown): McpResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8') };
}

function rpcResult(id: string | number | null, result: unknown): McpResponse {
  return jsonBody(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): McpResponse {
  return jsonBody(status, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError,
  };
}

function missingArg(tool: Tool, args: Record<string, unknown>): string | null {
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') return required;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return toolResult(`Unknown tool: ${name}`, true);
  const missing = missingArg(tool, args);
  if (missing !== null) return toolResult(`Missing required argument: ${missing}`, true);
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.viewer.login;
  const repoName = String(args.repo ?? args.name ?? '');

  if (name === 'create_repo') {
    const repo = store.createRepo(owner, repoName, {
      private: typeof args.private === 'boolean' ? args.private : false,
      description: typeof args.description === 'string' ? args.description : '',
    });
    if ('error' in repo) return toolResult(`Repository ${owner}/${repoName} already exists`, true);
    return toolResult(repoJson(store, repo));
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) return toolResult(`Repository ${owner}/${repoName} not found`, true);

  if (name === 'get_repo') {
    return toolResult(repoJson(store, repo));
  }
  if (name === 'create_issue') {
    const created = createIssue(store, repo, {
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
    });
    if ('error' in created) return toolResult(`Cannot create issue: ${created.error}`, true);
    return toolResult(issueJson(store, repo, created));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolResult(issues.map((issue) => issueJson(store, repo, issue)));
  }
  if (name === 'create_pull_request') {
    const created = createPull(store, repo, {
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      head: String(args.head),
      base: String(args.base),
    });
    if ('error' in created) return toolResult(`Cannot create pull request: ${created.error}`, true);
    return toolResult(pullJson(store, repo, created));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = findPull(repo, number);
    if (!pull) return toolResult(`Pull request #${number} not found`, true);
    const merged = squashMerge(store, repo, pull);
    if ('error' in merged) return toolResult(`Cannot merge pull request #${number}: ${merged.error}`, true);
    return toolResult({ number, merged: true, sha: merged.sha });
  }
  return toolResult(`Unknown tool: ${name}`, true);
}

/** Extract a JSON-RPC id from a broken body, for the parse-error answer. */
function extractId(raw: string): string | number | null {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (!match) return null;
  const token = match[1]!;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  const number = Number(token);
  return Number.isFinite(number) ? number : null;
}

function handleOne(store: Store, request: unknown): McpResponse {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const body = request as Record<string, unknown>;
  const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params as Record<string, unknown> | undefined) ?? {};

  // Notifications (no id) need no answer.
  if (body.id === undefined) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
    if (toolName === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    if (!TOOLS_BY_NAME.has(toolName)) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    return rpcResult(id, callTool(store, toolName, args));
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle a POST /mcp request. `rawBody` is the exact request bytes: a body that is not
 * JSON answers HTTP 400 with JSON-RPC -32700.
 */
export function handleMcp(store: Store, rawBody: Buffer): McpResponse {
  const raw = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rpcError(extractId(raw), -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const entry of parsed) {
      const response = handleOne(store, entry);
      if (response.status === 202) continue;
      responses.push(JSON.parse(response.body.toString('utf8')) as unknown);
    }
    return jsonBody(200, responses);
  }
  return handleOne(store, parsed);
}
