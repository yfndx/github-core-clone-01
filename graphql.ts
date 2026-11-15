// GraphQL v4 at /api/graphql: a small, strict executor for the documents the trial sends.
// POST {query, variables} -> {data, errors}; a JSON array body is a batch, answered in order.
// Unauthenticated requests are HTTP 401 (handled by the caller, not an envelope).
// GraphQL-level failures are HTTP 200 with an errors array.
//
// Schema surface the conformance suite needs (checks-graphql.ts):
// Query.viewer{login}, Query.repository(owner, name) -> Repository (null, no errors, when
// unknown), Query.node(id) -> Node, Query.__type(name) -> __Type with fields / enumValues.
// Repository{id, databaseId, name, nameWithOwner, owner{login}, defaultBranchRef{name},
// viewerPermission, hasIssuesEnabled, issue(number), issues(first, after, states, orderBy),
// pullRequests(first), pullRequest(number)}; Issue{id, number, title, state, body};
// IssueConnection{nodes, pageInfo{hasNextPage, endCursor}}; PullRequest{id, number, state,
// merged, headRefName, baseRefName, mergeable, files(first)}; PullRequestConnection{nodes};
// PullRequestChangedFile{path}; User{login}. Enums: IssueState, MergeableState,
// PullRequestState, PullRequestMergeMethod, RepositoryPermission, SearchType (must include
// ISSUE), IssueOrderField, OrderDirection.
// Mutations: createIssue, closeIssue, createPullRequest, mergePullRequest (SQUASH),
// addComment. Global ids are base64 of "Kind:key" and are stable across reads.

