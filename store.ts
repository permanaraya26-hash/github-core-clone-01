// store.ts — the in-memory store and every domain operation the surfaces share.
// Deterministic: all timestamps come from MAKEFUN_TRIAL_NOW (or a fixed default), never
// from the wall clock; ids come from counters, never from randomness.
//
// The viewer is the suite's fixed scenario owner. Verified 2026-11-14 by running the kit's
// own buildScenario() (seed 6a09e667f3bcc909): login adaiversen, id 1000.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

const DEFAULT_NOW_ISO = '2026-11-14T06:30:00.000Z';

/** The trial's "now": MAKEFUN_TRIAL_NOW when the env sets it, else the fixed default. */
export function trialNowIso(): string {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return DEFAULT_NOW_ISO;
}

export function trialNowEpoch(): number {
  return Math.floor(Date.parse(trialNowIso()) / 1000);
}

// ---------------------------------------------------------------- global ids

/** An opaque, stable Relay-style global id. Never the plain database id or number. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- types

export interface User {
  login: string;
  id: number;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  /** One shared counter for issues and pull requests, as GitHub numbers them. */
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- store

export class Store {
  readonly users = new Map<string, User>();
  readonly repos = new Map<string, Repo>();
  nextId = 1;
  requestCounter = 0;
  readonly nowIso: string;
  readonly nowEpoch: number;
  readonly viewer: User;

