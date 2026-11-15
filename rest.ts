// REST v3 (the GitHub API surface the trial exercises): repos, issues, pull requests,
// contents, labels, branches, commits, refs, and the protocol surface itself.
//
// Contract notes from checks-rest.ts and rest-client.ts:
// - GET /api/v3/ -> 200 {current_user_url, rate_limit_url} + header
//   x-oauth-scopes: repo, read:org. GET /api/v3/meta -> 200 {installed_version}.
// - Every reply is application/json (never HTML), carries a non-empty
//   X-GitHub-Request-Id, and error bodies carry a string `message`. Unknown route ->
//   404 {message}; malformed JSON body -> 400 {message}.
// - Auth: the only accepted bearer is MAKEFUN_SHOP_TOKEN (exact match). Missing or
//   wrong token -> 401 {message}. The token names the scenario viewer, adaiversen
//   (id 1000); a repo under any other owner is 404, never 403.
// - Issues and pull requests share one number space per repo, starting at 1.
// - Contents: PUT returns the content sha = the blob sha; GET returns the same sha,
//   the byte size, and base64 content. An update needs body.sha == current blob sha
//   or it is 409. DELETE returns 200 {commit:{sha}} and the file is 404 afterwards.
//   A directory GET returns an array of {type, name, path, sha}.
// - PUT /contents with a `branch` that does not exist yet creates it (from the
//   default tip, or unborn when the repo has no commits).
// - GET /commits?sha=<branch> lists that branch's commits, newest first; without
//   sha it lists only the default branch's commits.
// - GET /user/repos?per_page=10 paginates with a Link header (`<url>; rel="next"`);
//   pages hold at most per_page items, no duplicates, every repo present.
// - Pulls: duplicate open PR for the same head+base -> 422. Merge is squash by
//   default: 200 {merged:true, sha, message}; the PR becomes closed with merged_at
//   and merge_commit_sha; the merge commit appears on the base branch and its tree
//   carries the head's changed paths. A conflicting second merge -> 405.
// - Pull files: merge-base vs head; a new file is status 'added' with additions >= 1.
// - Labels: unknown label on issue creation -> 422.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTree,
  buildTag,
  flattenTree,
  globalId,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  nowIso,
  parseCommit,
  parseTree,
  peelToCommit,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  /** The exact bearer token the trial sets (MAKEFUN_SHOP_TOKEN). */
  token: string;
  /** The entry's absolute base URL (http://host:port), for absolute Link headers. */
  baseUrl: string;
}

export function requestId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
}

/** The base64 content GitHub returns for a file: no line wrapping, whitespace stripped on read. */
export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.fullName),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : repo.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
  };
}

