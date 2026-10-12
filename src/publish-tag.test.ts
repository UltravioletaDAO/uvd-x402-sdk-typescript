import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// scripts/tag-release.mjs is the last step of publish.yml: once npm has the version, it puts the
// annotated tag v<version> on the run's commit. This runs it the way the workflow does, as its
// own node process with the runner's env, against a fake GitHub API on loopback (no other
// network). The fake answers like the REST API: git/ref is an exact match and 404 when absent,
// creating a ref that exists is 422, and a tag object can point at another tag object. Outside
// /repos/ it answers like the npm registry: GET /<name>/<version> is the published manifest,
// with the gitHead npm recorded, or 404 while the version is not there.

const SCRIPT = resolve(__dirname, '..', 'scripts', 'tag-release.mjs');
const REPO = 'UltravioletaDAO/uvd-x402-sdk-typescript';
const VERSION = '2.104.3';
const TAG_REF = `refs/tags/v${VERSION}`;
const RUN_SHA = 'a1b2c3d4e5'.repeat(4); // the commit the run checked out and published
const OTHER_SHA = 'f0e1d2c3b4'.repeat(4);
// A neutral name and value: the script must send it and never print it.
const CREDENTIAL = 'loopback-only-test-value';

type GitObject = { type: 'commit' | 'tag' | 'tree'; sha: string };
type Recorded = { method: string; path: string; ref: string | null; body: any; authorization?: string };
type Override = { status: number; body?: unknown };

class FakeGitHub {
  refs = new Map<string, GitObject>();
  tagObjects = new Map<string, GitObject>();
  // package.json by commit; HEAD is what the default branch has now
  manifests = new Map<string, unknown>([
    [RUN_SHA, { name: 'uvd-x402-sdk', version: VERSION }],
    ['HEAD', { name: 'uvd-x402-sdk', version: '2.105.0' }],
  ]);
  // npm: <name>/<version> -> what the registry answers once it has it
  published = new Map<string, unknown>([
    [`uvd-x402-sdk/${VERSION}`, { name: 'uvd-x402-sdk', version: VERSION, gitHead: RUN_SHA }],
  ]);
  registryMisses = 0; // 404s the registry answers before the version shows
  requests: Recorded[] = [];
  intercept?: (request: Recorded) => Override | undefined;
  private created = 0;

  tagObject(points: GitObject): string {
    const sha = (++this.created).toString(16).padStart(40, 'c');
    this.tagObjects.set(sha, points);
    return sha;
  }

