// graphql.ts — a small GraphQL parser + executor for the 16 documents
// gh/github-mcp-server sends (see sdk/conformance/checks-graphql.ts), plus __type
// introspection, Relay node(id:), and operation batching. No dependencies.
//
// The executor validates field names against the schema it models: an unknown field
// is an HTTP 200 with an errors array naming the field (never a 400).

import {
  createIssue,
  createPull,
  findIssue,
  findPull,
  globalId,
  parseGlobalId,
  pullFiles,
  pullMergeable,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- schema

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  // The node() entry point returns any of these; their shared field is id.
  Node: ['id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'isPrivate', 'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'additions',
    'deletions', 'changedFiles',
  ],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

/** The object type a field resolves to (for nested selection validation). */
const FIELD_TYPE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Issue: { author: 'User', labels: 'IssueConnection', comments: 'IssueConnection' },
  PullRequest: { files: 'PullRequestFileConnection', author: 'User' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', edges: 'PullRequestFileEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestEdge: { node: 'PullRequest' },
  PullRequestFileEdge: { node: 'PullRequestFile' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  name: string | null;
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: Value | null }>;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const escaped = input[i + 1]!;
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === 'u' && i + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += escaped;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ParseError(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new ParseError(`expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new ParseError('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selection });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        const selection = this.parseSelectionSet();
        operations.push({ kind, name, variables, selection });
        continue;
      }
      if (token.kind === 'punct' && token.value === '{') {
        const selection = this.parseSelectionSet();
        operations.push({ kind: 'query', name: null, variables: [], selection });
        continue;
      }
      throw new ParseError(`unexpected token ${JSON.stringify(token.value)} at the document level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: Value | null }> {
    const variables: Array<{ name: string; defaultValue: Value | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: Value | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return variables;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', name: null, typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'fragment', name: this.next().value, typeCondition: null, selection: [] };
      }
      return { kind: 'fragment', name: null, typeCondition: null, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    // Directives (@skip/@include/...) are parsed and ignored.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: Value }> {
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new ParseError(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------- values

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- runtime values

type RuntimeValue =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; nodes: Array<{ __typename: 'Issue'; repo: Repo; issue: Issue }>; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestConnection'; nodes: Array<{ __typename: 'PullRequest'; repo: Repo; pull: Pull }>; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestFileConnection'; nodes: Array<{ __typename: 'PullRequestFile'; path: string; additions: number; deletions: number; changeType: string }>; pageInfo: PageInfoValue }
  | { __typename: 'IssueEdge'; node: RuntimeValue; cursor: string }
  | { __typename: 'PullRequestEdge'; node: RuntimeValue; cursor: string }
  | { __typename: 'PullRequestFileEdge'; node: RuntimeValue; cursor: string }
  | { __typename: 'IssueCommentEdge'; node: RuntimeValue; cursor: string }
  | { __typename: 'IssueComment'; id: string; body: string; repo: Repo; issue: Issue }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; issue: RuntimeValue | null }
  | { __typename: 'CloseIssuePayload'; issue: RuntimeValue | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: RuntimeValue | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: RuntimeValue | null }
  | { __typename: 'AddCommentPayload'; commentEdge: RuntimeValue | null };

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number(text.slice('cursor:'.length));
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

/** The sortable number of a connection node (issues and pull requests), or 0. */
function nodeNumber(node: RuntimeValue): number {
  if (node.__typename === 'Issue') return node.issue.number;
  if (node.__typename === 'PullRequest') return node.pull.number;
  return 0;
}

function paginateConnection<T extends { number: number }>(
  items: readonly T[],
  first: number | undefined,
  after: string | null | undefined,
): { nodes: T[]; pageInfo: PageInfoValue } {
  let start = 0;
  const afterNumber = numberFromCursor(after);
  if (afterNumber !== null) {
    const index = items.findIndex((item) => item.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const limit = typeof first === 'number' && first >= 0 ? first : items.length;
  const nodes = items.slice(start, start + limit);
  const hasNextPage = start + nodes.length < items.length;
  return {
    nodes,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorFor(nodes[0]!.number) : null,
      endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]!.number) : null,
    },
  };
}

// ---------------------------------------------------------------- executor

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  document: Document;
  errors: Array<{ message: string }>;
}

function typeOf(value: RuntimeValue | null): string | null {
  return value === null ? null : value.__typename;
}

function resolveField(exec: Executor, parentType: string, parent: RuntimeValue | null, field: FieldNode): unknown {
  const store = exec.store;
  const args = argMap(field, exec.variables);
  const name = field.name;

  if (parentType === 'Query') {
    if (name === 'viewer') {
      return { __typename: 'User', login: store.viewer.login } as RuntimeValue;
    }
    if (name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? ({ __typename: 'Repository', repo } as RuntimeValue) : null;
    }
    if (name === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'repo') {
        const [owner, repoName] = parsed.key.split('/', 2);
        const repo = store.getRepo(owner ?? '', repoName ?? '');
        return repo ? ({ __typename: 'Repository', repo } as RuntimeValue) : null;
      }
      if (parsed.kind === 'issue' || parsed.kind === 'pr') {
        const match = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
        if (!match) return null;
        const repo = store.getRepo(match[1]!, match[2]!);
        if (!repo) return null;
        const number = Number(match[3]);
        if (parsed.kind === 'issue') {
          const issue = findIssue(repo, number);
          return issue ? ({ __typename: 'Issue', repo, issue } as RuntimeValue) : null;
        }
        const pull = findPull(repo, number);
        return pull ? ({ __typename: 'PullRequest', repo, pull } as RuntimeValue) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (!FIELDS[typeName] && !ENUM_VALUES[typeName]) return null;
      return { __typename: '__Type', name: typeName } as RuntimeValue;
    }
  }

  if (parentType === 'Mutation') {
    return resolveMutation(exec, name, args);
  }

  if (parent === null) return null;

  if (parentType === 'Repository' && parent.__typename === 'Repository') {
    const repo = parent.repo;
    switch (name) {
      case 'id':
        return globalId('repo', `${repo.owner}/${repo.name}`);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: repo.owner } as RuntimeValue;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? ({ __typename: 'Ref', name: repo.defaultBranch } as RuntimeValue) : null;
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
      case 'isPrivate':
        return repo.private;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}`;
      case 'issue': {
        const issue = findIssue(repo, Number(args.number));
        return issue ? ({ __typename: 'Issue', repo, issue } as RuntimeValue) : null;
      }
      case 'issues': {
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? undefined;
        let issues = [...repo.issues];
        if (states !== null) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const direction = orderBy?.direction === 'ASC' ? 1 : -1;
        const field = orderBy?.field;
        if (field === 'CREATED_AT' || field === undefined) {
          issues.sort((a, b) => (a.number - b.number) * direction);
        }
        const page = paginateConnection(issues, typeof args.first === 'number' ? args.first : undefined, (args.after as string | null) ?? null);
        return {
          __typename: 'IssueConnection',
          nodes: page.nodes.map((issue) => ({ __typename: 'Issue', repo, issue }) as RuntimeValue),
          pageInfo: page.pageInfo,
        } as RuntimeValue;
      }
      case 'pullRequests': {
        const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        const pulls = repo.pulls.filter((pull) => wanted.has(pull.state));
        const page = paginateConnection(pulls, typeof args.first === 'number' ? args.first : undefined, (args.after as string | null) ?? null);
        return {
          __typename: 'PullRequestConnection',
          nodes: page.nodes.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as RuntimeValue),
          pageInfo: page.pageInfo,
        } as RuntimeValue;
      }
      case 'pullRequest': {
        const pull = findPull(repo, Number(args.number));
        return pull ? ({ __typename: 'PullRequest', repo, pull } as RuntimeValue) : null;
      }
    }
  }

  if (parentType === 'Issue' && parent.__typename === 'Issue') {
    const issue = parent.issue;
    const repo = parent.repo;
    switch (name) {
      case 'id':
        return globalId('issue', `${repo.owner}/${repo.name}#${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'author':
        return { __typename: 'User', login: issue.user } as RuntimeValue;
    }
  }

  if (parentType === 'PullRequest' && parent.__typename === 'PullRequest') {
    const pull = parent.pull;
    const repo = parent.repo;
    switch (name) {
      case 'id':
        return globalId('pr', `${repo.owner}/${repo.name}#${pull.number}`);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return pullMergeable(store, repo, pull);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
      case 'baseRefOid':
        return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'author':
        return { __typename: 'User', login: pull.user } as RuntimeValue;
      case 'files': {
        const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
        const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
        const files = headSha !== '' && baseSha !== '' ? pullFiles(store, repo, headSha, baseSha) : [];
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((file) => ({
          __typename: 'PullRequestFile',
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }) as RuntimeValue);
        return {
          __typename: 'PullRequestFileConnection',
          nodes,
          pageInfo: { hasNextPage: files.length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        } as RuntimeValue;
      }
      case 'additions':
      case 'deletions':
      case 'changedFiles': {
        const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
        const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
        const files = headSha !== '' && baseSha !== '' ? pullFiles(store, repo, headSha, baseSha) : [];
        if (name === 'additions') return files.reduce((sum, file) => sum + file.additions, 0);
        if (name === 'deletions') return files.reduce((sum, file) => sum + file.deletions, 0);
        return files.length;
      }
    }
  }

  if (parentType === 'Node' && parent !== null) {
    // node(id:) narrows to the runtime type; id is that object's global id.
    if (name === 'id') {
      if (parent.__typename === 'Repository') return globalId('repo', `${parent.repo.owner}/${parent.repo.name}`);
      if (parent.__typename === 'Issue') return globalId('issue', `${parent.repo.owner}/${parent.repo.name}#${parent.issue.number}`);
      if (parent.__typename === 'PullRequest') return globalId('pr', `${parent.repo.owner}/${parent.repo.name}#${parent.pull.number}`);
    }
  }

  if (parentType === 'PullRequestFile' && parent.__typename === 'PullRequestFile') {
    switch (name) {
      case 'path':
        return parent.path;
      case 'additions':
        return parent.additions;
      case 'deletions':
        return parent.deletions;
      case 'changeType':
        return parent.changeType;
    }
  }

  if (parentType === 'User' && parent.__typename === 'User') {
    const user = store.userOf(parent.login);
    switch (name) {
      case 'id':
        return globalId('user', parent.login);
      case 'login':
        return parent.login;
      case 'name':
        return user.name;
      case 'email':
        return user.email;
    }
  }

  if (parentType === 'Ref' && parent.__typename === 'Ref') {
    if (name === 'name') return parent.name;
  }

  if ((parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestFileConnection') && parent.__typename.endsWith('Connection')) {
    switch (name) {
      case 'nodes':
        return parent.nodes;
      case 'edges':
        return parent.nodes.map((node) => ({
          __typename: parent.__typename.replace('Connection', 'Edge'),
          node,
          cursor: cursorFor(nodeNumber(node)),
        }) as RuntimeValue);
      case 'pageInfo':
        return { __typename: 'PageInfo', ...parent.pageInfo } as RuntimeValue;
      case 'totalCount':
        return parent.nodes.length;
    }
  }

  if (parentType.endsWith('Edge') && (parent as { node?: RuntimeValue; cursor?: string }).node !== undefined) {
    const edge = parent as { node: RuntimeValue; cursor: string };
    if (name === 'node') return edge.node;
    if (name === 'cursor') return edge.cursor;
  }

  if (parentType === 'PageInfo' && parent.__typename === 'PageInfo') {
    switch (name) {
      case 'hasNextPage':
        return parent.hasNextPage;
      case 'hasPreviousPage':
        return parent.hasPreviousPage;
      case 'startCursor':
        return parent.startCursor;
      case 'endCursor':
        return parent.endCursor;
    }
  }

  if (parentType === '__Type' && parent.__typename === '__Type') {
    switch (name) {
      case 'name':
        return parent.name;
      case 'kind':
        return ENUM_VALUES[parent.name] ? 'ENUM' : 'OBJECT';
      case 'fields': {
        const fields = FIELDS[parent.name] ?? [];
        return fields.map((fieldName) => ({ __typename: '__Field', name: fieldName }) as RuntimeValue);
      }
      case 'enumValues': {
        const values = ENUM_VALUES[parent.name] ?? [];
        return values.map((value) => ({ __typename: '__EnumValue', name: value }) as RuntimeValue);
      }
    }
  }

  if (parentType === '__Field' && parent.__typename === '__Field') {
    if (name === 'name') return parent.name;
  }

  if (parentType === '__EnumValue' && parent.__typename === '__EnumValue') {
    if (name === 'name') return parent.name;
  }

  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    if (name === 'issue') return (parent as { issue: RuntimeValue | null }).issue;
  }
  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return (parent as { pullRequest: RuntimeValue | null }).pullRequest;
  }
  if (parentType === 'AddCommentPayload') {
    if (name === 'commentEdge') return (parent as { commentEdge: RuntimeValue | null }).commentEdge;
  }
  if (parentType === 'IssueCommentEdge') {
    if (name === 'node') return (parent as { node: RuntimeValue }).node;
    if (name === 'cursor') return (parent as { cursor: string }).cursor;
  }
  if (parentType === 'IssueComment' && parent.__typename === 'IssueComment') {
    if (name === 'id') return parent.id;
    if (name === 'body') return parent.body;
    if (name === 'author') return { __typename: 'User', login: store.viewer.login } as RuntimeValue;
  }

  throw new GraphQLError(`Cannot query field "${name}" on type "${parentType}".`);
}