function labelJson(repo: Repo, label: { name: string; color: string }): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + label.name.length,
    node_id: globalId('Repository', `${repo.fullName}:label:${label.name}`),
    name: label.name,
    color: label.color,
    description: '',
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.fullName}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, repo.labels.get(name) ?? { name, color: '000000' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.resolveRef(pull.head);
  const baseSha = repo.resolveRef(pull.base);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.fullName}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('Comment', `${repo.fullName}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
  };
}

interface HandlerResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Handler = (params: Record<string, string>, query: URLSearchParams, body: unknown, ctx: RestContext) => HandlerResult;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/\{([^}]+)\}/g, (_m, key) => {
      keys.push(key as string);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, pattern, keys, handler });
}

function notFound(message = 'Not Found'): HandlerResult {
  return { status: 404, body: { message } };
}

function repoOr404(ctx: RestContext, owner: string, name: string): Repo | HandlerResult {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  return repo;
}

function parseBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Line counts for a changed file: multiset diff of the two texts' lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The diff of two trees, as the pulls/{n}/files endpoint reports it. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): DiffFile[] {
  const baseFiles = flattenTree(baseTree, repo.lookup);
  const headFiles = flattenTree(headTree, repo.lookup);
  const out: DiffFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (!base && head) {
      const text = repo.lookup(head.oid)?.data.toString('utf8') ?? '';
      const lines = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (base && !head) {
      const text = repo.lookup(base.oid)?.data.toString('utf8') ?? '';
      const lines = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (base && head && base.oid !== head.oid) {
      const oldText = repo.lookup(base.oid)?.data.toString('utf8') ?? '';
      const newText = repo.lookup(head.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Three-way merge of head into base: the merged tree oid, or null on conflict. */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): { tree: string; conflicts: string[] } | null {
  const baseCommit = repo.lookup(baseTip);
  const headCommit = repo.lookup(headTip);
  if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return null;
  const mergeBaseOid = mergeBase(baseTip, headTip, repo.lookup);
  if (mergeBaseOid === null) return null;
  const baseCommitView = parseCommit(baseCommit.data);
  const headCommitView = parseCommit(headCommit.data);
  const mergeBaseCommit = repo.lookup(mergeBaseOid);
  if (!mergeBaseCommit || mergeBaseCommit.type !== 'commit') return null;
  const ancestorTree = parseCommit(mergeBaseCommit.data).tree;
  const ancestorFiles = flattenTree(ancestorTree, repo.lookup);
  const baseFiles = flattenTree(baseCommitView.tree, repo.lookup);
  const headFiles = flattenTree(headCommitView.tree, repo.lookup);
  const result = new Map(baseFiles);
  const conflicts: string[] = [];
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const head = headFiles.get(path);
    const base = baseFiles.get(path);
    const same = (a: { oid: string } | undefined, b: { oid: string } | undefined): boolean =>
      (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid);
    if (same(base, ancestor)) {
      // The base side did not change this path: take the head side.
      if (head === undefined) result.delete(path);
      else result.set(path, head);
    } else if (same(head, base)) {
      // Both sides made the same change: keep it.
    } else if (same(head, ancestor)) {
      // Only the base side changed: keep the base side.
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { tree: '', conflicts };
  return { tree: repo.treeFromPaths(result), conflicts };
}

/** Create or update a file on a branch, returning the new commit oid. */
export function writeFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  deleteFile = false,
): { commit: string; blobSha: string | null } {
  const tip = repo.resolveRef(branch);
  const files = repo.filesAt(tip);
  let blobSha: string | null = null;
  if (deleteFile) {
    files.delete(path);
  } else {
    blobSha = repo.putObject('blob', content);
    files.set(path, { oid: blobSha, mode: '100644' });
  }
  const treeOid = repo.treeFromPaths(files);
  const parents = tip === null ? [] : [tip];
  const commitOid = repo.putObject('commit', buildCommit({ tree: treeOid, parents, message }));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { commit: commitOid, blobSha };
}

// ---------------------------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------------------------

route('GET', '/api/v3', (_p, _q, _b, _ctx) => ({
  status: 200,
  body: {
    current_user_url: '/api/v3/user',
    current_user_authorizations_html_url: '/api/v3/authorizations',
    authorizations_url: '/api/v3/authorizations',
    code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
    commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
    emails_url: '/api/v3/user/emails',
    emojis_url: '/api/v3/emojis',
    events_url: '/api/v3/events',
    feeds_url: '/api/v3/feeds',
    followers_url: '/api/v3/user/followers',
    following_url: '/api/v3/user/following{/target}',
    gists_url: '/api/v3/gists{/gist_id}',
    hub_url: '/api/v3/hub',
    issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
    issues_url: '/api/v3/issues',
    keys_url: '/api/v3/user/keys',
    label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
    notifications_url: '/api/v3/notifications',
    organization_url: '/api/v3/orgs/{org}',
    organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
    organization_teams_url: '/api/v3/orgs/{org}/teams',
    public_gists_url: '/api/v3/gists/public',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
    current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
    starred_url: '/api/v3/user/starred{/owner}{/repo}',
    starred_gists_url: '/api/v3/gists/starred',
    topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
    user_url: '/api/v3/users/{user}',
    user_organizations_url: '/api/v3/user/orgs',
    user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
    user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
  },
  headers: { 'x-oauth-scopes': 'repo, read:org' },
}));

route('GET', '/api/v3/meta', () => ({
  status: 200,
  body: { verifiable_password_authentication: true, installed_version: '1.0.0', github_enterprise_version: '3.0.0' },
}));

route('GET', '/api/v3/rate_limit', () => ({
  status: 200,
  body: { resources: { core: { limit: 5000, remaining: 5000, reset: 1700000000, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 1700000000, used: 0 } },
}));

route('GET', '/api/v3/user', () => ({
  status: 200,
  body: {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', VIEWER_LOGIN),
    name: VIEWER_NAME,
    type: 'User',
    site_admin: false,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    url: `/api/v3/users/${VIEWER_LOGIN}`,
  },
}));

route('POST', '/api/v3/user/repos', (_p, _q, body, ctx) => {
  const input = asObject(body);
  const name = asString(input.name);
  if (!name) return { status: 422, body: { message: 'name is required' } };
  if (ctx.store.getRepo(VIEWER_LOGIN, name)) return { status: 422, body: { message: 'Repository already exists' } };
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, asString(input.description) ?? '', input.private === true);
  return { status: 201, body: repoJson(repo) };
});

route('GET', '/api/v3/user/repos', (_p, query, _b, ctx) => {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const all = ctx.store.reposOf(VIEWER_LOGIN);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    // The Link header must be an absolute same-origin URL; the client refuses to
    // follow a relative one.
    const next = `${ctx.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    headers.Link = `<${next}>; rel="next"`;
  }
  return { status: 200, body: items.map(repoJson), headers };
});

