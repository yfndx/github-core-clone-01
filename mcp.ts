// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, stateless (no session id is ever sent).
//
// Two eras are served (checks-mcp.ts, mcp-client.ts):
// - Modern 2026-07-28: no handshake. Every request declares its revision in
//   _meta['io.modelcontextprotocol/protocolVersion'] (and a plain protocolVersion key).
//   `server/discover` is mandatory and must return supportedVersions (a non-empty list
//   of YYYY-MM-DD revisions), capabilities (a record; capabilities.tools must be a
//   record), and serverInfo {name, version} (top-level AND in
//   _meta['io.modelcontextprotocol/serverInfo'] — the client reads _meta first).
// - Legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`. The
//   initialize result echoes the offered revision when it is a YYYY-MM-DD date,
//   otherwise '2025-11-25', with capabilities {tools: {}} and serverInfo.
// A discover that answers 404 or JSON-RPC -32601 makes the client fall back to legacy;
// -32022 (UnsupportedProtocolVersionError) makes it retry with a version from
// data.supported; 401/403/5xx or -32020/-32021/-32600/-32602 on discover is a
// connection failure. Unknown methods are -32601; `ping` returns {}.
// - `notifications/*` (no id) -> HTTP 202, empty body.
// - `tools/list`: at least 6 tools, all six required present by name (canonical names
//   used: create_repo, get_repo, create_issue, list_issues, create_pull_request,
//   merge_pull_request). Two calls must be byte-identical (deterministic order).
//   Every tool has a non-empty description and an inputSchema of type object; the
//   required sets are the safe ones the suite can fill: create_repo [name],
//   get_repo [owner, repo], create_issue [owner, repo, title], list_issues
//   [owner, repo], create_pull_request [owner, repo, title, head, base],
//   merge_pull_request [owner, repo, pull_number].
// - Tool results return BOTH content: [{type: 'text', text: JSON.stringify(result)}]
//   AND structuredContent: result. create_repo includes full_name "owner/repo";
//   create_issue returns the issue (number/title); list_issues returns the array;
//   create_pull_request returns {number, ...}; merge_pull_request returns the merged
//   result; get_repo returns the repo (its text includes the name).
// - `parse-error`: a non-JSON body -> HTTP 400 with JSON-RPC -32700, id null.
//   `missing-arguments`: tools/call create_issue with {} -> JSON-RPC -32602.
//   `unknown-tool`: tools/call with an unknown name -> JSON-RPC -32602 (HTTP 200).
//   `concurrent-calls`: request ids are echoed exactly (string or number).
//   `auth-required`: every /mcp request without a valid bearer is HTTP 401 (the
//   caller checks auth before dispatching here).
// REST parity: the MCP tools drive the same store as the REST surface, so a repo or
// issue created through MCP is readable through REST with a stable numeric id.