  answer(request: Recorded): Override {
    if (!request.path.startsWith('/repos/')) {
      const doc = request.method === 'GET' ? this.published.get(request.path.slice(1)) : undefined;
      if (doc === undefined || this.registryMisses-- > 0) return { status: 404, body: { error: 'Not found' } };
      return { status: 200, body: doc };
    }
    const prefix = `/repos/${REPO}`;
    if (!request.path.startsWith(`${prefix}/`)) return { status: 404, body: { message: 'Not Found' } };
    const path = request.path.slice(prefix.length);
    if (request.method === 'GET' && path === '/contents/package.json') {
      const manifest = this.manifests.get(request.ref ?? 'HEAD');
      if (manifest === undefined) return { status: 404, body: { message: 'Not Found' } };
      // the API wraps the base64 at 60 columns
      const content = Buffer.from(JSON.stringify(manifest, null, 2)).toString('base64').replace(/.{60}/g, '$&\n');
      return { status: 200, body: { type: 'file', path: 'package.json', encoding: 'base64', content } };
    }
    if (request.method === 'GET' && path.startsWith('/git/ref/tags/')) {
      const ref = `refs/${path.slice('/git/ref/'.length)}`;
      const object = this.refs.get(ref);
      return object ? { status: 200, body: { ref, object } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (request.method === 'GET' && path.startsWith('/git/tags/')) {
      const sha = path.slice('/git/tags/'.length);
      const object = this.tagObjects.get(sha);
      return object ? { status: 200, body: { sha, object } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (request.method === 'POST' && path === '/git/tags') {
      const { tag, message, object, type } = request.body;
      const sha = this.tagObject({ type, sha: object });
      return { status: 201, body: { sha, tag, message, object: { type, sha: object } } };
    }
    if (request.method === 'POST' && path === '/git/refs') {
      const { ref, sha } = request.body;
      if (this.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
      const object: GitObject = { type: this.tagObjects.has(sha) ? 'tag' : 'commit', sha };
      this.refs.set(ref, object);
      return { status: 201, body: { ref, object } };
    }
    return { status: 404, body: { message: 'Not Found' } };
  }

  // The commit refs/tags/v<VERSION> ends on, through tag objects.
  taggedCommit(): GitObject | undefined {
    let object = this.refs.get(TAG_REF);
    while (object?.type === 'tag') object = this.tagObjects.get(object.sha);
    return object;
  }

  writes(): Recorded[] {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  registryReads(): Recorded[] {
    return this.requests.filter((request) => !request.path.startsWith('/repos/'));
  }
}

async function run(github: FakeGitHub, env: Record<string, string | undefined> = {}) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const request: Recorded = {
        method: req.method ?? '',
        path: url.pathname,
        ref: url.searchParams.get('ref'),
        body: raw === '' ? undefined : JSON.parse(raw),
        authorization: req.headers.authorization,
      };
      github.requests.push(request);
      const { status, body } = github.intercept?.(request) ?? github.answer(request);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  const childEnv: Record<string, string> = {};
  const all: Record<string, string | undefined> = {
    INPUT_VERSION: VERSION,
    GITHUB_TOKEN: CREDENTIAL,
    GITHUB_SHA: RUN_SHA,
    GITHUB_REPOSITORY: REPO,
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    NPM_REGISTRY_URL: `http://127.0.0.1:${port}`, // every run: no test reaches the real registry
    TAG_RELEASE_REGISTRY_WAIT_MS: '5',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '4242',
    SystemRoot: process.env.SystemRoot, // Windows sockets need it
    ...env,
  };
  for (const [key, value] of Object.entries(all)) if (value !== undefined) childEnv[key] = value;
  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [SCRIPT], { env: childEnv });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const timer = setTimeout(() => child.kill(), 10_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
    });
  } finally {
    await new Promise((done) => server.close(done));
  }
}

describe('scripts/tag-release.mjs: v<version> on the published commit, once', { timeout: 20_000 }, () => {
  it('creates the annotated tag on the run commit when there is none', async () => {
    const github = new FakeGitHub();
    const { code, stdout, stderr } = await run(github);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(github.requests.map((r) => `${r.method} ${r.path.replace(`/repos/${REPO}`, '')}`)).toEqual([
      'GET /contents/package.json',
      `GET /uvd-x402-sdk/${VERSION}`,
      `GET /git/ref/tags/v${VERSION}`,
      'POST /git/tags',
      'POST /git/refs',
    ]);
    // package.json read at the run's commit, not at the default branch (which has 2.105.0)
    expect(github.requests[0].ref).toBe(RUN_SHA);
    const [object, ref] = github.writes().map((r) => r.body);
    expect(object).toEqual({
      tag: `v${VERSION}`,
      message: `uvd-x402-sdk ${VERSION}\n\nPublished to npm by https://github.com/${REPO}/actions/runs/4242\n`,
      object: RUN_SHA,
      type: 'commit',
    });
    expect(ref.ref).toBe(TAG_REF);
    expect(github.refs.get(TAG_REF)?.type).toBe('tag'); // annotated, not lightweight
    expect(github.taggedCommit()).toEqual({ type: 'commit', sha: RUN_SHA });
    expect(stdout).toContain(`::notice::v${VERSION} created on ${RUN_SHA}`);
    for (const request of github.requests) {
      // the GitHub token goes to GitHub only, never to the registry
      expect(request.authorization).toBe(request.path.startsWith('/repos/') ? `Bearer ${CREDENTIAL}` : undefined);
    }
    expect(stdout + stderr).not.toContain(CREDENTIAL);
  });

  it('passes on a second run of the same release, writing nothing', async () => {
    const github = new FakeGitHub();
    expect((await run(github)).code).toBe(0);
    const before = github.writes().length;

    const again = await run(github);
    expect(again.code).toBe(0);
    expect(github.writes()).toHaveLength(before);
    expect(again.stdout).toContain(`::notice::v${VERSION} already on ${RUN_SHA}`);
  });

  const existing: Array<[string, (github: FakeGitHub) => void]> = [
    ['lightweight', (g) => g.refs.set(TAG_REF, { type: 'commit', sha: RUN_SHA })],
    ['annotated', (g) => g.refs.set(TAG_REF, { type: 'tag', sha: g.tagObject({ type: 'commit', sha: RUN_SHA }) })],
    [
      'a tag of a tag',
      (g) => {
        const inner = g.tagObject({ type: 'commit', sha: RUN_SHA });
        g.refs.set(TAG_REF, { type: 'tag', sha: g.tagObject({ type: 'tag', sha: inner }) });
      },
    ],
    ['with the SHA in upper case', (g) => g.refs.set(TAG_REF, { type: 'commit', sha: RUN_SHA.toUpperCase() })],
  ];

  it.each(existing)('passes without writing when the tag is already on the run commit (%s)', async (_kind, seed) => {
    const github = new FakeGitHub();
    seed(github);
    const { code, stdout, stderr } = await run(github);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(github.writes()).toEqual([]);
    expect(stdout).toContain(`::notice::v${VERSION} already on ${RUN_SHA}`);
  });

  const elsewhere: Array<[string, (github: FakeGitHub) => void]> = [
    ['lightweight', (g) => g.refs.set(TAG_REF, { type: 'commit', sha: OTHER_SHA })],
    ['annotated', (g) => g.refs.set(TAG_REF, { type: 'tag', sha: g.tagObject({ type: 'commit', sha: OTHER_SHA }) })],
  ];

  it.each(elsewhere)('fails and moves nothing when the tag is on another commit (%s)', async (_kind, seed) => {
    const github = new FakeGitHub();
    seed(github);
    const before = structuredClone(github.refs.get(TAG_REF));
    const { code, stdout, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`::error::v${VERSION} already points to ${OTHER_SHA}, not to ${RUN_SHA}`);
    expect(github.writes()).toEqual([]);
    expect(github.refs.get(TAG_REF)).toEqual(before);
    expect(stdout + stderr).not.toContain(CREDENTIAL);
  });

  it('fails when the tag is on something that is not a commit', async () => {
    const github = new FakeGitHub();
    github.refs.set(TAG_REF, { type: 'tag', sha: github.tagObject({ type: 'tree', sha: RUN_SHA }) });
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain('points to a tree, not a commit');
    expect(github.writes()).toEqual([]);
  });

  it('stops on a chain of tag objects that does not end', async () => {
    const github = new FakeGitHub();
    const loop = github.tagObject({ type: 'commit', sha: RUN_SHA });
    github.tagObjects.set(loop, { type: 'tag', sha: loop });
    github.refs.set(TAG_REF, { type: 'tag', sha: loop });
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain('more than 5 tag objects');
    expect(github.writes()).toEqual([]);
  });

  it('fails when the API answers for a different ref', async () => {
    const github = new FakeGitHub();
    github.intercept = (request) =>
      request.path.endsWith(`/git/ref/tags/v${VERSION}`)
        ? { status: 200, body: { ref: `${TAG_REF}0`, object: { type: 'commit', sha: RUN_SHA } } }
        : undefined;
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`asked for ${TAG_REF}, the API answered ${TAG_REF}0`);
    expect(github.writes()).toEqual([]);
  });

  it('fails, writing nothing, when package.json at the run commit has another version', async () => {
    const github = new FakeGitHub();
    // the default branch has the input version; the commit this run published does not
    github.manifests.set(RUN_SHA, { name: 'uvd-x402-sdk', version: '2.104.2' });
    github.manifests.set('HEAD', { name: 'uvd-x402-sdk', version: VERSION });
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`package.json at ${RUN_SHA} has version "2.104.2", not ${VERSION}`);
    expect(github.requests).toHaveLength(1);
    expect(github.refs.size).toBe(0);
  });

  it('fails when package.json cannot be read at the run commit', async () => {
    const github = new FakeGitHub();
    github.manifests.delete(RUN_SHA);
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`reading package.json at ${RUN_SHA}: HTTP 404`);
    expect(github.writes()).toEqual([]);
  });