route('GET', '/api/v3/repos/{owner}/{repo}', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  return { status: 200, body: repoJson(repo) };
});

route('PATCH', '/api/v3/repos/{owner}/{repo}', (params, _q, body, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const input = asObject(body);
  if (asString(input.description) !== undefined) repo.description = asString(input.description)!;
  if (typeof input.private === 'boolean') repo.isPrivate = input.private;
  if (asString(input.default_branch) !== undefined) repo.defaultBranch = asString(input.default_branch)!;
  repo.updatedAt = nowIso();
  return { status: 200, body: repoJson(repo) };
});

route('DELETE', '/api/v3/repos/{owner}/{repo}', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  ctx.store.deleteRepo(params.owner!, params.repo!);
  return { status: 204, body: null };
});

route('GET', '/api/v3/repos/{owner}/{repo}/branches', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .sort()
    .map((ref) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: repo.refs.get(ref) },
      protected: false,
    }));
  return { status: 200, body: branches };
});

route('GET', '/api/v3/repos/{owner}/{repo}/commits', (params, query, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const sha = query.get('sha');
  const tip = sha ? repo.resolveRef(sha) : repo.resolveRef(repo.defaultBranch);
  if (tip === null) return { status: 200, body: [] };
  const history = repo.commitHistory(tip);
  const items = history.map((oid) => {
    const commit = parseCommit(repo.lookup(oid)!.data);
    return {
      sha: oid,
      commit: {
        message: commit.message,
        author: { name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, date: '2023-11-14T22:13:20Z' },
        committer: { name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, date: '2023-11-14T22:13:20Z' },
        tree: { sha: commit.tree },
      },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID },
      committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    };
  });
  return { status: 200, body: items };
});