import { diffTrees, threeWayMerge } from './rest.ts';
import {
  buildCommit,
  globalId,
  mergeBase,
  nowIso,
  parseCommit,
  parseGlobalId,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer + parser (recursive descent over the GraphQL document language)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '#') {
      if (ch === '#') while (i < input.length && input[i] !== '\n') i += 1;
      else i += 1;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let text = '';
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) {
        text += input[j];
        j += 1;
      }
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: parseFloat(text) });
      else tokens.push({ kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      let text = '';
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j]!)) {
        text += input[j];
        j += 1;
      }
      tokens.push({ kind: 'name', value: text });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias?: string;
  name: string;
  arguments?: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition?: string; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek() !== undefined) {
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
        doc.operations.push({ operation: 'query', variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value;
        const variables = this.matchPunct('(') ? this.parseVariableDefinitions() : [];
        doc.operations.push({ operation: keyword, name, variables, selections: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        doc.fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected keyword ${keyword} in GraphQL document`);
      }
    }
    return doc;
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const out: Array<{ name: string; defaultValue?: ValueNode }> = [];
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      out.push({ name, defaultValue });
    }
    return out;
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> | undefined;
    if (this.matchPunct('(')) {
      args = [];
      while (!this.matchPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives (@...) are not used by the trial; skip them if present.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.matchPunct('(')) {
        while (!this.matchPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, arguments: args, selections } };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------------------------

interface FieldDef {
  type: string;
  args?: Record<string, string>;
}

const FIELDS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'Viewer' },
    repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
    node: { type: 'Node', args: { id: 'ID!' } },
    __type: { type: '__Type', args: { name: 'String!' } },
  },
  Mutation: {
    createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
    closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
    createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
    mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
    addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
  },
  Viewer: { login: { type: 'String' } },
  User: { login: { type: 'String' }, id: { type: 'ID' } },
  Node: { id: { type: 'ID' } },
  Repository: {
    id: { type: 'ID' },
    databaseId: { type: 'Int' },
    name: { type: 'String' },
    nameWithOwner: { type: 'String' },
    owner: { type: 'User' },
    defaultBranchRef: { type: 'Ref' },
    viewerPermission: { type: 'RepositoryPermission' },
    hasIssuesEnabled: { type: 'Boolean' },
    issue: { type: 'Issue', args: { number: 'Int!' } },
    issues: { type: 'IssueConnection', args: { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' } },
    pullRequests: { type: 'PullRequestConnection', args: { first: 'Int' } },
    pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
  },
  Ref: { name: { type: 'String' } },
  Issue: {
    id: { type: 'ID' },
    number: { type: 'Int' },
    title: { type: 'String' },
    state: { type: 'IssueState' },
    body: { type: 'String' },
  },
  IssueConnection: {
    nodes: { type: '[Issue]' },
    pageInfo: { type: 'PageInfo' },
  },
  PullRequest: {
    id: { type: 'ID' },
    number: { type: 'Int' },
    state: { type: 'PullRequestState' },
    merged: { type: 'Boolean' },
    headRefName: { type: 'String' },
    baseRefName: { type: 'String' },
    mergeable: { type: 'MergeableState' },
    files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int' } },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]' },
    pageInfo: { type: 'PageInfo' },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]' },
    pageInfo: { type: 'PageInfo' },
  },
  PullRequestChangedFile: { path: { type: 'String' } },
  PageInfo: {
    hasNextPage: { type: 'Boolean' },
    endCursor: { type: 'String' },
  },
  CreateIssuePayload: { issue: { type: 'Issue' } },
  CloseIssuePayload: { issue: { type: 'Issue' } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  AddCommentPayload: { commentEdge: { type: 'CommentEdge' } },
  CommentEdge: { node: { type: 'Comment' } },
  Comment: { id: { type: 'ID' }, body: { type: 'String' } },
  __Type: {
    name: { type: 'String' },
    fields: { type: '[__Field]', args: { includeDeprecated: 'Boolean' } },
    enumValues: { type: '[__EnumValue]', args: { includeDeprecated: 'Boolean' } },
  },
  __Field: { name: { type: 'String' } },
  __EnumValue: { name: { type: 'String' } },
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The object types that implement the Node interface. */
const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User']);

function namedType(type: string): string {
  return type.replace(/[\[\]!]/g, '');
}

function isListType(type: string): boolean {
  return type.startsWith('[');
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => evalValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArguments(field: FieldNode, ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments ?? []) out[arg.name] = evalValue(arg.value, ctx.variables);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match) return parseInt(match[1]!, 10);
  } catch {
    // A cursor that does not decode is treated as "before the first item".
  }
  return -1;
}

function paginate<T>(items: readonly T[], first: number | undefined, after: string | undefined): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const start = indexFromCursor(after) + 1;
  const page = first === undefined ? items.slice(start) : items.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return {
    nodes: [...page],
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      endCursor: page.length === 0 ? null : cursorFor(endIndex),
    },
  };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function userObject(login: string): GqlObject {
  return { __typename: 'User', __login: login };
}

type Resolver = (source: GqlObject, args: Record<string, unknown>, ctx: GqlContext) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(VIEWER_LOGIN),
    repository: (_source, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObject(repo) : null;
    },
    node: (_source, args, ctx) => {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const [owner, name] = parsed.key.split('/');
        const repo = owner && name ? ctx.store.getRepo(owner, name) : undefined;
        return repo ? repoObject(repo) : null;
      }
      if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
        // The key is "owner/name:number": split on ':' first, then on '/'.
        const [fullName, numberText] = parsed.key.split(':');
        const [repoOwner, repoName] = (fullName ?? '').split('/');
        const repo = repoOwner && repoName ? ctx.store.getRepo(repoOwner, repoName) : undefined;
        if (!repo) return null;
        const number = parseInt(numberText ?? '', 10);
        if (parsed.kind === 'Issue') {
          const issue = repo.issues.find((item) => item.number === number);
          return issue ? issueObject(repo, issue) : null;
        }
        const pull = repo.pulls.find((item) => item.number === number);
        return pull ? pullObject(repo, pull) : null;
      }
      if (parsed.kind === 'User') return userObject(parsed.key);
      return null;
    },
    __type: (_source, args) => {
      const name = String(args.name ?? '');
      if (FIELDS[name] || ENUM_VALUES[name]) return { __typename: '__Type', __typeName: name };
      return null;
    },
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'Repository') throw new Error('createIssue: repositoryId is not a repository');
      const [owner, name] = parsed.key.split('/');
      const repo = owner && name ? ctx.store.getRepo(owner, name) : undefined;
      if (!repo) throw new Error('createIssue: repository not found');
      const title = String(input.title ?? '');
      const number = repo.nextNumber++;
      const issue: Issue = {
        id: ctx.store.globalId(),
        number,
        title,
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: number,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', __issue: issueObject(repo, issue) };
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (!parsed || parsed.kind !== 'Issue') throw new Error('closeIssue: issueId is not an issue');
      const [fullName, numberText] = parsed.key.split(':');
      const [repoOwner, repoName] = (fullName ?? '').split('/');
      const repo = repoOwner && repoName ? ctx.store.getRepo(repoOwner, repoName) : undefined;
      if (!repo) throw new Error('closeIssue: repository not found');
      const issue = repo.issues.find((item) => item.number === parseInt(numberText ?? '', 10));
      if (!issue) throw new Error('closeIssue: issue not found');
      issue.state = 'closed';
      issue.updatedAt = nowIso();
      return { __typename: 'CloseIssuePayload', __issue: issueObject(repo, issue) };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'Repository') throw new Error('createPullRequest: repositoryId is not a repository');
      const [owner, name] = parsed.key.split('/');
      const repo = owner && name ? ctx.store.getRepo(owner, name) : undefined;
      if (!repo) throw new Error('createPullRequest: repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const title = String(input.title ?? '');
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        throw new Error('createPullRequest: head or base branch does not exist');
      }
      if (repo.pulls.some((pull) => pull.state === 'open' && pull.head === head && pull.base === base)) {
        throw new Error('createPullRequest: a pull request already exists for these branches');
      }
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: ctx.store.globalId(),
        number,
        title,
        body: String(input.body ?? ''),
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
      return { __typename: 'CreatePullRequestPayload', __pull: pullObject(repo, pull) };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.kind !== 'PullRequest') throw new Error('mergePullRequest: pullRequestId is not a pull request');
      const [fullName, numberText] = parsed.key.split(':');
      const [repoOwner, repoName] = (fullName ?? '').split('/');
      const repo = repoOwner && repoName ? ctx.store.getRepo(repoOwner, repoName) : undefined;
      if (!repo) throw new Error('mergePullRequest: repository not found');
      const pull = repo.pulls.find((item) => item.number === parseInt(numberText ?? '', 10));
      if (!pull) throw new Error('mergePullRequest: pull request not found');
      if (pull.state !== 'open') throw new Error('mergePullRequest: pull request is not open');
      const headTip = repo.resolveRef(pull.head);
      const baseTip = repo.resolveRef(pull.base);
      if (headTip === null || baseTip === null) throw new Error('mergePullRequest: missing branch tip');
      const merged = threeWayMerge(repo, baseTip, headTip);
      if (merged === null || merged.conflicts.length > 0) throw new Error('mergePullRequest: merge conflict');
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
      const commitOid = repo.putObject('commit', buildCommit({ tree: merged.tree, parents: [baseTip], message }));
      repo.refs.set(`refs/heads/${pull.base}`, commitOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = commitOid;
      pull.updatedAt = nowIso();
      return { __typename: 'MergePullRequestPayload', __pull: pullObject(repo, pull) };
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (!parsed || parsed.kind !== 'Issue') throw new Error('addComment: subjectId is not an issue');
      const [fullName, numberText] = parsed.key.split(':');
      const [repoOwner, repoName] = (fullName ?? '').split('/');
      const repo = repoOwner && repoName ? ctx.store.getRepo(repoOwner, repoName) : undefined;
      if (!repo) throw new Error('addComment: repository not found');
      const issue = repo.issues.find((item) => item.number === parseInt(numberText ?? '', 10));
      if (!issue) throw new Error('addComment: issue not found');
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), createdAt: nowIso(), updatedAt: nowIso() };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        __comment: { __typename: 'Comment', id: globalId('Comment', `${repo.fullName}:${issue.number}:${comment.id}`), body: comment.body },
      };
    },
  },
  Viewer: {
    login: () => VIEWER_LOGIN,
  },
  Node: {
    // The global id of whichever concrete type the node is.
    id: (source) => {
      switch (source.__typename) {
        case 'Repository':
          return globalId('Repository', (source.__repo as Repo).fullName);
        case 'Issue':
          return globalId('Issue', `${(source.__repo as Repo).fullName}:${(source.__issue as Issue).number}`);
        case 'PullRequest':
          return globalId('PullRequest', `${(source.__repo as Repo).fullName}:${(source.__pull as Pull).number}`);
        case 'User':
          return globalId('User', String(source.__login ?? VIEWER_LOGIN));
        default:
          return '';
      }
    },
  },
  User: {
    login: (source) => String(source.__login ?? VIEWER_LOGIN),
    id: (source) => globalId('User', String(source.__login ?? VIEWER_LOGIN)),
  },
  Repository: {
    id: (source) => globalId('Repository', (source.__repo as Repo).fullName),
    databaseId: (source) => (source.__repo as Repo).id,
    name: (source) => (source.__repo as Repo).name,
    nameWithOwner: (source) => (source.__repo as Repo).fullName,
    owner: (source) => userObject((source.__repo as Repo).owner),
    defaultBranchRef: (source) => ({ __typename: 'Ref', name: (source.__repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = source.__repo as Repo;
      const issue = repo.issues.find((item) => item.number === Number(args.number));
      return issue ? issueObject(repo, issue) : null;
    },
    issues: (source, args) => {
      const repo = source.__repo as Repo;
      let items = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (states && states.length > 0) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        items = items.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.field === 'CREATED_AT') {
        items.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
      } else {
        items.sort((a, b) => a.number - b.number);
      }
      const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
      const page = paginate(items, first, args.after as string | undefined);
      return {
        __typename: 'IssueConnection',
        nodes: page.nodes.map((issue) => issueObject(repo, issue)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor },
      };
    },
    pullRequests: (source, args) => {
      const repo = source.__repo as Repo;
      const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
      const page = paginate(repo.pulls, first, undefined);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.nodes.map((pull) => pullObject(repo, pull)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor },
      };
    },
    pullRequest: (source, args) => {
      const repo = source.__repo as Repo;
      const pull = repo.pulls.find((item) => item.number === Number(args.number));
      return pull ? pullObject(repo, pull) : null;
    },
  },
  Ref: {
    name: (source) => String(source.name ?? ''),
  },
  Issue: {
    id: (source) => globalId('Issue', `${(source.__repo as Repo).fullName}:${(source.__issue as Issue).number}`),
    number: (source) => (source.__issue as Issue).number,
    title: (source) => (source.__issue as Issue).title,
    state: (source) => (source.__issue as Issue).state.toUpperCase(),
    body: (source) => (source.__issue as Issue).body,
  },
  IssueConnection: {
    nodes: (source) => (source.nodes as unknown[]) ?? [],
    pageInfo: (source) => source.pageInfo as GqlObject,
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', `${(source.__repo as Repo).fullName}:${(source.__pull as Pull).number}`),
    number: (source) => (source.__pull as Pull).number,
    state: (source) => {
      const pull = source.__pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.__pull as Pull).merged,
    headRefName: (source) => (source.__pull as Pull).head,
    baseRefName: (source) => (source.__pull as Pull).base,
    mergeable: (source) => {
      const repo = source.__repo as Repo;
      const pull = source.__pull as Pull;
      const headTip = repo.resolveRef(pull.head);
      const baseTip = repo.resolveRef(pull.base);
      if (headTip === null || baseTip === null) return 'UNKNOWN';
      if (mergeBase(headTip, baseTip, repo.lookup) === null) return 'UNKNOWN';
      const merged = threeWayMerge(repo, baseTip, headTip);
      if (merged === null) return 'UNKNOWN';
      return merged.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (source, args) => {
      const repo = source.__repo as Repo;
      const pull = source.__pull as Pull;
      const headTip = repo.resolveRef(pull.head);
      const baseTip = repo.resolveRef(pull.base);
      let files: Array<{ __typename: string; path: string }> = [];
      if (headTip !== null && baseTip !== null) {
        const mergeBaseOid = mergeBase(headTip, baseTip, repo.lookup);
        if (mergeBaseOid !== null) {
          const baseCommit = repo.lookup(mergeBaseOid);
          const headCommit = repo.lookup(headTip);
          if (baseCommit?.type === 'commit' && headCommit?.type === 'commit') {
            files = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree).map((file) => ({
              __typename: 'PullRequestChangedFile',
              path: file.filename,
            }));
          }
        }
      }
      const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
      const page = paginate(files, first, undefined);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page.nodes,
        pageInfo: { __typename: 'PageInfo', hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor },
      };
    },
  },
  PullRequestConnection: {
    nodes: (source) => (source.nodes as unknown[]) ?? [],
    pageInfo: (source) => source.pageInfo as GqlObject,
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => (source.nodes as unknown[]) ?? [],
    pageInfo: (source) => source.pageInfo as GqlObject,
  },
  PullRequestChangedFile: {
    path: (source) => String(source.path ?? ''),
  },
  PageInfo: {
    hasNextPage: (source) => Boolean(source.hasNextPage),
    endCursor: (source) => (source.endCursor as string | null) ?? null,
  },
  CreateIssuePayload: {
    issue: (source) => source.__issue as GqlObject,
  },
  CloseIssuePayload: {
    issue: (source) => source.__issue as GqlObject,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.__pull as GqlObject,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.__pull as GqlObject,
  },
  AddCommentPayload: {
    commentEdge: (source) => ({ __typename: 'CommentEdge', node: source.__comment as GqlObject }),
  },
  CommentEdge: {
    node: (source) => source.node as GqlObject,
  },
  Comment: {
    id: (source) => String(source.id ?? ''),
    body: (source) => String(source.body ?? ''),
  },
  __Type: {
    name: (source) => String(source.__typeName ?? ''),
    fields: (source) => {
      const name = String(source.__typeName ?? '');
      const fields = FIELDS[name];
      if (!fields) return null;
      return Object.keys(fields).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
    },
    enumValues: (source) => {
      const name = String(source.__typeName ?? '');
      const values = ENUM_VALUES[name];
      if (!values) return null;
      return values.map((value) => ({ __typename: '__EnumValue', name: value }));
    },
  },
  __Field: {
    name: (source) => String(source.name ?? ''),
  },
  __EnumValue: {
    name: (source) => String(source.name ?? ''),
  },
};

function executeSelection(
  source: GqlObject,
  typeName: string,
  selections: SelectionNode[],
  ctx: GqlContext,
  doc: DocumentNode,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  // The value's concrete type (Repository, Issue, ...) can differ from the static
  // type the field declared (Node): fragments match against the concrete type.
  const concrete = source.__typename;
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      const applies =
        !selection.typeCondition ||
        selection.typeCondition === concrete ||
        selection.typeCondition === typeName ||
        (selection.typeCondition === 'Node' && NODE_TYPES.has(concrete));
      if (!applies) continue;
      // The fragment's selections are validated against its type condition.
      const nested = executeSelection(source, selection.typeCondition ?? typeName, selection.selections, ctx, doc);
      if (nested === null) return null;
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        return null;
      }
      const applies =
        fragment.typeCondition === concrete ||
        fragment.typeCondition === typeName ||
        (fragment.typeCondition === 'Node' && NODE_TYPES.has(concrete));
      if (!applies) continue;
      const nested = executeSelection(source, fragment.typeCondition, fragment.selections, ctx, doc);
      if (nested === null) return null;
      Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = concrete;
      continue;
    }
    const fieldDef = FIELDS[typeName]?.[field.name];
    if (!fieldDef) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    let value: unknown;
    try {
      value = resolver(source, evalArguments(field, ctx), ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      return null;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (!field.selections || field.selections.length === 0) {
      out[responseKey] = value;
      continue;
    }
    const returnType = namedType(fieldDef.type);
    if (isListType(fieldDef.type)) {
      const list = value as unknown[];
      const resolved: unknown[] = [];
      for (const item of list) {
        if (item === null || item === undefined) {
          resolved.push(null);
          continue;
        }
        const nested = executeSelection(item as GqlObject, returnType, field.selections, ctx, doc);
        if (nested === null) return null;
        resolved.push(nested);
      }
      out[responseKey] = resolved;
      continue;
    }
    if (typeof value !== 'object') {
      ctx.errors.push({ message: `Field "${field.name}" on type "${typeName}" does not return an object.` });
      return null;
    }
    const nested = executeSelection(value as GqlObject, returnType, field.selections, ctx, doc);
    if (nested === null) return null;
    out[responseKey] = nested;
  }
  return out;
}

export interface GraphQLEnvelope {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one GraphQL request body (a single operation or a batch array). */
export function executeGraphQL(body: unknown, store: Store): GraphQLEnvelope | GraphQLEnvelope[] {
  if (Array.isArray(body)) {
    return body.map((item) => executeOne(item, store));
  }
  return executeOne(body, store);
}

function executeOne(body: unknown, store: Store): GraphQLEnvelope {
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const query = typeof input.query === 'string' ? input.query : '';
  const variables = input.variables !== null && typeof input.variables === 'object' && !Array.isArray(input.variables) ? (input.variables as Record<string, unknown>) : {};
  const operationName = typeof input.operationName === 'string' ? input.operationName : undefined;
  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = operationName ? doc.operations.find((op) => op.name === operationName) : doc.operations[0];
  if (!operation) {
    return { data: null, errors: [{ message: operationName ? `Unknown operation named "${operationName}".` : 'No operation in the GraphQL document.' }] };
  }
  const ctx: GqlContext = { store, variables, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelection(root, rootType, operation.selections, ctx, doc);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  return { data };
}

export { executeGraphQL as default };