  // Each of these, if it got as far as the API, would put a malformed name in a URL or a tag.
  // package.json says the same thing as the input, so only the format check stops them.
  const malformed = [
    ...['', 'v2.104.3', '2.104', '2.104.3 ', ' 2.104.3', '2.104.3\n'],
    ...['02.104.3', '2.104.3/../../x', '2.104.3+build'],
  ];
  it.each(malformed)('refuses the input version %j before any request', async (input) => {
    const github = new FakeGitHub();
    github.manifests.set(RUN_SHA, { name: 'uvd-x402-sdk', version: input });
    const { code, stderr } = await run(github, { INPUT_VERSION: input });
    expect(code).toBe(1);
    expect(stderr).toContain('is not a version like 1.2.3');
    expect(github.requests).toEqual([]);
  });

  it.each([
    ['GITHUB_SHA', undefined, 'is not a commit SHA'],
    ['GITHUB_SHA', 'main', 'is not a commit SHA'],
    ['GITHUB_SHA', RUN_SHA.slice(1), 'is not a commit SHA'],
    ['GITHUB_SHA', RUN_SHA.toUpperCase(), 'is not a commit SHA'],
    ['GITHUB_REPOSITORY', undefined, 'is not owner/repo'],
    ['GITHUB_REPOSITORY', 'UltravioletaDAO', 'is not owner/repo'],
    ['GITHUB_REPOSITORY', `${REPO}/x`, 'is not owner/repo'],
    ['GITHUB_TOKEN', undefined, 'GITHUB_TOKEN is empty'],
    ['GITHUB_TOKEN', '', 'GITHUB_TOKEN is empty'],
  ])('refuses %s=%j before any request', async (name, value, message) => {
    const github = new FakeGitHub();
    const { code, stderr } = await run(github, { [name]: value });
    expect(code).toBe(1);
    expect(stderr).toContain(message);
    expect(github.requests).toEqual([]);
  });

