#!/usr/bin/env node
/**
 * Creates the annotated tag v<version> on the commit that publish.yml just published, through the
 * GitHub API. publish.yml runs it in its last job, `tag`, which needs the publishing job: it runs
 * only after `npm publish` succeeded, with a token that can write contents and nothing else.
 *
 * - The version is the workflow input. It must equal the version in package.json at the run's
 *   commit (GITHUB_SHA, the commit every job of the run checked out), read through the API at
 *   that commit, not from whatever the default branch has now.
 * - npm must have <name>@<version>, published from that commit: its gitHead, which npm records
 *   when it publishes from a git checkout, must be GITHUB_SHA. So no edit of the workflow (a dry
 *   run, another directory, an .npmrc) can get a tag for a version npm never received. A version
 *   just published may take a moment to show: the registry is read up to 5 times over ~75 s.
 * - Tag absent: creates the tag object and refs/tags/v<version> pointing at it.
 * - Tag already on that commit, lightweight or annotated: nothing to do, exit 0. A re-run of the
 *   job, or a tag made by hand before it, passes.
 * - Tag on another commit, or on something that is not a commit: exit 1, nothing is moved.
 *
 * Env: INPUT_VERSION and GITHUB_TOKEN from the workflow step; GITHUB_SHA, GITHUB_REPOSITORY,
 * GITHUB_API_URL, GITHUB_SERVER_URL and GITHUB_RUN_ID are set by the runner. NPM_REGISTRY_URL and
 * TAG_RELEASE_REGISTRY_WAIT_MS exist for the tests; publish.yml passes the step nothing else
 * (src/publish-workflow.test.ts checks it). The GitHub token never goes to the registry.
 *
 * src/publish-tag.test.ts runs this file against a fake GitHub API on loopback.
 *
 * Usage: node scripts/tag-release.mjs
 */

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
// A tag object may point at another tag object; past this many hops, something is wrong.
const MAX_TAG_HOPS = 5;

// Failing until the tag is settled: if the process ends with a request still pending (a dropped
// connection can leave fetch with nothing keeping node alive), that must not read as success.
process.exitCode = 1;

class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};

const env = process.env;
const version = env.INPUT_VERSION ?? '';
const token = env.GITHUB_TOKEN ?? '';
const sha = env.GITHUB_SHA ?? '';
const repository = env.GITHUB_REPOSITORY ?? '';
const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const registryUrl = (env.NPM_REGISTRY_URL || 'https://registry.npmjs.org').replace(/\/+$/, '');
// Waits between registry reads: 1, 2, 4 and 8 times this, 75 s in all by default.
const registryWait = Number(env.TAG_RELEASE_REGISTRY_WAIT_MS || 5000);
const tag = `v${version}`;