route('GET', '/api/v3/repos/{owner}/{repo}/git/refs', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const refs = [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ref, oid]) => ({
    ref,
    node_id: globalId('Repository', `${repo.fullName}:${ref}`),
    url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}`,
    object: { sha: oid, type: repo.lookup(oid)?.type ?? 'commit' },
  }));
  return { status: 200, body: refs };
});

route('POST', '/api/v3/repos/{owner}/{repo}/git/refs', (params, _q, body, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const input = asObject(body);
  const ref = asString(input.ref);
  const sha = asString(input.sha);
  if (!ref || !sha || !ref.startsWith('refs/')) return { status: 422, body: { message: 'ref and sha are required' } };
  if (repo.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
  if (!repo.lookup(sha)) return { status: 422, body: { message: 'Object does not exist' } };
  repo.refs.set(ref, sha);
  return { status: 201, body: { ref, node_id: globalId('Repository', `${repo.fullName}:${ref}`), url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.slice(5)}`, object: { sha, type: repo.lookup(sha)?.type ?? 'commit' } } };
});

route('POST', '/api/v3/repos/{owner}/{repo}/labels', (params, _q, body, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const input = asObject(body);
  const name = asString(input.name);
  if (!name) return { status: 422, body: { message: 'name is required' } };
  const color = asString(input.color) ?? '000000';
  if (repo.labels.has(name)) return { status: 422, body: { message: 'Label already exists' } };
  repo.labels.set(name, { name, color });
  return { status: 201, body: labelJson(repo, { name, color }) };
});

route('GET', '/api/v3/repos/{owner}/{repo}/labels', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(repo, label)) };
});

route('POST', '/api/v3/repos/{owner}/{repo}/issues', (params, _q, body, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const input = asObject(body);
  const title = asString(input.title);
  if (!title) return { status: 422, body: { message: 'title is required' } };
  const labels = Array.isArray(input.labels) ? (input.labels as unknown[]).map((label) => (typeof label === 'string' ? label : asString((label as Record<string, unknown>).name) ?? '')).filter(Boolean) : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return { status: 422, body: { message: `Label does not exist: ${label}` } };
  }
  const number = repo.nextNumber++;
  const issue: Issue = {
    id: ctx.store.globalId(),
    number,
    title,
    body: asString(input.body) ?? '',
    state: 'open',
    labels,
    comments: [],
    createdSeq: number,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.issues.push(issue);
  return { status: 201, body: issueJson(repo, issue) };
});

route('GET', '/api/v3/repos/{owner}/{repo}/issues', (params, query, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  if (sort === 'created') {
    items = [...items].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  return { status: 200, body: items.map((issue) => issueJson(repo, issue)) };
});

route('GET', '/api/v3/repos/{owner}/{repo}/issues/{number}', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const issue = repo.issues.find((item) => item.number === parseInt(params.number!, 10));
  if (!issue) return notFound('Not Found');
  return { status: 200, body: issueJson(repo, issue) };
});

route('PATCH', '/api/v3/repos/{owner}/{repo}/issues/{number}', (params, _q, body, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const issue = repo.issues.find((item) => item.number === parseInt(params.number!, 10));
  if (!issue) return notFound('Not Found');
  const input = asObject(body);
  if (asString(input.title) !== undefined) issue.title = asString(input.title)!;
  if (asString(input.body) !== undefined) issue.body = asString(input.body)!;
  if (asString(input.state) === 'closed' || asString(input.state) === 'open') issue.state = asString(input.state) as 'open' | 'closed';
  if (Array.isArray(input.labels)) {
    const labels = (input.labels as unknown[]).map((label) => (typeof label === 'string' ? label : asString((label as Record<string, unknown>).name) ?? '')).filter(Boolean);
    for (const label of labels) {
      if (!repo.labels.has(label)) return { status: 422, body: { message: `Label does not exist: ${label}` } };
    }
    issue.labels = labels;
  }
  issue.updatedAt = nowIso();
  return { status: 200, body: issueJson(repo, issue) };
});

