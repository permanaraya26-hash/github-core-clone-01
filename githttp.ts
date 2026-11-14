// githttp.ts — git smart HTTP: info/refs advertisements, upload-pack v2 (ls-refs/fetch),
// receive-pack v0 (push). Node stdlib only.
//
// Wire notes (verified against sdk/conformance/git-client.ts):
// - v2 fetch responses are sections separated by delim (0001); there is NO trailing
//   response-end (0002) — the client throws on one. The packfile section needs >=1
//   sideband packet even when zero objects are sent (send the 32-byte empty pack).
// - receive-pack answers report-status pkt-lines inside band-1 sideband packets.
// - ls-refs ref-prefix filtering applies server-side, including the HEAD line.

import {
  collectReachable,
  decodePktLines,
  emptyPack,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  pktLines,
  readPack,
  sidebandPackets,
  splitPktLinesAndRest,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitPacket,
} from './gitobj.ts';
import { blobShaAtRef, type Repo, type Store } from './store.ts';

export interface GitRequestContext {
  method: string;
  /** Decoded path segments, e.g. ['adaiversen', 'repo.git', 'info', 'refs']. */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  authorized: boolean;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonResponse(status: number, body: unknown): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

/** Parse `/<owner>/<repo>.git/...` into owner/repo/rest, or null. */
function parseGitPath(segments: string[]): { owner: string; repo: string; rest: string[] } | null {
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return null;
  const repo = repoSegment.slice(0, -4);
  if (owner === '' || repo === '') return null;
  return { owner, repo, rest: segments.slice(2) };
}

function refLinesV0(repo: Repo, capabilities: string): Buffer {
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? ZERO_OID;
  const parts: Buffer[] = [];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peeledCommitOf(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** The commit an annotated tag ref peels to, or null (not a tag, or a lightweight tag). */
function peeledCommitOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  const peeled = peelToCommit((id) => repo.objects.get(id), target);
  return peeled;
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush,
    pktLine('version 2\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('object-format=sha1\n'),
    pktFlush,
  ]);
}

function v0UploadAdvertisement(repo: Repo): Buffer {
  const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not filter symref=HEAD:refs/heads/main';
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush,
    refLinesV0(repo, caps),
  ]);
}

function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const caps = 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main';
  return Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    pktFlush,
    refLinesV0(repo, caps),
  ]);
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    if (keep('HEAD')) {
      const attrs = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(pktLine(`${headOid} HEAD${attrs}\n`));
    }
    for (const [name, oid] of refs) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      if (args.peel) {
        const peeled = peeledCommitOf(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      lines.push(pktLine(`${line}\n`));
    }
  }
  lines.push(pktFlush);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch object selection

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

/**
 * The objects a fetch sends, and the shallow-info lines.
 *
 * Walk: BFS from the wanted commits, `depth` generations when given (1 = the wants only),
 * traversing parents — including held and already-shallow commits, so a deepen reaches
 * past the old boundary. The candidate set is every walked commit plus its full tree.
 * What the client already holds is the reachability of its haves, except that a
 * shallow boundary's parents are NOT held (that is what makes it shallow): the
 * held walk stops at shallow commits. The sent set is candidates minus held.
 * A commit is a shallow boundary when one of its parents is neither sent nor held.
 */
/**
 * The objects a fetch client already holds: the reachability of its haves, except
 * that a shallow boundary's parents are NOT held — the held walk stops at shallow
 * commits, because the client has the boundary commit but not its ancestors.
 */
