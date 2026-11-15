// git smart HTTP: upload-pack protocol v2 and receive-pack protocol v0, at
// /{owner}/{repo}.git. One pack writer, plain non-delta objects, sideband framing.
//
// Protocol notes the conformance suite pins down (checks-git.ts, git-client.ts):
// - v2 advertisement: "version 2" first, then capabilities `ls-refs=unborn`,
//   `fetch=shallow`, `object-format=sha1`, `agent=...`. Content-Type
//   application/x-git-upload-pack-advertisement.
// - v0 advertisement: "# service=git-upload-pack" + flush, then ref lines; the first
//   ref line carries capabilities after a NUL byte, including
//   `side-band-64k thin-pack ofs-delta shallow multi_ack` and
//   `symref=HEAD:refs/heads/main`. An empty repo advertises
//   `<zero-oid> capabilities^{}` + "\0" + caps. Peeled tags get `<oid> <ref>^{}` lines.
// - v2 fetch request: command=fetch, agent, object-format, delim, thin-pack,
//   no-progress, ofs-delta, optional filter, want/have/shallow lines, deepen N,
//   done, flush. Response sections in order: acknowledgments (NAK, or ACK lines +
//   ready), delim, shallow-info, delim, packfile, flush. The packfile section always
//   carries at least one sideband packet, even for an empty pack.
// - v0 fetch request: wants (+ shallow/deepen) up to a flush, then haves + done up to
//   a flush. Response: shallow/unshallow/NAK/ACK lines, then sideband band-1 packets
//   with the pack, then flush.
// - Fetch selection: delivered = reachable(wants) minus reachable(haves), with the
//   traversal of a have stopping at shallow boundaries. Depth D delivers commits
//   within distance < D of a want (their trees/blobs close fully); boundary commits
//   at distance D-1 emit `shallow`. Old shallow boundaries that are now fully
//   included emit `unshallow`.
// - Push (receive-pack v0): a command list always carries a pack, even when empty;
//   delete-only carries none. Each ref is applied only when it fast-forwards (or is
//   new, or is a delete); a non-fast-forward is refused per-ref with the reason
//   `non-fast-forward` while the rest of the push still applies. The report travels
//   in band-1 sideband packets as nested pkt-lines ("unpack ok", "ok <ref>",
//   "ng <ref> <reason>"), then a final flush pkt-line.
// - Malformed pkt-lines get a 400; the server never dies on them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync } from 'node:zlib';
import {
  collectReachable,
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export const GIT_AGENT = 'github-core-clone/1.0.0';

/** The ref lines a v0 advertisement lists, in git's order (HEAD first, then branches, then tags). */
function refLines(repo: Repo): Array<{ oid: string; ref: string; peeled?: string }> {
  const out: Array<{ oid: string; ref: string; peeled?: string }> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) out.push({ oid: headOid, ref: 'HEAD' });
  const names = [...repo.refs.keys()].sort((a, b) => {
    const rank = (ref: string): number => (ref.startsWith('refs/heads/') ? 0 : ref.startsWith('refs/tags/') ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const ref of names) {
    const oid = repo.refs.get(ref)!;
    const entry: { oid: string; ref: string; peeled?: string } = { oid, ref };
    if (ref.startsWith('refs/tags/')) {
      const peeled = peelToCommit(oid, repo.lookup);
      if (peeled && peeled !== oid) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

/** The v2 advertisement body for an upload-pack service. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2',
    'ls-refs=unborn',
    'fetch=shallow',
    'object-format=sha1',
    `agent=${GIT_AGENT}`,
    'flush',
  ]);
}

/** The v0 advertisement body for a service, with capabilities on the first ref line. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/${repo.defaultBranch} agent=${GIT_AGENT}`
      : `report-status report-status-v2 side-band-64k ofs-delta delete-refs agent=${GIT_AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((entry, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${entry.oid} ${entry.ref}${suffix}\n`));
      if (entry.peeled) parts.push(pktLine(`${entry.peeled} ${entry.ref}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Sideband: wrap a payload in band-1 pkt-lines, chunked so no pkt-line exceeds 65520 bytes. */
function sidebandPackets(payload: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  if (payload.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  } else {
    for (let offset = 0; offset < payload.length; offset += CHUNK) {
      const slice = payload.subarray(offset, Math.min(offset + CHUNK, payload.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  return Buffer.concat(parts);
}

/** The object set a fetch delivers, plus the shallow-info lines it must announce. */
function fetchSelection(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | undefined,
): { objects: GitObject[]; shallowInfo: string[] } {
  const shallowSet = new Set(shallow);
  // Reachable-from-haves, stopping at shallow boundaries (the client does not hold
  // a shallow boundary's parents, so they stay deliverable). The wants traversal
  // does NOT stop at old boundaries: deepening a shallow clone means delivering
  // exactly those parents.
  const haveReachable = new Set<string>();
  if (haves.length > 0) {
    const haveResult = collectReachable(haves, repo.lookup, { shallowStop: shallowSet });
    for (const oid of haveResult.objects) haveReachable.add(oid);
  }
  // Depth applies relative to the wants.
  const wantResult = collectReachable(wants, repo.lookup, {
    depth,
  });
  const shallowInfo: string[] = [];
  const delivered: GitObject[] = [];
  const newObjects = new Set<string>();
  for (const oid of wantResult.objects) {
    if (haveReachable.has(oid)) continue;
    newObjects.add(oid);
    const object = repo.lookup(oid);
    if (object) delivered.push(object);
  }
  // Boundary commits of a depth-limited fetch are the new shallow lines.
  for (const oid of wantResult.boundary) {
    if (!haveReachable.has(oid)) shallowInfo.push(`shallow ${oid}`);
  }
  // An old shallow boundary that is now fully included (the boundary itself and all
  // of its parents are present on the client after this fetch) is announced as
  // unshallow. Presence means "in the want set or already had".
  for (const oid of shallow) {
    const object = repo.lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const present = (p: string): boolean => wantResult.objects.has(p) || haveReachable.has(p);
    const included = wantResult.objects.has(oid) || haveReachable.has(oid);
    if (included && parents.every(present)) shallowInfo.push(`unshallow ${oid}`);
  }
  // Deterministic pack order: commits, then trees, then tags, then blobs, each by oid.
  const rank = (object: GitObject): number => (object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'tag' ? 2 : 3);
  delivered.sort((a, b) => rank(a) - rank(b) || hashObject(a.type, a.data).localeCompare(hashObject(b.type, b.data)));
  return { objects: delivered, shallowInfo };
}

/** Parse a v2 fetch request body into its arguments. */
interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

function parseV2Fetch(packets: ReturnType<typeof decodePktLines>): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim().split(/\s+/)[0]!);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim().split(/\s+/)[0]!);
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim().split(/\s+/)[0]!);
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) req.deepenSince = parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11).trim().split(/\s+/)[0]!);
  }
  return req;
}

/** Parse a v0 fetch request body: wants (+ shallow/deepen) to the first flush, then haves + done. */
function parseV0Fetch(packets: ReturnType<typeof decodePktLines>): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (section === 0) {
      // The first v0 want line carries the request's features after the oid.
      if (line.startsWith('want ')) req.wants.push(line.slice(5).trim().split(/\s+/)[0]!);
      else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim().split(/\s+/)[0]!);
      else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
      else if (line.startsWith('deepen-since ')) req.deepenSince = parseInt(line.slice(13).trim(), 10);
      else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11).trim().split(/\s+/)[0]!);
    } else if (line.startsWith('have ')) {
      req.haves.push(line.slice(5).trim().split(/\s+/)[0]!);
    }
  }
  return req;
}

