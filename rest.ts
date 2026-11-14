// rest.ts — the REST v3 surface (/api/v3). All replies are JSON with a message on errors.
// Pagination follows GitHub's Link rel="next" form; per_page/page are honoured everywhere
// a list is served.

import {
  blobShaAtRef,
  branchJson,
  commitContentChange,
  commitJson,
  createIssue,
  createPull,
  findIssue,
  findPull,
  getPathEntry,
  issueJson,
  commentJson,
  labelJson,
  listDirEntries,
  pullFiles,
  pullJson,
  repoJson,
  squashMerge,
  treeOfCommit,
  userJson,
  walkCommits,
  type Issue,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments (each percent-decoded). */
  segments: string[];
  /** The raw pathname, for building pagination URLs. */
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** The parsed JSON body, when the request carried valid JSON (null otherwise). */
  json: unknown;
  /** True when the body was present but not valid JSON. */
  jsonMalformed: boolean;
  host: string;
  authorized: boolean;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers: Record<string, string> = {}): RestResponse {
  return { status, body, headers };
}

function error(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** Slice a list into one page and build the Link header value, or null on the last page. */
function paginate<T>(items: readonly T[], req: RestRequest, pathname: string): { page: T[]; link: string | null } {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(req.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const urlFor = (pageNumber: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(pageNumber));
    return `http://${req.host}${pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function listResponse<T>(items: readonly T[], req: RestRequest, pathname: string, toJson: (item: T) => unknown): RestResponse {
  const { page, link } = paginate(items, req, pathname);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return ok(200, page.map(toJson), headers);
}

/** Resolve a repo from the path; the caller decides the 404. */
function repoOf(store: Store, owner: string, name: string): Repo | undefined {
  return store.getRepo(owner, name);
}

/** Resolve a ref name (branch) or oid to a tip commit, or null. */
function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(`refs/heads/${ref}`);
  if (direct) return direct;
  const full = repo.refs.get(ref);
  if (full) return full;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function contentsFileJson(store: Store, repo: Repo, path: string, blobOid: string, blob: Buffer): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: blob.length,
    name: path.split('/').pop() ?? path,
    path,
    content: blob.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  };
}

export function handleRest(store: Store, req: RestRequest): RestResponse | null {
  const segments = req.segments;
  if (segments.length === 0 || segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);

  if (req.jsonMalformed) return error(400, 'Invalid JSON body');

  // The API root and meta do not need a repository, but they do need a token.
  if (req.method === 'GET' && (rest.length === 0)) {
    if (!req.authorized) return error(401, 'Requires authentication');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (req.method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    if (!req.authorized) return error(401, 'Requires authentication');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  if (!req.authorized) return error(401, 'Requires authentication');

  // GET /api/v3/user
  if (req.method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    return ok(200, userJson(store, store.viewer.login));
  }

  // POST /api/v3/user/repos — create a repository.
  if (req.method === 'POST' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const name = stringField(req.json, 'name');
    if (!name) return error(422, 'name is required');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return error(422, 'name is invalid');
    const created = store.createRepo(store.viewer.login, name, {
      private: booleanField(req.json, 'private', false),
      description: stringField(req.json, 'description') ?? '',
      defaultBranch: stringField(req.json, 'default_branch'),
    });
    if ('error' in created) {
      return error(422, 'Repository creation failed. name already exists on this account');
    }
    return ok(201, repoJson(store, created));
  }

  // GET /api/v3/user/repos — list the viewer's repositories, paginated.
  if (req.method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    return listResponse(store.reposOf(store.viewer.login), req, req.pathname, (repo) => repoJson(store, repo));
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = repoOf(store, owner, name);
    const tail = rest.slice(3);

    // GET /api/v3/repos/{o}/{r}
    if (req.method === 'GET' && tail.length === 0) {
      if (!repo) return error(404, 'Not Found');
      return ok(200, repoJson(store, repo));
    }
    // PATCH /api/v3/repos/{o}/{r}
    if (req.method === 'PATCH' && tail.length === 0) {
      if (!repo) return error(404, 'Not Found');
      const description = stringField(req.json, 'description');
      if (description !== undefined) repo.description = description;
      repo.updatedAt = store.nowIso;
      return ok(200, repoJson(store, repo));
    }
    // DELETE /api/v3/repos/{o}/{r}
    if (req.method === 'DELETE' && tail.length === 0) {
      if (!repo) return error(404, 'Not Found');
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    if (!repo) return error(404, 'Not Found');

    // GET /api/v3/repos/{o}/{r}/branches
    if (req.method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push(branchJson(repo, ref.slice('refs/heads/'.length), sha));
      }
      return ok(200, branches);
    }
    // GET /api/v3/repos/{o}/{r}/branches/{branch}
    if (req.method === 'GET' && tail.length === 2 && tail[0] === 'branches') {
      const sha = repo.refs.get(`refs/heads/${tail[1]}`);
      if (!sha) return error(404, 'Branch not found');
      return ok(200, branchJson(repo, tail[1]!, sha));
    }
    // GET /api/v3/repos/{o}/{r}/commits
    if (req.method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
      const shaParam = req.query.get('sha');
      const tip = resolveRefTip(repo, shaParam);
      if (tip === null) return ok(200, []);
      const { page, link } = paginate(walkCommits(repo, tip), req, req.pathname);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      const items: unknown[] = [];
      for (const oid of page) {
        const view = commitJson(store, repo, oid);
        if (view) items.push(view);
      }
      return ok(200, items, headers);
    }
    // GET /api/v3/repos/{o}/{r}/git/refs/heads/{branch}
    if (req.method === 'GET' && tail.length === 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads') {
      const sha = repo.refs.get(`refs/heads/${tail[3]}`);
      if (!sha) return error(404, 'Not Found');
      return ok(200, {
        ref: `refs/heads/${tail[3]}`,
        node_id: '',
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${tail[3]}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
      });
    }
    // POST /api/v3/repos/{o}/{r}/git/refs
    if (req.method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      const ref = stringField(req.json, 'ref');
      const sha = stringField(req.json, 'sha');
      if (!ref || !ref.startsWith('refs/') || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
        return error(422, 'ref and sha are required');
      }
      if (repo.refs.has(ref)) return error(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return error(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      repo.updatedAt = store.nowIso;
      return ok(201, {
        ref,
        node_id: '',
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
      });
    }
    // Contents: /api/v3/repos/{o}/{r}/contents[/{path...}]
    if (tail.length >= 1 && tail[0] === 'contents') {
      return handleContents(store, repo, req, tail.slice(1).join('/'));
    }
    // Labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (req.method === 'GET') return ok(200, repo.labels.map(labelJson));
      if (req.method === 'POST') {
        const name = stringField(req.json, 'name');
        if (!name) return error(422, 'name is required');
        if (repo.labels.some((label) => label.name === name)) return error(422, 'Label already exists');
        const label = {
          id: store.nextId++,
          name,
          color: stringField(req.json, 'color') ?? 'ededed',
          description: stringField(req.json, 'description') ?? '',
        };
        repo.labels.push(label);
        return ok(201, labelJson(label));
      }
    }
    // Issues
    if (tail.length >= 1 && tail[0] === 'issues') {
      return handleIssues(store, repo, req, tail.slice(1));
    }
    // Pulls
    if (tail.length >= 1 && tail[0] === 'pulls') {
      return handlePulls(store, repo, req, tail.slice(1));
    }
  }

  return error(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function handleContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const refParam = req.query.get('ref');
  const tip = resolveRefTip(repo, refParam);
  const tree = tip ? treeOfCommit(repo, tip) : null;
  const segments = path === '' ? [] : path.split('/').filter((segment) => segment !== '');

  if (req.method === 'GET') {
    if (tree === null) return error(404, 'Not Found');
    if (segments.length === 0) {
      const entries = listDirEntries(repo, tree, []);
      if (entries === null) return error(404, 'Not Found');
      return ok(200, entries.map((entry) => dirEntryJson(store, repo, entry, '')));
    }
    const found = getPathEntry(repo, tree, segments);
    if (!found) return error(404, 'Not Found');
    if (found.type === 'tree') {
      const entries = listDirEntries(repo, tree, segments);
      if (entries === null) return error(404, 'Not Found');
      return ok(200, entries.map((entry) => dirEntryJson(store, repo, entry, path)));
    }
    const blob = repo.objects.get(found.oid);
    if (!blob) return error(404, 'Not Found');
    return ok(200, contentsFileJson(store, repo, path, found.oid, blob.data));
  }

  if (req.method === 'PUT') {
    const message = stringField(req.json, 'message');
    const content = stringField(req.json, 'content');
    if (!message || content === undefined) return error(422, 'message and content are required');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content, 'base64');
      if (bytes.length === 0 && content !== '') throw new Error('empty');
    } catch {
      return error(422, 'content is not valid base64');
    }
    const branch = stringField(req.json, 'branch') ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let branchTip = repo.refs.get(ref);
    if (branchTip === undefined) {
      // A new branch starts at the default branch tip (or empty for an unborn repository).
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) repo.refs.set(ref, defaultTip);
      branchTip = defaultTip;
    }
    const existingSha = blobShaAtRef(repo, ref, path);
    const givenSha = stringField(req.json, 'sha');
    if (existingSha !== null) {
      if (!givenSha) return error(422, 'sha is required to update a file');
      if (givenSha.toLowerCase() !== existingSha.toLowerCase()) return error(409, 'sha does not match the current file');
    }
    const blobOid = store.putObject(repo, 'blob', bytes);
    const { commitSha } = commitContentChange(store, repo, { branch, path, blobOid, message });
    const status = existingSha !== null ? 200 : 201;
    return ok(status, {
      content: {
        ...contentsFileJson(store, repo, path, blobOid, bytes),
        content: bytes.toString('base64'),
      },
      commit: { sha: commitSha, message },
    });
  }

  if (req.method === 'DELETE') {
    const givenSha = stringField(req.json, 'sha');
    const branch = stringField(req.json, 'branch') ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const existingSha = blobShaAtRef(repo, ref, path);
    if (existingSha === null) return error(404, 'Not Found');
    if (givenSha && givenSha.toLowerCase() !== existingSha.toLowerCase()) return error(409, 'sha does not match the current file');
    const message = stringField(req.json, 'message') ?? 'Delete file';
    const { commitSha } = commitContentChange(store, repo, { branch, path, blobOid: null, message });
    return ok(200, { content: null, commit: { sha: commitSha, message } });
  }

  return error(404, 'Not Found');
}

function dirEntryJson(
  store: Store,
  repo: Repo,
  entry: { mode: string; name: string; oid: string },
  parentPath: string,
): Record<string, unknown> {
  const path = parentPath === '' ? entry.name : `${parentPath}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const blob = isDir ? null : repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: blob ? blob.data.length : 0,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  };
}

// ---------------------------------------------------------------- issues

function handleIssues(store: Store, repo: Repo, req: RestRequest, tail: string[]): RestResponse {
  if (tail.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return listResponse(issues, req, req.pathname, (issue) => issueJson(store, repo, issue));
    }
    if (req.method === 'POST') {
      const title = stringField(req.json, 'title');
      if (!title) return error(422, 'title is required');
      const labels = isRecord(req.json) && Array.isArray(req.json.labels)
        ? (req.json.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [];
      const created = createIssue(store, repo, { title, body: stringField(req.json, 'body') ?? '', labels });
      if ('error' in created) {
        return error(422, `Label '${created.label}' does not exist`);
      }
      return ok(201, issueJson(store, repo, created));
    }
    return error(404, 'Not Found');
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number <= 0) return error(404, 'Not Found');
  const issue: Issue | undefined = findIssue(repo, number);
  if (!issue) return error(404, 'Not Found');

  if (tail.length === 1) {
    if (req.method === 'GET') return ok(200, issueJson(store, repo, issue));
    if (req.method === 'PATCH') {
      const state = stringField(req.json, 'state');
      if (state === 'open' || state === 'closed') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? store.nowIso : null;
      }
      const title = stringField(req.json, 'title');
      if (title !== undefined) issue.title = title;
      const body = stringField(req.json, 'body');
      if (body !== undefined) issue.body = body;
      issue.updatedAt = store.nowIso;
      return ok(200, issueJson(store, repo, issue));
    }
    return error(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (req.method === 'GET') {
      return listResponse(issue.comments, req, req.pathname, (comment) => commentJson(store, repo, issue, comment));
    }
    if (req.method === 'POST') {
      const body = stringField(req.json, 'body');
      if (!body) return error(422, 'body is required');
      const comment = {
        id: store.nextId++,
        body,
        user: store.viewer.login,
        createdAt: store.nowIso,
        updatedAt: store.nowIso,
      };
      issue.comments.push(comment);
      issue.updatedAt = store.nowIso;
      return ok(201, commentJson(store, repo, issue, comment));
    }
  }
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function handlePulls(store: Store, repo: Repo, req: RestRequest, tail: string[]): RestResponse {
  if (tail.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return listResponse(pulls, req, req.pathname, (pull) => pullJson(store, repo, pull));
    }
    if (req.method === 'POST') {
      const title = stringField(req.json, 'title');
      const head = stringField(req.json, 'head');
      const base = stringField(req.json, 'base');
      if (!title || !head || !base) return error(422, 'title, head and base are required');
      const created = createPull(store, repo, { title, body: stringField(req.json, 'body') ?? '', head, base });
      if ('error' in created) return error(422, created.error);
      return ok(201, pullJson(store, repo, created));
    }
    return error(404, 'Not Found');
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number <= 0) return error(404, 'Not Found');
  const pull = findPull(repo, number);
  if (!pull) return error(404, 'Not Found');

  if (tail.length === 1) {
    if (req.method === 'GET') return ok(200, pullJson(store, repo, pull));
    return error(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (req.method !== 'GET') return error(404, 'Not Found');
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
    if (!headSha || !baseSha) return ok(200, []);
    const files = pullFiles(store, repo, headSha, baseSha);
    return ok(200, files.map((file) => ({
      sha: file.newOid ?? file.oldOid ?? '',
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    })));
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (req.method !== 'PUT') return error(404, 'Not Found');
    const merged = squashMerge(store, repo, pull);
    if ('error' in merged) {
      if (merged.error === 'not-found') return error(404, 'Not Found');
      if (merged.error === 'closed') return error(405, 'Pull request is already merged or closed');
      return error(405, 'Merge conflict');
    }
    return ok(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return error(404, 'Not Found');
}