function resolveMutation(exec: Executor, name: string, args: Record<string, unknown>): RuntimeValue {
  const store = exec.store;
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  if (name === 'createIssue') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    if (!parsed || parsed.kind !== 'repo') throw new GraphQLError('createIssue: unknown repositoryId');
    const [owner, repoName] = parsed.key.split('/', 2);
    const repo = store.getRepo(owner ?? '', repoName ?? '');
    if (!repo) throw new GraphQLError('createIssue: repository not found');
    const created = createIssue(store, repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
    if ('error' in created) throw new GraphQLError(`createIssue: ${created.error}`);
    return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue: created } as RuntimeValue } as RuntimeValue;
  }
  if (name === 'closeIssue') {
    const parsed = parseGlobalId(String(input.issueId ?? ''));
    if (!parsed || parsed.kind !== 'issue') throw new GraphQLError('closeIssue: unknown issueId');
    const match = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
    if (!match) throw new GraphQLError('closeIssue: unknown issueId');
    const repo = store.getRepo(match[1]!, match[2]!);
    const issue = repo ? findIssue(repo, Number(match[3])) : undefined;
    if (!repo || !issue) throw new GraphQLError('closeIssue: issue not found');
    issue.state = 'closed';
    issue.closedAt = store.nowIso;
    issue.updatedAt = store.nowIso;
    return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } as RuntimeValue } as RuntimeValue;
  }
  if (name === 'createPullRequest') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    if (!parsed || parsed.kind !== 'repo') throw new GraphQLError('createPullRequest: unknown repositoryId');
    const [owner, repoName] = parsed.key.split('/', 2);
    const repo = store.getRepo(owner ?? '', repoName ?? '');
    if (!repo) throw new GraphQLError('createPullRequest: repository not found');
    const created = createPull(store, repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    if ('error' in created) throw new GraphQLError(`createPullRequest: ${created.error}`);
    return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull: created } as RuntimeValue } as RuntimeValue;
  }
  if (name === 'mergePullRequest') {
    const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
    if (!parsed || parsed.kind !== 'pr') throw new GraphQLError('mergePullRequest: unknown pullRequestId');
    const match = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
    if (!match) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
    const repo = store.getRepo(match[1]!, match[2]!);
    const pull = repo ? findPull(repo, Number(match[3])) : undefined;
    if (!repo || !pull) throw new GraphQLError('mergePullRequest: pull request not found');
    const merged = squashMerge(store, repo, pull);
    if ('error' in merged) throw new GraphQLError(`mergePullRequest: ${merged.error}`);
    return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } as RuntimeValue } as RuntimeValue;
  }
  if (name === 'addComment') {
    const parsed = parseGlobalId(String(input.subjectId ?? ''));
    if (!parsed || parsed.kind !== 'issue') throw new GraphQLError('addComment: unknown subjectId');
    const match = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
    if (!match) throw new GraphQLError('addComment: unknown subjectId');
    const repo = store.getRepo(match[1]!, match[2]!);
    const issue = repo ? findIssue(repo, Number(match[3])) : undefined;
    if (!repo || !issue) throw new GraphQLError('addComment: issue not found');
    const comment = {
      id: store.nextId++,
      body: String(input.body ?? ''),
      user: store.viewer.login,
      createdAt: store.nowIso,
      updatedAt: store.nowIso,
    };
    issue.comments.push(comment);
    issue.updatedAt = store.nowIso;
    const node = {
      __typename: 'IssueComment',
      id: globalId('comment', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
      body: comment.body,
      repo,
      issue,
    } as RuntimeValue;
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(issue.number) } as RuntimeValue,
    } as RuntimeValue;
  }
  throw new GraphQLError(`Unknown mutation "${name}".`);
}