route('POST', '/api/v3/repos/{owner}/{repo}/issues/{number}/comments', (params, _q, body, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const issue = repo.issues.find((item) => item.number === parseInt(params.number!, 10));
  if (!issue) return notFound('Not Found');
  const input = asObject(body);
  const text = asString(input.body);
  if (!text) return { status: 422, body: { message: 'body is required' } };
  const comment = { id: repo.nextCommentId++, body: text, createdAt: nowIso(), updatedAt: nowIso() };
  issue.comments.push(comment);
  return { status: 201, body: commentJson(repo, issue, comment) };
});

route('GET', '/api/v3/repos/{owner}/{repo}/issues/{number}/comments', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const issue = repo.issues.find((item) => item.number === parseInt(params.number!, 10));
  if (!issue) return notFound('Not Found');
  return { status: 200, body: issue.comments.map((comment) => commentJson(repo, issue, comment)) };
});

route('POST', '/api/v3/repos/{owner}/{repo}/pulls', (params, _q, body, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const input = asObject(body);
  const head = asString(input.head);
  const base = asString(input.base);
  const title = asString(input.title);
  if (!head || !base || !title) return { status: 422, body: { message: 'head, base and title are required' } };
  if (!repo.refs.has(`refs/heads/${head}`)) return { status: 422, body: { message: 'head branch does not exist' } };
  if (!repo.refs.has(`refs/heads/${base}`)) return { status: 422, body: { message: 'base branch does not exist' } };
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
  if (duplicate) return { status: 422, body: { message: 'A pull request already exists for these branches' } };
  const number = repo.nextNumber++;
  const pull: Pull = {
    id: ctx.store.globalId(),
    number,
    title,
    body: asString(input.body) ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head,
    base,
    createdSeq: number,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.pulls.push(pull);
  return { status: 201, body: pullJson(repo, pull) };
});

route('GET', '/api/v3/repos/{owner}/{repo}/pulls', (params, query, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const state = query.get('state') ?? 'open';
  const items = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  return { status: 200, body: items.map((pull) => pullJson(repo, pull)) };
});

route('GET', '/api/v3/repos/{owner}/{repo}/pulls/{number}', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const pull = repo.pulls.find((item) => item.number === parseInt(params.number!, 10));
  if (!pull) return notFound('Not Found');
  return { status: 200, body: pullJson(repo, pull) };
});

route('GET', '/api/v3/repos/{owner}/{repo}/pulls/{number}/files', (params, _q, _b, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const pull = repo.pulls.find((item) => item.number === parseInt(params.number!, 10));
  if (!pull) return notFound('Not Found');
  const headTip = repo.resolveRef(pull.head);
  const baseTip = repo.resolveRef(pull.base);
  if (headTip === null || baseTip === null) return { status: 200, body: [] };
  const mergeBaseOid = mergeBase(headTip, baseTip, repo.lookup);
  if (mergeBaseOid === null) return { status: 200, body: [] };
  const baseCommit = repo.lookup(mergeBaseOid);
  const headCommit = repo.lookup(headTip);
  if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return { status: 200, body: [] };
  const files = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
  return { status: 200, body: files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes, sha: '', raw_url: '', blob_url: '', patch: '' })) };
});