/** The v2 fetch response for one request. */
function v2FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallowInfo } = fetchSelection(repo, req.wants, req.haves, req.shallow, req.depth);
  const ackLines: string[] = [];
  if (req.haves.length === 0) {
    ackLines.push('acknowledgments\n', 'NAK\n');
  } else {
    // Report the haves the server has in common; a client with a have the server
    // lacks still gets NAK, and one whose have is known gets ACK + ready.
    const known = req.haves.filter((have) => repo.lookup(have) !== undefined);
    ackLines.push('acknowledgments\n');
    if (known.length === 0) ackLines.push('NAK\n');
    else {
      for (const oid of known) ackLines.push(`ACK ${oid}\n`);
      ackLines.push('ready\n');
    }
  }
  const parts: Buffer[] = [encodePktLines(ackLines), pktDelim()];
  if (shallowInfo.length > 0) {
    parts.push(encodePktLines(['shallow-info\n', ...shallowInfo.map((line) => `${line}\n`)]));
  }
  parts.push(pktDelim());
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(writePack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch response for one request. */
function v0FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallowInfo } = fetchSelection(repo, req.wants, req.haves, req.shallow, req.depth);
  const lines: string[] = [];
  for (const line of shallowInfo) lines.push(`${line}\n`);
  if (req.haves.length === 0) {
    lines.push('NAK\n');
  } else {
    const known = req.haves.filter((have) => repo.lookup(have) !== undefined);
    if (known.length === 0) lines.push('NAK\n');
    else for (const oid of known) lines.push(`ACK ${oid}\n`);
  }
  const parts: Buffer[] = [encodePktLines(lines)];
  parts.push(sidebandPackets(writePack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Parse a receive-pack command list: one command per pkt-line, then a flush, then a
 * pack. Only the command section is pkt-lined — the pack is binary, so the walk stops
 * at the first flush instead of decoding the whole body as pkt-lines.
 */
function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line');
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('malformed pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) throw new Error('malformed pkt-line');
    const line = body.subarray(offset + 4, offset + len).toString('utf8').trimEnd();
    const parts = line.split(' ');
    if (parts.length >= 3) {
      const oldOid = parts[0]!;
      const newOid = parts[1]!;
      let ref = parts.slice(2).join(' ');
      const nul = ref.indexOf('\0');
      if (nul >= 0) ref = ref.slice(0, nul);
      if (isObjectId(oldOid) && isObjectId(newOid) && ref.startsWith('refs/')) {
        commands.push({ oldOid, newOid, ref });
      }
    }
    offset += len;
  }
  return { commands, pack: body.subarray(offset) };
}

/** Apply one receive-pack push; returns the per-ref report lines (without "unpack ok"). */
function applyPush(repo: Repo, commands: readonly PushCommand[]): string[] {
  const results: string[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    const isDelete = command.newOid === ZERO_OID;
    if (isDelete) {
      if (current !== undefined) {
        repo.refs.delete(command.ref);
        results.push(`ok ${command.ref}`);
      } else {
        // Deleting a ref that does not exist is still an ok no-op for the client.
        results.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      // A new ref: allowed only when the old oid is zero (a create).
      if (command.oldOid === ZERO_OID) {
        repo.refs.set(command.ref, command.newOid);
        results.push(`ok ${command.ref}`);
      } else {
        results.push(`ng ${command.ref} non-fast-forward`);
      }
      continue;
    }
    if (command.oldOid === current) {
      // Fast-forward: the new tip must descend from the old one, or be the same.
      if (command.newOid === current || isAncestor(current, command.newOid, repo.lookup)) {
        repo.refs.set(command.ref, command.newOid);
        results.push(`ok ${command.ref}`);
      } else {
        results.push(`ng ${command.ref} non-fast-forward`);
      }
      continue;
    }
    // The client's old oid does not match the ref: not a fast-forward.
    results.push(`ng ${command.ref} non-fast-forward`);
  }
  return results;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBinary(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.length) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) });
  res.end(text);
}