import { buildCommit, globalId, nowIso, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { threeWayMerge } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoResult(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.fullName),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueResult(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.fullName}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: repo.owner },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullResult(repo: Repo, pull: Pull): Record<string, unknown> {
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
    head: { ref: pull.head, sha: repo.resolveRef(pull.head), label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: repo.resolveRef(pull.base), label: `${repo.owner}:${pull.base}` },
    user: { login: repo.owner },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

class McpFailure extends Error {
  public readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Pick an argument by any of its synonyms (the suite maps semantic args to schema properties). */
function arg(args: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function requiredArg(args: Record<string, unknown>, names: readonly string[], label: string): unknown {
  const value = arg(args, names);
  if (value === undefined || value === null || value === '') {
    throw new McpFailure(-32602, `missing required argument: ${label}`);
  }
  return value;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = String(requiredArg(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name'], 'name'));
      const owner = String(arg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']) ?? 'adaiversen');
      const description = String(arg(args, ['description', 'about', 'summary', 'body']) ?? '');
      const isPrivate = arg(args, ['private', 'is_private']) === true;
      if (store.getRepo(owner, repoName)) throw new McpFailure(-32602, `Repository ${owner}/${repoName} already exists`);
      const repo = store.createRepo(owner, repoName, description, isPrivate);
      return repoResult(repo);
    }
    case 'get_repo': {
      const owner = String(requiredArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'], 'owner'));
      const repoName = String(requiredArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'], 'repo'));
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new McpFailure(-32602, `Repository ${owner}/${repoName} not found`);
      return repoResult(repo);
    }
    case 'create_issue': {
      const owner = String(requiredArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'], 'owner'));
      const repoName = String(requiredArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'], 'repo'));
      const title = String(requiredArg(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'], 'title'));
      const body = String(arg(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '');
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new McpFailure(-32602, `Repository ${owner}/${repoName} not found`);
      const number = repo.nextNumber++;
      const issue: Issue = {
        id: store.globalId(),
        number,
        title,
        body,
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: number,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      repo.issues.push(issue);
      return issueResult(repo, issue);
    }
    case 'list_issues': {
      const owner = String(requiredArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'], 'owner'));
      const repoName = String(requiredArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'], 'repo'));
      const state = String(arg(args, ['state', 'status']) ?? 'open');
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new McpFailure(-32602, `Repository ${owner}/${repoName} not found`);
      const items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return items.map((issue) => issueResult(repo, issue));
    }
    case 'create_pull_request': {
      const owner = String(requiredArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'], 'owner'));
      const repoName = String(requiredArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'], 'repo'));
      const title = String(requiredArg(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'], 'title'));
      const head = String(requiredArg(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'], 'head'));
      const base = String(requiredArg(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'], 'base'));
      const body = String(arg(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '');
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new McpFailure(-32602, `Repository ${owner}/${repoName} not found`);
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        throw new McpFailure(-32602, 'head or base branch does not exist');
      }
      if (repo.pulls.some((pull) => pull.state === 'open' && pull.head === head && pull.base === base)) {
        throw new McpFailure(-32602, 'A pull request already exists for these branches');
      }
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: store.globalId(),
        number,
        title,
        body,
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
      return pullResult(repo, pull);
    }
    case 'merge_pull_request': {
      const owner = String(requiredArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'], 'owner'));
      const repoName = String(requiredArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'], 'repo'));
      const number = Number(requiredArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'], 'pull_number'));
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new McpFailure(-32602, `Repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((item) => item.number === number);
      if (!pull) throw new McpFailure(-32602, `Pull request #${number} not found`);
      if (pull.state !== 'open') throw new McpFailure(-32602, 'Pull request is not open');
      const headTip = repo.resolveRef(pull.head);
      const baseTip = repo.resolveRef(pull.base);
      if (headTip === null || baseTip === null) throw new McpFailure(-32602, 'missing branch tip');
      const merged = threeWayMerge(repo, baseTip, headTip);
      if (merged === null || merged.conflicts.length > 0) throw new McpFailure(-32602, 'Merge conflict');
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
      const commitOid = repo.putObject('commit', buildCommit({ tree: merged.tree, parents: [baseTip], message }));
      repo.refs.set(`refs/heads/${pull.base}`, commitOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = commitOid;
      pull.updatedAt = nowIso();
      return { sha: commitOid, merged: true, message: 'Pull Request successfully merged', pull_request: pullResult(repo, pull) };
    }
    default:
      throw new McpFailure(-32602, `unknown tool: ${name}`);
  }
}

function serverInfoBlock(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

/**
 * Handle one JSON-RPC request object. Returns {status, body} where body is the JSON-RPC
 * response object, or null for a notification (HTTP 202, empty body).
 */
export function handleMcpRequest(request: unknown, store: Store): { status: number; body: Record<string, unknown> | null } {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = request as Record<string, unknown>;
  const id = req.id === undefined ? null : (req.id as string | number | null);
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;

  // A request with no id is a notification: acknowledge with 202 and no body.
  if (req.id === undefined) {
    return { status: 202, body: null };
  }

  const result = (value: unknown): { status: number; body: Record<string, unknown> } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: value },
  });
  const failure = (error: RpcError): { status: number; body: Record<string, unknown> } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error },
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: serverInfoBlock(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfoBlock() },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    return result({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: serverInfoBlock(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfoBlock() },
    });
  }

  if (method === 'ping') {
    return result({});
  }

  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof params.arguments !== 'object' || params.arguments === null) {
      return failure({ code: -32602, message: 'tools/call requires an arguments object' });
    }
    try {
      const value = callTool(store, name, args);
      return result({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
      });
    } catch (error) {
      if (error instanceof McpFailure) return failure({ code: error.code, message: error.message });
      return failure({ code: -32603, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // The client's discover probe also reads the protocol version out of _meta when the
  // server answers modern; a method it does not know is a plain -32601.
  void meta;
  return failure({ code: -32601, message: `Method not found: ${method}` });
}

/** Parse an MCP request body. Returns a sentinel for a JSON parse failure. */
export function parseMcpBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}