  constructor() {
    this.nowIso = trialNowIso();
    this.nowEpoch = trialNowEpoch();
    const viewer: User = { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
    this.viewer = viewer;
    this.users.set(VIEWER_LOGIN, viewer);
    this.users.set('quinnkeller', { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' });
    this.users.set('olgabauer', { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' });
    this.users.set('faint-meadow-org', { login: 'faint-meadow-org', id: 2000, name: 'faint meadow org', email: '', type: 'Organization' });
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  userOf(login: string): User {
    return this.users.get(login) ?? { login, id: 0, name: login, email: '', type: 'User' };
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    const exact = this.repos.get(this.repoKey(owner, name));
    if (exact) return exact;
    const lowerOwner = owner.toLowerCase();
    const lowerName = name.toLowerCase();
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === lowerOwner && repo.name.toLowerCase() === lowerName) return repo;
    }
    return undefined;
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string; defaultBranch?: string } = {}): Repo | { error: 'exists' } {
    if (this.getRepo(owner, name)) return { error: 'exists' };
    const repo: Repo = {
      id: this.nextId++,
      name,
      owner,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: options.defaultBranch ?? 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  /** The object lookup for one repository. */
  lookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refOf(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  headRefName(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRefName(repo));
  }
}

// ---------------------------------------------------------------- JSON views

export function userJson(store: Store, login: string): Record<string, unknown> {
  const user = store.userOf(login);
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('user', user.login),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store, repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('label', label.name),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(store, issue.user),
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((entry) => entry.name === name);
      return found ? labelJson(found) : { id: 0, node_id: globalId('label', name), name, color: 'ededed', default: false, description: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

export function commentJson(store: Store, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('comment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(store, comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

export function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const author = parseIdentity(parsed.author);
  const committer = parseIdentity(parsed.committer);
  return {
    sha: oid,
    node_id: globalId('commit', oid),
    commit: {
      author: { name: author.name, email: author.email, date: new Date(author.timestamp * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.timestamp * 1000).toISOString() },
      // GitHub's API returns the message without the trailing newline the
      // object stores.
      message: parsed.message.replace(/\n+$/, ''),
      tree: { sha: parsed.tree },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    author: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    committer: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    parents: parsed.parents.map((sha) => ({ sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` })),
  };
}

export function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!match) return { name: line, email: '', timestamp: 0 };
  return { name: match[1]!, email: match[2]!, timestamp: Number(match[3]) };
}

// ---------------------------------------------------------------- trees and contents

/** Replace (or delete, when blobOid is null) one path in a tree, returning the new root tree oid. */
export function setPathInTree(
  store: Store,
  repo: Repo,
  baseTreeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
  mode = '100644',
): string {
  if (segments.length === 0) throw new Error('setPathInTree needs at least one segment');
  const [head, ...rest] = segments as [string, ...string[]];
  const entries = new Map<string, TreeEntry>();
  if (baseTreeOid !== null) {
    const base = repo.objects.get(baseTreeOid);
    if (base && base.type === 'tree') {
      for (const entry of parseTree(base.data)) entries.set(entry.name, entry);
    }
  }
  if (rest.length === 0) {
    if (blobOid === null) entries.delete(head);
    else entries.set(head, { mode, name: head, oid: blobOid });
  } else {
    const child = entries.get(head);
    const childTree = child && child.mode === '40000' ? child.oid : null;
    const newChild = setPathInTree(store, repo, childTree, rest, blobOid, mode);
    entries.set(head, { mode: '40000', name: head, oid: newChild });
  }
  const built = buildTree([...entries.values()]);
  return store.putObject(repo, 'tree', built);
}

/** Walk a tree to a path: the entry (blob or tree) at the end, or null. */
export function getPathEntry(
  repo: Repo,
  treeOid: string | null,
  segments: readonly string[],
): { mode: string; oid: string; type: GitObjectType } | null {
  if (treeOid === null) return null;
  let currentOid: string | null = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    if (currentOid === null) return null;
    const object = repo.objects.get(currentOid);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) {
      const target = repo.objects.get(entry.oid);
      if (!target) return null;
      return { mode: entry.mode, oid: entry.oid, type: target.type };
    }
    currentOid = entry.oid;
  }
  return null;
}

/** The entries of the directory at `segments` (empty = root), or null when it is not a tree. */
export function listDirEntries(repo: Repo, treeOid: string | null, segments: readonly string[]): TreeEntry[] | null {
  if (treeOid === null) return null;
  if (segments.length === 0) {
    const root = repo.objects.get(treeOid);
    if (!root || root.type !== 'tree') return null;
    return parseTree(root.data);
  }
  const found = getPathEntry(repo, treeOid, segments);
  if (!found || found.type !== 'tree') return null;
  const object = repo.objects.get(found.oid);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/** Every path in a tree, flattened: path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string | null, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid === null) return out;
  const walk = (oid: string, pathPrefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = pathPrefix === '' ? entry.name : `${pathPrefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** The tree oid of a commit, or null. */
export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Commits reachable from `tip`, newest first (tip, then parents depth-first). */
export function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- diffs

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

function countLines(data: Buffer | null): string[] {
  if (data === null) return [];
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two blobs, by multiset difference of their lines. */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = countLines(oldData);
  const newLines = countLines(newData);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of counts.values()) deletions += remaining;
  return { additions, deletions };
}

/** The file changes between two trees (null = empty tree). */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry && !newEntry) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? null;
      const counts = lineDiff(oldData, null);
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: counts.deletions });
    } else if (!oldEntry && newEntry) {
      const newData = repo.objects.get(newEntry.oid)?.data ?? null;
      const counts = lineDiff(null, newData);
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: counts.additions, deletions: 0 });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? null;
      const newData = repo.objects.get(newEntry.oid)?.data ?? null;
      const counts = lineDiff(oldData, newData);
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}

// ---------------------------------------------------------------- issues

export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: readonly string[] },
): Issue | { error: 'bad-label'; label: string } {
  const labels: string[] = [];
  for (const name of input.labels ?? []) {
    if (!repo.labels.some((label) => label.name === name)) return { error: 'bad-label', label: name };
    labels.push(name);
  }
  const issue: Issue = {
    id: store.nextId++,
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    user: store.viewer.login,
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  repo.updatedAt = store.nowIso;
  return issue;
}

export function findIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

// ---------------------------------------------------------------- pull requests

export function pullFiles(store: Store, repo: Repo, headSha: string, baseSha: string): FileChange[] {
  const baseTree = treeOfCommit(repo, baseSha);
  const headTree = treeOfCommit(repo, headSha);
  if (baseTree === null || headTree === null) return [];
  const base = mergeBase(store.lookup(repo), headSha, baseSha);
  const baseTreeForDiff = base !== null ? treeOfCommit(repo, base) : baseTree;
  return diffTrees(repo, baseTreeForDiff, headTree);
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const files = pullFiles(store, repo, headSha, baseSha);
  return {
    id: pull.id,
    node_id: globalId('pr', `${repo.owner}/${repo.name}#${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(store, pull.user),
    labels: [],
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(store, repo.owner),
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(store, repo.owner),
      repo: repoJson(store, repo),
    },
    merged: pull.merged,
    mergeable: pullMergeable(store, repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    author_association: 'OWNER',
    draft: false,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: files.length,
  };
}

export function findPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

export function createPull(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${input.head}`);
  if (!headSha) return { error: `head ref refs/heads/${input.head} does not exist` };
  const baseSha = repo.refs.get(`refs/heads/${input.base}`);
  if (!baseSha) return { error: `base ref refs/heads/${input.base} does not exist` };
  const duplicate = repo.pulls.find(
    (pull) => pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base,
  );
  if (duplicate) return { error: 'a pull request already exists for this head and base' };
  const pull: Pull = {
    id: store.nextId++,
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    user: store.viewer.login,
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    closedAt: null,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.pulls.push(pull);
  repo.updatedAt = store.nowIso;
  return pull;
}

/** The three-way merge result for a pull request: a merged tree, or the conflicting paths. */
export function computeMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
): { ok: true; treeOid: string } | { ok: false; conflicts: string[] } {
  const lookup = store.lookup(repo);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(lookup, headSha, baseSha);
  const baseTree = base !== null ? treeOfCommit(repo, base) : null;
  const headTree = treeOfCommit(repo, headSha);
  const targetTree = treeOfCommit(repo, baseSha);
  if (headTree === null || targetTree === null) return { ok: false, conflicts: [] };
  const baseFlat = flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headTree);
  const targetFlat = flattenTree(repo, targetTree);
  const conflicts: string[] = [];
  let mergedTree = targetTree;
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...targetFlat.keys()]);
  for (const path of paths) {
    const baseEntry = baseFlat.get(path);
    const headEntry = headFlat.get(path);
    const targetEntry = targetFlat.get(path);
    const headChanged = (baseEntry?.oid ?? null) !== (headEntry?.oid ?? null);
    const targetChanged = (baseEntry?.oid ?? null) !== (targetEntry?.oid ?? null);
    if (!headChanged) continue;
    if (!targetChanged) {
      // Only the head changed: take the head's version.
      const segments = path.split('/');
      mergedTree = setPathInTree(store, repo, mergedTree, segments, headEntry ? headEntry.oid : null, headEntry?.mode ?? '100644');
    } else if ((headEntry?.oid ?? null) === (targetEntry?.oid ?? null)) {
      // Both changed to the same thing: no conflict.
      continue;
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, treeOid: mergedTree };
}

export function pullMergeable(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headSha || !baseSha) return 'UNKNOWN';
  return computeMerge(store, repo, pull).ok ? 'MERGEABLE' : 'CONFLICTING';
}

/** Squash-merge an open pull request onto its base branch. Returns the merge commit or an error. */
export function squashMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
): { sha: string } | { error: 'not-found' | 'closed' | 'conflict' } {
  if (pull.state !== 'open') return { error: 'closed' };
  const merged = computeMerge(store, repo, pull);
  if (!merged.ok) return { error: 'conflict' };
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseSha = repo.refs.get(baseRef);
  if (!baseSha) return { error: 'not-found' };
  const identity = `${store.viewer.name} <${store.viewer.email}>`;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
  const commitData = buildCommit({
    tree: merged.treeOid,
    parents: [baseSha],
    message,
    author: identity,
    committer: identity,
    timestamp: store.nowEpoch,
  });
  const sha = store.putObject(repo, 'commit', commitData);
  repo.refs.set(baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso;
  pull.mergeCommitSha = sha;
  pull.closedAt = store.nowIso;
  pull.updatedAt = store.nowIso;
  repo.updatedAt = store.nowIso;
  return { sha };
}

// ---------------------------------------------------------------- contents commits

/** Create a commit on `branch` that sets one path (or deletes it when blobOid is null). */
export function commitContentChange(
  store: Store,
  repo: Repo,
  options: { branch: string; path: string; blobOid: string | null; message: string },
): { commitSha: string; contentSha: string | null } {
  const ref = `refs/heads/${options.branch}`;
  const tip = repo.refs.get(ref);
  const baseTree = tip ? treeOfCommit(repo, tip) : null;
  const segments = options.path.split('/').filter((segment) => segment !== '');
  const newTree = setPathInTree(store, repo, baseTree, segments, options.blobOid);
  const identity = `${store.viewer.name} <${store.viewer.email}>`;
  const commitData = buildCommit({
    tree: newTree,
    parents: tip ? [tip] : [],
    message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
    author: identity,
    committer: identity,
    timestamp: store.nowEpoch,
  });
  const commitSha = store.putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  repo.updatedAt = store.nowIso;
  return { commitSha, contentSha: options.blobOid };
}

/** The blob sha of a path at a ref, or null. */
export function blobShaAtRef(repo: Repo, ref: string, path: string): string | null {
  const tip = repo.refs.get(ref);
  if (!tip) return null;
  const tree = treeOfCommit(repo, tip);
  if (tree === null) return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  const found = getPathEntry(repo, tree, segments);
  if (!found || found.type !== 'blob') return null;
  return found.oid;
}

export { parseTag, peelToCommit, isAncestor };