async function api(method, path, body) {
  const response = await fetch(`${apiUrl}/repos/${repository}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text: text.slice(0, 300) };
}

// package.json as committed at `commit`.
async function manifestAt(commit) {
  const { status, json, text } = await api('GET', `/contents/package.json?ref=${commit}`);
  if (status !== 200 || json?.encoding !== 'base64' || typeof json.content !== 'string') {
    fail(`reading package.json at ${commit}: HTTP ${status} ${text}`);
  }
  try {
    return JSON.parse(Buffer.from(json.content, 'base64').toString('utf8'));
  } catch {
    fail(`package.json at ${commit} is not JSON`);
  }
}

// The commit npm says it published <name>@<version> from. No GitHub token here: the registry is public.
async function publishedFrom(name) {
  const url = `${registryUrl}/${name.replace('/', '%2f')}/${version}`;
  let last = '';
  for (const factor of [0, 1, 2, 4, 8]) {
    if (factor > 0) await new Promise((done) => setTimeout(done, factor * registryWait));
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (response.status !== 200) {
      last = `HTTP ${response.status}`;
      continue;
    }
    let published;
    try {
      published = JSON.parse(text);
    } catch {
      fail(`${url} did not answer JSON`);
    }
    if (published?.version !== version) fail(`${url} answered version ${JSON.stringify(published?.version)}`);
    if (typeof published.gitHead !== 'string') fail(`npm has ${name}@${version} with no gitHead: no commit to check`);
    return published.gitHead.toLowerCase();
  }
  fail(`npm does not have ${name}@${version} (${last} from ${registryUrl}); not tagging what npm did not receive`);
}

// The commit refs/tags/<tag> points to, through any tag objects, or null if there is no such tag.
async function taggedCommit() {
  const ref = await api('GET', `/git/ref/tags/${tag}`);
  if (ref.status === 404) return null;
  if (ref.status !== 200) fail(`reading refs/tags/${tag}: HTTP ${ref.status} ${ref.text}`);
  if (ref.json?.ref !== `refs/tags/${tag}`) fail(`asked for refs/tags/${tag}, the API answered ${ref.json?.ref}`);
  let object = ref.json.object;
  for (let hops = 0; object?.type === 'tag'; hops++) {
    if (hops === MAX_TAG_HOPS) fail(`${tag} goes through more than ${MAX_TAG_HOPS} tag objects`);
    const next = await api('GET', `/git/tags/${object.sha}`);
    if (next.status !== 200) fail(`reading tag object ${object.sha}: HTTP ${next.status} ${next.text}`);
    object = next.json?.object;
  }
  if (object?.type !== 'commit' || typeof object.sha !== 'string') {
    fail(`${tag} points to a ${object?.type ?? 'nothing'}, not a commit`);
  }
  return object.sha.toLowerCase();
}

// Exit 0 if refs/tags/<tag> is on the run's commit; otherwise stop with what it is on.
async function settled(found, created) {
  if (found === sha) {
    console.log(`::notice::${tag} ${created ? 'created' : 'already'} on ${sha}`);
    process.exitCode = 0;
    return;
  }
  fail(`${tag} already points to ${found}, not to ${sha}, the commit this run published; the tag was not moved`);
}

async function main() {
  if (!VERSION.test(version)) fail(`INPUT_VERSION ${JSON.stringify(version)} is not a version like 1.2.3`);
  if (!SHA.test(sha)) fail(`GITHUB_SHA ${JSON.stringify(sha)} is not a commit SHA`);
  if (!REPOSITORY.test(repository)) fail(`GITHUB_REPOSITORY ${JSON.stringify(repository)} is not owner/repo`);
  if (token === '') fail('GITHUB_TOKEN is empty');

  const manifest = await manifestAt(sha);
  if (manifest?.version !== version) {
    fail(`package.json at ${sha} has version ${JSON.stringify(manifest?.version)}, not ${version}`);
  }

  if (typeof manifest.name !== 'string' || !PACKAGE.test(manifest.name)) {
    fail(`package.json at ${sha} has no valid package name: ${JSON.stringify(manifest.name)}`);
  }
  const gitHead = await publishedFrom(manifest.name);
  if (gitHead !== sha) {
    fail(`npm has ${manifest.name}@${version} from commit ${gitHead}, not from ${sha}, this run's commit; not tagged`);
  }

  const existing = await taggedCommit();
  if (existing !== null) return settled(existing, false);

  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const run = env.GITHUB_RUN_ID ? `${server}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : 'publish.yml';
  const object = await api('POST', '/git/tags', {
    tag,
    message: `${manifest.name} ${version}\n\nPublished to npm by ${run}\n`,
    object: sha,
    type: 'commit',
  });
  if (object.status !== 201 || !SHA.test(String(object.json?.sha).toLowerCase())) {
    fail(`creating the tag object ${tag}: HTTP ${object.status} ${object.text}`);
  }

  const ref = await api('POST', '/git/refs', { ref: `refs/tags/${tag}`, sha: object.json.sha });
  if (ref.status === 201) return settled(sha, true);
  // 422: the ref appeared between the lookup and now (a tag made by hand, a second run).
  if (ref.status === 422) {
    const found = await taggedCommit();
    if (found !== null) return settled(found, false);
  }
  fail(`creating refs/tags/${tag}: HTTP ${ref.status} ${ref.text}`);
}

main().catch((error) => {
  // fetch reports a refused connection, a reset or a timeout only in its cause
  const cause = error?.cause?.code ?? error?.cause?.message;
  const message =
    error instanceof Failure ? error.message : `unexpected: ${error?.message ?? error}${cause ? ` (${cause})` : ''}`;
  console.error(`::error::${message}`);
  process.exitCode = 1;
});