function collectHeld(
  lookup: (oid: string) => GitObject | undefined,
  haves: Set<string>,
  shallow: Set<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallow.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

function selectFetchObjects(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const held = new Set<string>(args.haves.filter((oid) => isObjectId(oid)));
  const heldReachable = collectHeld(lookup, held, new Set(args.shallow));

  // Resolve wants to commits (a tag want peels to its commit; the tag itself is sent too).
  const extraObjects = new Set<string>();
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      extraObjects.add(want);
      const peeled = peelToCommit(lookup, want);
      if (peeled !== null) wantCommits.push(peeled);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    } else {
      extraObjects.add(want);
    }
  }

  // Depth-limited BFS over parents.
  const walked = new Map<string, number>();
  const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 1] as [string, number]);
  while (queue.length) {
    const [oid, generation] = queue.shift()!;
    if (walked.has(oid)) continue;
    walked.set(oid, generation);
    if (args.depth !== null && generation >= args.depth) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, generation + 1]);
  }

  // Candidate objects: walked commits + their full trees.
  const candidates = new Set<string>(extraObjects);
  for (const oid of walked.keys()) {
    candidates.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    try {
      for (const reachable of collectReachable([parseCommit(object.data).tree], lookup)) candidates.add(reachable);
    } catch {
      // A walked commit with an incomplete tree contributes what resolves.
    }
  }
  const toSend = [...candidates].filter((oid) => !heldReachable.has(oid));
  const sentCommits = new Set(toSend.filter((oid) => repo.objects.get(oid)?.type === 'commit'));
  const presentCommits = new Set<string>([...sentCommits, ...[...held].filter((oid) => repo.objects.get(oid)?.type === 'commit')]);

  // Shallow boundaries, only when the fetch asked for depth or sent boundaries.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null || args.shallow.length > 0) {
    for (const oid of presentCommits) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const cut = parents.length > 0 && parents.some((parent) => !presentCommits.has(parent));
      if (cut) shallow.push(oid);
    }
    for (const oid of args.shallow) {
      if (!shallow.includes(oid) && presentCommits.has(oid)) unshallow.push(oid);
    }
    shallow.sort();
    unshallow.sort();
  }

  const objects: GitObject[] = [];
  for (const oid of toSend) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Deterministic pack order: commits first (in walk order), then trees, then blobs.
  const order = (object: GitObject): number => (object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : 2);
  objects.sort((a, b) => order(a) - order(b));
  return { objects, shallow, unshallow };
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = selectFetchObjects(repo, args);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (args.haves.length > 0) {
    const known = args.haves.filter((oid) => repo.objects.has(oid));
    if (known.length === args.haves.length) {
      for (const oid of known) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim);
  // shallow-info
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim);
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  const pack = objects.length > 0 ? writePack(objects) : emptyPack();
  parts.push(sidebandPackets(1, pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = selectFetchObjects(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    const known = args.haves.filter((oid) => repo.objects.has(oid));
    if (known.length === args.haves.length) {
      for (const oid of known) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = objects.length > 0 ? writePack(objects) : emptyPack();
  parts.push(sidebandPackets(1, pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function reportStream(results: Array<{ ref: string; ok: boolean; reason: string }>, unpackOk: boolean, unpackDetail: string): Buffer {
  const lines: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer, sideband: boolean): GitResponse {
  const { packets, rest } = splitPktLinesAndRest(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let bad = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)\n?$/.exec(line);
    if (!match) {
      bad = true;
      break;
    }
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  const wantsSideband = sideband && capabilities.includes('side-band-64k');
  const answer = (report: Buffer): GitResponse => {
    if (wantsSideband) {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-result',
        body: Buffer.concat([sidebandPackets(1, report), pktFlush]),
      };
    }
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: report };
  };
  if (bad || commands.length === 0) {
    const report = reportStream(
      commands.map((command) => ({ ref: command.ref, ok: false, reason: 'bad command' })),
      false,
      'bad command list',
    );
    return answer(report);
  }

  // Unpack: store every object the pack carries, even when a ref update is refused.
  if (rest.length > 0) {
    try {
      const parsed = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      const report = reportStream(
        commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
        false,
        (err as Error).message,
      );
      return answer(report);
    }
  }

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'unable to read new object' });
      continue;
    }
    // The new tip's history must be complete in the store.
    try {
      collectReachable([command.newOid], lookup);
    } catch {
      results.push({ ref: command.ref, ok: false, reason: 'unable to read new object' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(lookup, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (results.some((result) => result.ok)) repo.updatedAt = store.nowIso;
  return answer(reportStream(results, true, 'ok'));
}

// ---------------------------------------------------------------- upload-pack POST

function handleUploadPack(store: Store, repo: Repo, body: Buffer): GitResponse {
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body);
  } catch {
    return jsonResponse(400, { message: 'malformed pkt-line stream' });
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      lines.push('\0DELIM');
      continue;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const first = lines[0] ?? '';
  const resultType = 'application/x-git-upload-pack-result';
  if (first === 'command=ls-refs\n') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    let pastDelim = false;
    for (const line of lines.slice(1)) {
      if (line === '\0DELIM') {
        pastDelim = true;
        continue;
      }
      if (!pastDelim) continue;
      const text = line.replace(/\n$/, '');
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: resultType, body: lsRefsResponse(repo, args) };
  }
  if (first === 'command=fetch\n') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
    let pastDelim = false;
    for (const line of lines.slice(1)) {
      if (line === '\0DELIM') {
        pastDelim = true;
        continue;
      }
      if (!pastDelim) continue;
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const depth = Number(text.slice(7).trim());
        if (Number.isInteger(depth) && depth > 0) args.depth = depth;
      } else if (text.startsWith('filter ')) args.filter = text.slice(7);
    }
    return { status: 200, contentType: resultType, body: fetchV2Response(repo, args) };
  }
  if (first.startsWith('want ')) {
    // Protocol v0 fetch: want lines, flush, have lines, done, flush.
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim().split(' ')[0]!);
      else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const depth = Number(text.slice(7).trim());
        if (Number.isInteger(depth) && depth > 0) args.depth = depth;
      }
    }
    return { status: 200, contentType: resultType, body: fetchV0Response(repo, args) };
  }
  return jsonResponse(400, { message: `unknown upload-pack command ${JSON.stringify(first.slice(0, 40))}` });
}

// ---------------------------------------------------------------- router

/** Handle a git smart-HTTP request. Returns null when the path is not a git path. */
export function handleGit(store: Store, ctx: GitRequestContext): GitResponse | null {
  const parsed = parseGitPath(ctx.segments);
  if (!parsed) return null;
  const { owner, repo: repoName, rest } = parsed;
  if (!ctx.authorized) return jsonResponse(401, { message: 'Requires authentication' });
  const repo = store.getRepo(owner, repoName);
  if (ctx.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = ctx.query.get('service') ?? '';
    if (!repo) return jsonResponse(404, { message: 'Not Found' });
    if (service === 'git-upload-pack') {
      const v2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: v2 ? v2Advertisement() : v0UploadAdvertisement(repo),
      };
    }
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-advertisement',
        body: v0ReceiveAdvertisement(repo),
      };
    }
    return jsonResponse(400, { message: `unknown service ${JSON.stringify(service)}` });
  }
  if (ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    if (!repo) return jsonResponse(404, { message: 'Not Found' });
    return handleUploadPack(store, repo, ctx.body);
  }
  if (ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    if (!repo) return jsonResponse(404, { message: 'Not Found' });
    return handleReceivePack(store, repo, ctx.body, true);
  }
  return jsonResponse(404, { message: 'Not Found' });
}

export { blobShaAtRef, hashObject };