route('PUT', '/api/v3/repos/{owner}/{repo}/pulls/{number}/merge', (params, _q, body, ctx) => {
  const repo = repoOr404(ctx, params.owner!, params.repo!);
  if ('status' in repo) return repo;
  const pull = repo.pulls.find((item) => item.number === parseInt(params.number!, 10));
  if (!pull) return notFound('Not Found');
  if (pull.state !== 'open') return { status: 405, body: { message: 'Pull request is not open' } };
  const headTip = repo.resolveRef(pull.head);
  const baseTip = repo.resolveRef(pull.base);
  if (headTip === null || baseTip === null) return { status: 405, body: { message: 'Cannot merge: missing branch tip' } };
  const merged = threeWayMerge(repo, baseTip, headTip);
  if (merged === null || merged.conflicts.length > 0) {
    return { status: 405, body: { message: 'Merge conflict' } };
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
  const commitOid = repo.putObject('commit', buildCommit({ tree: merged.tree, parents: [baseTip], message }));
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = nowIso();
  void body;
  return { status: 200, body: { sha: commitOid, merged: true, message: 'Pull Request successfully merged' } };
});

// Contents: the {path} segment may itself contain slashes, so these handlers are matched
// by prefix in dispatch() rather than by the exact-path route table below.

export function handleContents(
  method: string,
  owner: string,
  name: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  ctx: RestContext,
): HandlerResult {
  const repo = repoOr404(ctx, owner, name);
  if ('status' in repo) return repo;
  const ref = query.get('ref') ?? repo.defaultBranch;
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  if (method === 'GET') {
    const tip = repo.resolveRef(branch);
    if (tip === null) return notFound('Not Found');
    const files = repo.filesAt(tip);
    // A directory listing: every entry directly under `path`.
    if (path === '' || !files.has(path)) {
      const prefix = path === '' ? '' : `${path}/`;
      const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
      for (const [filePath, entry] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const segment = rest.split('/')[0]!;
        const full = prefix + segment;
        if (rest.includes('/')) {
          if (!entries.has(full)) entries.set(full, { type: 'dir', name: segment, path: full, sha: '' });
        } else {
          entries.set(full, { type: 'file', name: segment, path: full, sha: entry.oid });
        }
      }
      if (path !== '' && entries.size === 0) return notFound('Not Found');
      return {
        status: 200,
        body: [...entries.values()].map((entry) => ({
          type: entry.type,
          size: entry.type === 'dir' ? 0 : (repo.lookup(entry.sha)?.data.length ?? 0),
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          url: `/api/v3/repos/${repo.fullName}/contents/${entry.path}`,
          html_url: `https://github.com/${repo.fullName}/blob/${branch}/${entry.path}`,
          git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.sha}`,
          download_url: null,
          _links: { self: `/api/v3/repos/${repo.fullName}/contents/${entry.path}`, git: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.sha}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${entry.path}` },
        })),
      };
    }
    const entry = files.get(path)!;
    const object = repo.lookup(entry.oid);
    if (!object) return notFound('Not Found');
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: path.split('/').pop(),
        path,
        content: b64encode(object.data),
        sha: entry.oid,
        url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
        html_url: `https://github.com/${repo.fullName}/blob/${branch}/${path}`,
        git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
        download_url: null,
        _links: { self: `/api/v3/repos/${repo.fullName}/contents/${path}`, git: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${path}` },
      },
    };
  }
  if (method === 'PUT' || method === 'DELETE') {
    const input = asObject(body);
    const message = asString(input.message) ?? (method === 'DELETE' ? `Delete ${path}` : `Update ${path}`);
    const targetBranch = asString(input.branch) ?? branch;
    // A branch that does not exist yet is created from the default tip (or unborn
    // when the repo has no commits); this is the MCP setup's fallback branch path.
    if (repo.resolveRef(targetBranch) === null) {
      const defaultTip = repo.resolveRef(repo.defaultBranch);
      if (defaultTip !== null) repo.refs.set(`refs/heads/${targetBranch}`, defaultTip);
    }
    const tip = repo.resolveRef(targetBranch);
    const files = repo.filesAt(tip);
    if (method === 'DELETE') {
      if (!files.has(path)) return notFound('Not Found');
      const givenSha = asString(input.sha);
      if (givenSha && givenSha !== files.get(path)!.oid) return { status: 409, body: { message: 'sha does not match' } };
      const { commit } = writeFile(repo, targetBranch, path, Buffer.alloc(0), message, true);
      return { status: 200, body: { content: null, commit: { sha: commit, message } } };
    }
    const contentText = asString(input.content);
    if (contentText === undefined) return { status: 422, body: { message: 'content is required' } };
    const content = b64decode(contentText);
    const existing = files.get(path);
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      const givenSha = asString(input.sha);
      if (!givenSha) return { status: 422, body: { message: 'sha is required for update' } };
      if (givenSha !== existing.oid) return { status: 409, body: { message: 'sha does not match' } };
    }
    const { commit, blobSha } = writeFile(repo, targetBranch, path, content, message, false);
    return {
      status: isUpdate ? 200 : 201,
      body: {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64', url: `/api/v3/repos/${repo.fullName}/contents/${path}`, html_url: `https://github.com/${repo.fullName}/blob/${targetBranch}/${path}`, git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${blobSha}`, download_url: null, type: 'file', _links: { self: `/api/v3/repos/${repo.fullName}/contents/${path}`, git: `/api/v3/repos/${repo.fullName}/git/blobs/${blobSha}`, html: `https://github.com/${repo.fullName}/blob/${targetBranch}/${path}` } },
        commit: { sha: commit, message },
      },
    };
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

