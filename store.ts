// The forge's store: every repository, its git objects and refs, and its GitHub resources
// (issues, pull requests, labels, comments). One process, in memory, no outside service.
//
// Ownership: the trial presents one bearer token (MAKEFUN_SHOP_TOKEN). The token names the
// scenario's viewer, whose login is a constant of the kit's fixed scenario seed (wire.ts
// SCENARIO_SEED 0x6a09e667f3bcc909n, buildScenario()): adaiversen, id 1000. A repository
// belongs to that login; the same name under any other owner is a 404, never a 403.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
export const DEFAULT_BRANCH = 'main';
/** Fixed commit timestamp, so the commits this server writes are byte-stable across runs. */
export const FIXED_TS = 1700000000;
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** sha1("<type> <len>\0" + data), the git object id. */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const ts = fields.timestamp ?? FIXED_TS;
  const who = `${fields.author ?? VIEWER_IDENTITY} ${ts} +0000`;
  const committer = `${fields.committer ?? VIEWER_IDENTITY} ${ts} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: { object: string; type: ObjType; tag: string; message: string; tagger?: string; timestamp?: number }): Buffer {
  const ts = fields.timestamp ?? FIXED_TS;
  const tagger = `${fields.tagger ?? VIEWER_IDENTITY} ${ts} +0000`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object's bytes. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error('malformed tag object');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  return { object, type: type as ObjType, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** One pkt-line framing `payload` (a payload without a trailing newline is still framed as-is). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  const out = Buffer.alloc(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  body.copy(out, 4);
  return out;
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode lines ('flush'/'delim' for the control packets). */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines; throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`malformed pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('malformed pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a pack v2 of plain (non-delta) objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0]!.write('PACK', 0, 4, 'ascii');
  parts[0]!.writeUInt32BE(2, 4);
  parts[0]!.writeUInt32BE(objects.length, 8);
  for (const object of objects) {
    const code = TYPE_CODES[object.type];
    const size = object.data.length;
    // varint: low 4 bits of size in the first byte, then 7 bits per continuation byte.
    const header: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    header.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate exactly one zlib stream starting at `buf`'s start, expecting `expectedSize` bytes out.
 * Node's inflateSync with {info: true} reports the input bytes the stream consumed
 * (engine.bytesWritten), so one call gives both the data and the exact consumed length;
 * trailing bytes after the stream are ignored.
 */
export function inflateExact(buf: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  if (buf.length === 0) throw new Error('truncated pack object');
  const result = inflateSync(buf, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (result.buffer.length !== expectedSize) throw new Error('pack object does not inflate to its declared size');
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0 || consumed > buf.length) throw new Error('inflate consumed no bytes');
  return { data: result.buffer, consumed };
}

/** Git's ofs-delta base offset: each byte adds 7 bits, with a +1 per continuation byte. */
function readOfsDeltaBase(buf: Buffer, offset: number): { value: number; next: number } {
  const first = buf[offset];
  if (first === undefined) throw new Error('truncated ofs-delta base offset');
  let value = first & 0x7f;
  let pos = offset + 1;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    const next = buf[pos];
    if (next === undefined) throw new Error('truncated ofs-delta base offset');
    pos += 1;
    value = (value + 1) * 128 + (next & 0x7f);
    byte = next;
  }
  return { value, next: pos };
}

/** Apply a git delta (copy/insert ops) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readDeltaVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readDeltaVarint();
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(parts);
}

export interface ReadPackResult {
  objects: GitObject[];
  deltaCount: number;
}

/**
 * Read a pack v2. Deltas resolve against earlier objects in the same pack first, then against
 * `baseLookup` (the receiving repository's store, for thin packs).
 */
export function readPack(pack: Buffer, baseLookup?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack file');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const objects: GitObject[] = [];
  const byOid = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    const first = pack[offset]!;
    if (first === undefined) throw new Error('truncated pack object header');
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    if ((first & 0x80) !== 0) {
      for (;;) {
        const byte = pack[offset];
        if (byte === undefined) throw new Error('truncated pack object header');
        offset += 1;
        size |= (byte & 0x7f) << shift;
        shift += 7;
        if ((byte & 0x80) === 0) break;
      }
    }
    let type: ObjType;
    let data: Buffer;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (typeCode === 6) {
        // OFS_DELTA: the base is an earlier object in this pack, by backwards offset.
        const { value, next } = readOfsDeltaBase(pack, offset);
        offset = next;
        const baseOffset = start - value;
        base = byOffset.get(baseOffset);
        if (!base) throw new Error(`delta base at offset ${baseOffset} is missing`);
      } else {
        // REF_DELTA: the base is named by its object id (in this pack, or the store).
        const baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
        base = byOid.get(baseOid) ?? baseLookup?.(baseOid);
        if (!base) throw new Error(`delta base ${baseOid} is missing`);
      }
      const inflated = inflateExact(pack.subarray(offset), size);
      offset += inflated.consumed;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
    } else {
      type = PACK_TYPES[typeCode] ?? (() => { throw new Error(`unknown pack object type ${typeCode}`); })();
      const inflated = inflateExact(pack.subarray(offset), size);
      offset += inflated.consumed;
      data = inflated.data;
    }
    const object: GitObject = { type, data };
    objects.push(object);
    byOid.set(hashObject(type, data), object);
    byOffset.set(start, object);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export interface ReachOptions {
  /** Stop descending past these commits (they are included, their parents are not). */
  shallowStop?: ReadonlySet<string>;
  /** Maximum commit distance from a root (0 = the roots only). Undefined = unbounded. */
  depth?: number;
}

/**
 * Every object reachable from `roots`, following commits (parents + tree), trees (entries),
 * tags (targets) and blobs (nothing). With `depth`, only commits within that distance are
 * followed (their trees and blobs still close fully); with `shallowStop`, traversal stops at
 * those commits. Returns the object set and, for depth runs, the boundary commits whose parents
 * were cut off.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: ReachOptions = {},
): { objects: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const seenCommit = new Set<string>();
  // Commit walk (BFS by distance when depth is set).
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const root of roots) {
    if (!isObjectId(root)) continue;
    const object = lookup(root);
    if (!object) continue;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      objects.add(root);
      queue.push({ oid: tag.object, distance: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: root, distance: 0 });
    } else {
      objects.add(root);
    }
  }
  const commitQueue: Array<{ oid: string; distance: number }> = [...queue];
  while (commitQueue.length > 0) {
    const { oid, distance } = commitQueue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      objects.add(oid);
      commitQueue.push({ oid: tag.object, distance });
      continue;
    }
    if (object.type !== 'commit') {
      objects.add(oid);
      continue;
    }
    objects.add(oid);
    const commit = parseCommit(object.data);
    // A commit at distance D-1 has its parents cut off by the depth limit: it is a
    // new shallow boundary (when it has parents). A commit in shallowStop has its
    // parents cut off too, but it is an old boundary, not a new one.
    const stopped = options.shallowStop?.has(oid) === true;
    const atDepthLimit = options.depth !== undefined && distance >= options.depth - 1;
    if (stopped || atDepthLimit) {
      if (atDepthLimit && commit.parents.length > 0) boundary.add(oid);
    } else {
      for (const parent of commit.parents) commitQueue.push({ oid: parent, distance: distance + 1 });
    }
    // The commit's tree closes fully regardless of depth.
    closeTree(commit.tree, lookup, objects);
  }
  return { objects, boundary };
}

/** Add a tree and everything under it to `objects`. */
export function closeTree(treeOid: string, lookup: (oid: string) => GitObject | undefined, objects: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (objects.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    objects.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/** Flatten a tree to path -> {oid, mode}. */
export function flattenTree(treeOid: string, lookup: (oid: string) => GitObject | undefined): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The merge-base of two commits: the first common ancestor found walking both histories. */
export function mergeBase(a: string, b: string, lookup: (oid: string) => GitObject | undefined): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    ancestorsA.add(oid);
    queueA.push(...parseCommit(object.data).parents);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    queueB.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Whether `ancestor` is reachable from `descendant` (inclusive). */
export function isAncestor(ancestor: string, descendant: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Resolve a commit-ish to a commit oid: a tag peels to its target commit. */
export function peelToCommit(oid: string, lookup: (oid: string) => GitObject | undefined): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextNumber = 1;
  nextCommentId = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdSeq = createdSeq;
    const now = new Date().toISOString();
    this.createdAt = now;
    this.updatedAt = now;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** The commit a ref (branch name, full ref, or 40-hex oid) resolves to, or null. */
  resolveRef(ref: string): string | null {
    if (isObjectId(ref)) {
      const commit = peelToCommit(ref, this.lookup);
      return commit;
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const oid = this.refs.get(full);
    if (!oid) return null;
    return peelToCommit(oid, this.lookup);
  }

  /** Commits reachable from a tip, newest first (DFS following parents in order). */
  commitHistory(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.lookup(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
    }
    return out;
  }

  /** Build (and store) the tree for a path -> blob map, returning the root tree oid. */
  treeFromPaths(paths: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of paths) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The flat file map at a commit (or an empty map for an unborn tip). */
  filesAt(commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (commitOid === null) return new Map();
    const object = this.lookup(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return flattenTree(parseCommit(object.data).tree, this.lookup);
  }

  /** Commit a new tree on a branch (creating the branch when it does not exist yet). */
  commitTree(branch: string, treeOid: string, message: string, parents: readonly string[]): string {
    const commitOid = this.putObject('commit', buildCommit({ tree: treeOid, parents, message }));
    this.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private nextCreatedSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId++, owner, name, description, isPrivate, this.nextCreatedSeq++);
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
  }

  globalId(): number {
    return this.nextGlobalId++;
  }
}

/** Relay-style global ids: base64 of a typed key; opaque and stable. */
export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'User' | 'Comment', key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