  it.each([403, 500])('fails without writing when looking up the tag answers %i', async (status) => {
    const github = new FakeGitHub();
    github.intercept = (request) =>
      request.path.includes('/git/ref/') ? { status, body: { message: 'nope' } } : undefined;
    const { code, stdout, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`reading ${TAG_REF}: HTTP ${status}`);
    expect(github.writes()).toEqual([]);
    expect(stdout + stderr).not.toContain(CREDENTIAL);
  });

  it.each([
    ['refused', { status: 403, body: { message: 'Resource not accessible by integration' } }],
    ['answered without a SHA', { status: 201, body: { tag: `v${VERSION}` } }],
  ])('creates no ref when the tag object is %s', async (_how, answer) => {
    const github = new FakeGitHub();
    github.intercept = (request) =>
      request.method === 'POST' && request.path.endsWith('/git/tags') ? answer : undefined;
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`creating the tag object v${VERSION}: HTTP ${answer.status}`);
    expect(github.writes().map((r) => r.path)).toEqual([`/repos/${REPO}/git/tags`]);
    expect(github.refs.size).toBe(0);
  });

  // Someone (a tag made by hand, a second run) creates the ref between the lookup and the create.
  it.each([
    [RUN_SHA, 0, 'already on'],
    [OTHER_SHA, 1, 'already points to'],
  ])('settles a tag that appeared meanwhile on %s', async (sha, exit, message) => {
    const github = new FakeGitHub();
    github.intercept = (request) => {
      if (request.method === 'POST' && request.path.endsWith('/git/refs')) {
        github.refs.set(TAG_REF, { type: 'commit', sha });
      }
      return undefined;
    };
    const { code, stdout, stderr } = await run(github);
    expect(code).toBe(exit);
    expect(stdout + stderr).toContain(message);
    expect(github.refs.get(TAG_REF)).toEqual({ type: 'commit', sha });
  });

  // A ruleset on v* tags, or a tag object the API does not see yet, also answers 422.
  it('fails when creating the ref answers 422 and there is still no tag', async () => {
    const github = new FakeGitHub();
    github.intercept = (request) =>
      request.method === 'POST' && request.path.endsWith('/git/refs')
        ? { status: 422, body: { message: 'Repository rule violations found' } }
        : undefined;
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`creating ${TAG_REF}: HTTP 422`);
    expect(github.refs.size).toBe(0);
  });

  it('fails when the API cannot send package.json in base64', async () => {
    const github = new FakeGitHub();
    // what the contents API answers for a file over 1 MB
    github.intercept = (request) =>
      request.path.endsWith('/contents/package.json')
        ? { status: 200, body: { type: 'file', encoding: 'none', content: '' } }
        : undefined;
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`reading package.json at ${RUN_SHA}: HTTP 200`);
    expect(github.writes()).toEqual([]);
  });

  // Two broken APIs on raw sockets, so no port is closed and reopened by someone else meanwhile.
  async function brokenApi(onConnection: (socket: Socket) => void) {
    const server = createNetServer(onConnection);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      return await run(new FakeGitHub(), { GITHUB_API_URL: `http://127.0.0.1:${port}` });
    } finally {
      await new Promise((done) => server.close(done));
    }
  }

  it('says why when the API does not answer HTTP, without the token', async () => {
    // resume(): read the client's request and end, so the socket closes when the client goes
    const { code, stdout, stderr } = await brokenApi((socket) => socket.resume().end('not http\r\n\r\n'));
    expect(code).toBe(1);
    expect(stderr).toMatch(/::error::unexpected: fetch failed \(.+\)/);
    expect(stdout + stderr).not.toContain(CREDENTIAL);
  });

  // fetch on a dropped connection can stay pending with nothing keeping node alive, and node
  // then exits on its own: that exit is a failure, not a green job with no tag.
  it('fails when the process ends with the work pending', async () => {
    const { code, stdout } = await brokenApi((socket) => socket.destroy());
    expect(code).toBe(1);
    expect(stdout).not.toContain('::notice::');
  });

  // npm must have the version, published from the run's commit, before anything is written.
  it('waits for a version the registry does not show yet, then tags', async () => {
    const github = new FakeGitHub();
    github.registryMisses = 2;
    const { code, stderr } = await run(github);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(github.registryReads()).toHaveLength(3);
    expect(github.taggedCommit()).toEqual({ type: 'commit', sha: RUN_SHA });
  });

  it('reads the gitHead whatever its case', async () => {
    const github = new FakeGitHub();
    const upper = { name: 'uvd-x402-sdk', version: VERSION, gitHead: RUN_SHA.toUpperCase() };
    github.published.set(`uvd-x402-sdk/${VERSION}`, upper);
    const { code, stderr } = await run(github);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(github.taggedCommit()).toEqual({ type: 'commit', sha: RUN_SHA });
  });

  it('does not tag a version npm never received', async () => {
    const github = new FakeGitHub();
    github.published.clear();
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`npm does not have uvd-x402-sdk@${VERSION} (HTTP 404`);
    expect(github.registryReads()).toHaveLength(5);
    expect(github.requests.some((r) => r.path.includes('/git/'))).toBe(false);
  });

  const notFromThisRun: Array<[string, unknown, string]> = [
    [
      'published from another commit',
      { name: 'uvd-x402-sdk', version: VERSION, gitHead: OTHER_SHA },
      `from commit ${OTHER_SHA}, not from ${RUN_SHA}`,
    ],
    ['published with no gitHead', { name: 'uvd-x402-sdk', version: VERSION }, 'with no gitHead'],
    [
      'answered for another version',
      { name: 'uvd-x402-sdk', version: '2.104.2', gitHead: RUN_SHA },
      'answered version',
    ],
  ];

  it.each(notFromThisRun)('does not tag a version %s', async (_how, doc, message) => {
    const github = new FakeGitHub();
    github.published.set(`uvd-x402-sdk/${VERSION}`, doc);
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
    expect(github.requests.some((r) => r.path.includes('/git/'))).toBe(false);
  });

  it('does not tag when the registry does not answer JSON', async () => {
    const github = new FakeGitHub();
    github.intercept = (request) =>
      request.path.startsWith('/repos/') ? undefined : { status: 200, body: undefined };
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain('did not answer JSON');
    expect(github.requests.some((r) => r.path.includes('/git/'))).toBe(false);
  });

  it.each(['', 'Uvd-X402-SDK', '../uvd-x402-sdk', 'uvd x402'])(
    'refuses the package name %j before asking the registry',
    async (name) => {
      const github = new FakeGitHub();
      github.manifests.set(RUN_SHA, { name, version: VERSION });
      const { code, stderr } = await run(github);
      expect(code).toBe(1);
      expect(stderr).toContain('has no valid package name');
      expect(github.registryReads()).toEqual([]);
    }
  );

  it('fails when creating the ref answers anything else', async () => {
    const github = new FakeGitHub();
    github.intercept = (request) =>
      request.method === 'POST' && request.path.endsWith('/git/refs')
        ? { status: 500, body: { message: 'boom' } }
        : undefined;
    const { code, stderr } = await run(github);
    expect(code).toBe(1);
    expect(stderr).toContain(`creating ${TAG_REF}: HTTP 500`);
  });
});