/** Execute one selection set against a parent value of a known type. */
function executeSelection(
  exec: Executor,
  parentType: string,
  parent: RuntimeValue | null,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      let fragmentSelections: SelectionNode[] | null = null;
      let fragmentType = parentType;
      if (selection.name !== null) {
        const found = exec.document.fragments.get(selection.name);
        if (found) {
          if (found.typeCondition === null || found.typeCondition === typeOf(parent) || found.typeCondition === parentType) {
            fragmentSelections = found.selection;
            if (found.typeCondition !== null && found.typeCondition === typeOf(parent)) fragmentType = found.typeCondition;
          }
        }
      } else if (selection.typeCondition === null || selection.typeCondition === parentType) {
        fragmentSelections = selection.selection;
      } else if (selection.typeCondition === typeOf(parent)) {
        // The fragment narrows the value to its runtime type: its selections
        // validate against that type, not the static parent type.
        fragmentSelections = selection.selection;
        fragmentType = selection.typeCondition;
      }
      if (fragmentSelections !== null) {
        Object.assign(out, executeSelection(exec, fragmentType, parent, fragmentSelections));
      }
      continue;
    }
    const field = selection;
    const knownFields = FIELDS[parentType] ?? [];
    if (!knownFields.includes(field.name)) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${parentType}".`);
    }
    const responseKey = field.alias ?? field.name;
    let value: unknown;
    try {
      value = resolveField(exec, parentType, parent, field);
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      throw new GraphQLError((err as Error).message);
    }
    if (field.selection !== null) {
      const childType = FIELD_TYPE[parentType]?.[field.name];
      if (childType === undefined) {
        throw new GraphQLError(`Field "${field.name}" of type "${parentType}" must not have a selection set.`);
      }
      if (value === null) {
        out[responseKey] = null;
      } else if (Array.isArray(value)) {
        out[responseKey] = value.map((entry) => {
          if (entry === null || typeof entry !== 'object' || !('__typename' in entry)) return entry;
          return executeSelection(exec, childType, entry as RuntimeValue, field.selection!);
        });
      } else if (typeof value === 'object' && value !== null && '__typename' in value) {
        out[responseKey] = executeSelection(exec, childType, value as RuntimeValue, field.selection);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value;
    }
  }
  return out;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one {query, variables, operationName} document. Never throws. */