/**
 * Handle one git smart-HTTP request. Returns true when the path matched a git route
 * (even when it answered 404 for an unknown repo), false otherwise.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]!);
  const name = decodeURIComponent(match[2]!);
  const route = match[3]!;
  const repo = store.getRepo(owner, name);

  if (route === 'info/refs') {
    const service = url.searchParams.get('service');
    if (req.method !== 'GET' || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
      sendJson(res, 400, { message: 'service parameter is required' });
      return true;
    }
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (wantsV2) {
        sendBinary(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
      } else {
        sendBinary(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
      }
    } else {
      sendBinary(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    }
    return true;
  }

  if (route === 'git-upload-pack') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const body = await readBody(req);
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      sendJson(res, 400, { message: 'malformed pkt-line' });
      return true;
    }
    const first = packets.length > 0 && packets[0]?.kind === 'data' ? packets[0].payload.toString('utf8') : '';
    if (first.startsWith('command=ls-refs')) {
      sendBinary(res, 200, 'application/x-git-upload-pack-result', v2LsRefsResponse(repo, packets));
    } else if (first.startsWith('command=fetch')) {
      sendBinary(res, 200, 'application/x-git-upload-pack-result', v2FetchResponse(repo, parseV2Fetch(packets)));
    } else {
      sendBinary(res, 200, 'application/x-git-upload-pack-result', v0FetchResponse(repo, parseV0Fetch(packets)));
    }
    return true;
  }

  if (route === 'git-receive-pack') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const body = await readBody(req);
    let parsed: { commands: PushCommand[]; pack: Buffer };
    try {
      parsed = parsePush(body);
    } catch {
      sendJson(res, 400, { message: 'malformed pkt-line' });
      return true;
    }
    // The pack arrives first: store its objects even when a ref update is refused.
    if (parsed.pack.length > 0) {
      try {
        const { objects } = readPack(parsed.pack, (oid) => repo.lookup(oid));
        for (const object of objects) repo.putObject(object.type, object.data);
      } catch {
        sendJson(res, 400, { message: 'malformed pack' });
        return true;
      }
    }
    const results = applyPush(repo, parsed.commands);
    // The report parser joins the band-1 payloads and splits on newlines, so every
    // report line carries its own trailing newline.
    const reportLines = ['unpack ok\n', ...results.map((line) => `${line}\n`)];
    const report = Buffer.concat([sidebandPackets(encodePktLines(reportLines)), pktFlush()]);
    // The report is a sideband stream; the client's parser reads band-1 packets.
    sendBinary(res, 200, 'application/x-git-receive-pack-result', report);
    return true;
  }

  return false;
}

/** The v2 ls-refs response: one line per ref, HEAD first with its symref target. */
function v2LsRefsResponse(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11).trim());
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const refs = refLines(repo);
  if (refs.length === 0) {
    if (unborn) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    for (const entry of refs) {
      if (!keep(entry.ref)) continue;
      let line = `${entry.oid} ${entry.ref}`;
      if (entry.ref === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (entry.peeled) line += ` peeled:${entry.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  return Buffer.concat([encodePktLines(lines), pktFlush()]);
}

/** The pack a `git fetch` of one ref would send, used by the REST/GraphQL setup paths. */
export function packForRefs(repo: Repo, oids: readonly string[]): Buffer {
  const { objects } = collectReachable(oids, repo.lookup);
  const list: GitObject[] = [];
  for (const oid of objects) {
    const object = repo.lookup(oid);
    if (object) list.push(object);
  }
  return writePack(list);
}

export { deflateSync };