export interface RestRoute {
  method: string;
  path: string;
}

function matchContents(method: string, path: string): { owner: string; name: string; filePath: string } | null {
  const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/.exec(path);
  if (!match) return null;
  if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return null;
  return { owner: decodeURIComponent(match[1]!), name: decodeURIComponent(match[2]!), filePath: match[3] ? decodeURIComponent(match[3]) : '' };
}

/**
 * Handle one REST request. Returns null when the path is not a REST route at all (so the
 * caller can fall through to git / GraphQL / MCP). The caller owns authentication for the
 * protected routes; GET /api/v3, GET /api/v3/meta and GET /api/v3/rate_limit are public.
 */
export function dispatchRest(
  method: string,
  path: string,
  query: URLSearchParams,
  rawBody: Buffer,
  ctx: RestContext,
): { status: number; body: unknown; headers?: Record<string, string> } | null {
  // GET /api/v3/ (trailing slash) is the same root as GET /api/v3.
  const normalizedPath = path === '/api/v3/' ? '/api/v3' : path;
  const contents = matchContents(method, path);
  if (contents) {
    const parsed = parseBody(rawBody);
    if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
    return handleContents(method, contents.owner, contents.name, contents.filePath, query, parsed.value, ctx);
  }
  // Branch and ref names may themselves contain slashes (feature/x), so these two
  // routes are matched by prefix rather than by the single-segment route table.
  const branchMatch = method === 'GET' ? /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(path) : null;
  if (branchMatch) {
    const repo = repoOr404(ctx, branchMatch[1]!, branchMatch[2]!);
    if ('status' in repo) return repo;
    const branch = decodeURIComponent(branchMatch[3]!);
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) return notFound('Branch not found');
    return { status: 200, body: { name: branch, commit: { sha: oid }, protected: false } };
  }
  const refMatch = method === 'GET' ? /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/.exec(path) : null;
  if (refMatch) {
    const repo = repoOr404(ctx, refMatch[1]!, refMatch[2]!);
    if ('status' in repo) return repo;
    const full = `refs/${decodeURIComponent(refMatch[3]!)}`;
    const oid = repo.refs.get(full);
    if (!oid) return notFound('Reference does not exist');
    return { status: 200, body: { ref: full, node_id: globalId('Repository', `${repo.fullName}:${full}`), url: `/api/v3/repos/${repo.fullName}/git/refs/${refMatch[3]}`, object: { sha: oid, type: repo.lookup(oid)?.type ?? 'commit' } } };
  }
  for (const entry of routes) {
    if (entry.method !== method) continue;
    const match = entry.pattern.exec(normalizedPath);
    if (!match) continue;
    const params: Record<string, string> = {};
    entry.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]!);
    });
    const parsed = parseBody(rawBody);
    if (!parsed.ok) return { status: 400, body: { message: 'Problems parsing JSON' } };
    return entry.handler(params, query, parsed.value, ctx);
  }
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    return { status: 404, body: { message: 'Not Found' } };
  }
  return null;
}

export { buildTree, buildTag, hashObject, parseTree, peelToCommit, isObjectId };