export function executeGraphQL(
  store: Store,
  body: { query?: unknown; variables?: unknown; operationName?: unknown },
): GraphQLResult {
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return { data: null, errors: [{ message: 'A GraphQL query string is required.' }] };
  }
  let document: Document;
  try {
    document = new Parser(body.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const variables = (body.variables as Record<string, unknown> | null) ?? {};
  let operation: Operation | undefined;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    operation = document.operations.find((entry) => entry.name === body.operationName);
    if (!operation) {
      return { data: null, errors: [{ message: `Unknown operation named "${body.operationName}".` }] };
    }
  } else {
    operation = document.operations[0];
  }
  if (!operation) return { data: null, errors: [{ message: 'The document holds no operation.' }] };
  const resolvedVariables: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (!(variable.name in resolvedVariables) && variable.defaultValue !== null) {
      resolvedVariables[variable.name] = resolveValue(variable.defaultValue, resolvedVariables);
    }
  }
  const exec: Executor = { store, variables: resolvedVariables, document, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeSelection(exec, rootType, null, operation.selection);
    return exec.errors.length > 0 ? { data, errors: exec.errors } : { data };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
}

/** Execute a request body that may hold one document or an array of documents (batching). */
export function executeGraphQLBody(store: Store, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeGraphQL(store, (entry as Record<string, unknown>) ?? {}));
  }
  return executeGraphQL(store, (body as Record<string, unknown>) ?? {});
}
