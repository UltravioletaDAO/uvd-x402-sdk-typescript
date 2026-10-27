import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// publish.yml releases uvd-x402-sdk by npm trusted publishing (OIDC): no token, run by hand
// only, only from main, and every run waits for the owner's approval in the `npm` environment.
// Each of those is one YAML line away from being undone (until this test's PR the workflow
// published with a stored token on every v* tag), so this reads it and names what broke.
// After publishing, one job tags v<version> on the published commit (scripts/tag-release.mjs,
// whose behaviour src/publish-tag.test.ts checks): that it runs only after a successful publish,
// with contents: write and nothing else, is checked here too. So is that no job runs the install
// script of a dependency, but `check` runs better-sqlite3's alone.
//
// The parser below reads only block-style YAML, the subset the workflow is written in. On
// anything else (flow collections, anchors, tags, stray indentation) it throws, so a rewrite
// it cannot read turns this suite red instead of slipping past it.

type Yaml = string | Yaml[] | { [key: string]: Yaml };
type YamlMap = { [key: string]: Yaml };

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?=\s|$)/;
const isItem = (text: string) => text === '-' || text.startsWith('- ');
const isMap = (node: Yaml | undefined): node is YamlMap =>
  typeof node === 'object' && node !== null && !Array.isArray(node);
const at = (node: Yaml | undefined, ...path: string[]): Yaml | undefined =>
  path.reduce<Yaml | undefined>((acc, key) => (isMap(acc) ? acc[key] : undefined), node);

function parseYaml(source: string): Yaml {
  const lines = source.split('\n').map((raw, n) => {
    const text = raw.trim();
    if (/^[ ]*\t/.test(raw)) throw new Error(`line ${n + 1}: tab in indentation`);
    return { indent: raw.length - raw.trimStart().length, text };
  });
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`line ${i + 1}: ${why}`);
  };
  const skipBlank = () => {
    while (i < lines.length && (lines[i].text === '' || lines[i].text.startsWith('#'))) i++;
  };
  const unquote = (s: string) =>
    s.startsWith('"') ? (JSON.parse(s) as string) : s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;

  function scalar(s: string): string {
    if (/^[[{]/.test(s)) fail('flow collections are not supported');
    if (/^[&*!]/.test(s)) fail('anchors, aliases and tags are not supported');
    const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(.*)$/.exec(s);
    if (!quoted) return s.replace(/(^|\s)#.*$/, '').trim();
    if (quoted[2].trim() !== '' && !quoted[2].trim().startsWith('#')) fail('text after a quoted scalar');
    return unquote(quoted[1]);
  }

  function node(): Yaml {
    skipBlank();
    if (i >= lines.length) fail('expected a value');
    return isItem(lines[i].text) ? sequence(lines[i].indent) : mapping(lines[i].indent);
  }

  function sequence(indent: number): Yaml[] {
    const items: Yaml[] = [];
    for (skipBlank(); i < lines.length && lines[i].indent === indent && isItem(lines[i].text); skipBlank()) {
      const rest = lines[i].text.slice(1).trimStart();
      if (rest === '') {
        i++;
        items.push(node());
      } else if (KEY.test(rest)) {
        // "- key: value" opens a mapping whose keys line up with `key`
        lines[i] = { indent: indent + lines[i].text.length - rest.length, text: rest };
        items.push(mapping(lines[i].indent));
      } else {
        items.push(scalar(rest));
        i++;
      }
    }
    if (i < lines.length && lines[i].indent > indent) fail('unexpected indentation');
    return items;
  }

  function mapping(indent: number): YamlMap {
    const map: YamlMap = {};
    for (skipBlank(); i < lines.length && lines[i].indent === indent && !isItem(lines[i].text); skipBlank()) {
      const match = KEY.exec(lines[i].text) ?? fail('expected "key: value"');
      const key = unquote(match[1]);
      if (key in map) fail(`duplicate key ${key}`);
      const rest = lines[i].text.slice(match[0].length).trim();
      const indicator = rest.replace(/(^|\s)#.*$/, '').trim();
      i++;
      if (indicator === '') {
        skipBlank();
        const next = lines[i];
        const nested = next && (next.indent > indent || (next.indent === indent && isItem(next.text)));
        map[key] = nested ? node() : '';
      } else if (/^[|>][-+]?$/.test(indicator)) {
        const body: string[] = [];
        while (i < lines.length && (lines[i].text === '' || lines[i].indent > indent)) body.push(lines[i++].text);
        map[key] = body.join('\n').trim();
      } else {
        map[key] = scalar(rest);
      }
    }
    if (i < lines.length && lines[i].indent > indent) fail('unexpected indentation');
    return map;
  }

  const root = node();
  skipBlank();
  if (i < lines.length) fail('unexpected content');
  return root;
}

const MAIN_ONLY = "github.ref == 'refs/heads/main'";

function publishWorkflowViolations(source: string, scripts: Record<string, string> = SCRIPTS): string[] {
  const violations: string[] = [];
  if (/secrets\s*[.[:]/.test(source)) violations.push('reads secrets');
  if (/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/.test(source)) violations.push('names an npm token');

  const workflow = parseYaml(source);
  const on = at(workflow, 'on');
  const triggers = isMap(on) ? Object.keys(on) : Array.isArray(on) ? on.map(String) : [String(on)];
  for (const trigger of triggers) {
    if (trigger !== 'workflow_dispatch') violations.push(`trigger ${trigger}`);
  }
  if (at(on, 'workflow_dispatch', 'inputs', 'version', 'required') !== 'true') {
    violations.push('workflow_dispatch has no required version input');
  }

  const jobs = at(workflow, 'jobs');
  if (!isMap(jobs)) return [...violations, 'no jobs'];
  const runs = (job: Yaml) => {
    const steps = at(job, 'steps');
    return Array.isArray(steps) ? steps.map((step) => String(at(step, 'run') ?? '')) : [];
  };
  const publishers = Object.keys(jobs).filter((name) => runs(jobs[name]).some((run) => /\bnpm\s+publish\b/.test(run)));
  if (publishers.length !== 1) return [...violations, `${publishers.length} jobs run npm publish, want 1`];
  const [publisher] = publishers;

  // id-token: write only where npm publish runs. write-all would grant it too, and a job with
  // no permissions of its own inherits the workflow's, so those must be spelled out.
  const grantsIdToken = (permissions: Yaml | undefined) =>
    permissions === 'write-all' || (isMap(permissions) && 'id-token' in permissions);
  const workflowPermissions = at(workflow, 'permissions');
  if (!isMap(workflowPermissions) || grantsIdToken(workflowPermissions)) {
    violations.push('workflow-level permissions are missing or grant id-token');
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (name !== publisher && grantsIdToken(at(job, 'permissions'))) violations.push(`id-token in job ${name}`);
  }
  if (at(jobs[publisher], 'permissions', 'id-token') !== 'write') {
    violations.push(`job ${publisher} lacks id-token: write`);
  }

  const environment = at(jobs[publisher], 'environment');
  if ((isMap(environment) ? environment.name : environment) !== 'npm') {
    violations.push(`job ${publisher} has no environment: npm`);
  }

  // The main-only condition sits on the publishing job or on a job it needs; a skipped need
  // skips the publish unless some `if` in the chain says always() or !cancelled().
  const chain = new Set<string>();
  const visit = (name: string) => {
    if (chain.has(name) || !isMap(jobs[name])) return;
    chain.add(name);
    const needs = at(jobs[name], 'needs');
    for (const need of Array.isArray(needs) ? needs : needs ? [needs] : []) visit(String(need));
  };
  visit(publisher);
  const condition = (name: string) =>
    String(at(jobs[name], 'if') ?? '')
      .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  if (![...chain].some((name) => condition(name) === MAIN_ONLY)) {
    violations.push(`job ${publisher} does not depend on ${MAIN_ONLY}`);
  }
  for (const name of chain) {
    if (/\b(always|cancelled)\s*\(/i.test(condition(name))) {
      violations.push(`job ${name} runs even when main is not the ref`);
    }
  }

  // In every job and step: no continue-on-error, which would let a failed npm publish count as
  // published (and be tagged) or a tag found on another commit end green; no ${{ }} inside a run,
  // so the version input reaches the shell and the tag only through env; and every checkout is
  // the run's commit (no ref), the one the tag goes on, without keeping its token on disk.
  const steps = (job: Yaml) => {
    const list = at(job, 'steps');
    return Array.isArray(list) ? list : [];
  };
  const continues = (node: Yaml) => {
    const value = at(node, 'continue-on-error');
    return value !== undefined && value !== 'false';
  };
  for (const [name, job] of Object.entries(jobs)) {
    if (continues(job) || steps(job).some(continues)) violations.push(`continue-on-error in job ${name}`);
    for (const step of steps(job)) {
      if (/\$\{\{/.test(String(at(step, 'run') ?? ''))) violations.push(`expression inside a run in job ${name}`);
      if (!String(at(step, 'uses') ?? '').startsWith('actions/checkout@')) continue;
      if (at(step, 'with', 'ref') !== undefined) violations.push(`checkout of another ref in job ${name}`);
      if (at(step, 'with', 'repository') !== undefined) {
        violations.push(`checkout of another repository in job ${name}`);
      }
      if (at(step, 'with', 'persist-credentials') !== 'false') {
        violations.push(`checkout keeps its token in job ${name}`);
      }
    }
  }

  // The tag: one job, not the publishing one, that needs it and so runs only after it succeeded,
  // and the only job that can write to the repository. A job succeeds when its steps exit 0, so
  // the publish step and the tag step run their command alone: `|| true`, a `shell:` of their own,
  // `defaults` or an `if:` on the step would let a failure (or a skip) pass for success.
  const TAG_SCRIPT = /\bnode\s+scripts\/tag-release\.mjs\b/;
  const taggers = Object.keys(jobs).filter((name) => runs(jobs[name]).some((run) => TAG_SCRIPT.test(run)));
  if (taggers.length !== 1) return [...violations, `${taggers.length} jobs run scripts/tag-release.mjs, want 1`];
  const [tagger] = taggers;
  if (tagger === publisher) violations.push(`job ${publisher} publishes and tags`);
  const tagNeeds = at(jobs[tagger], 'needs');
  if (!(Array.isArray(tagNeeds) ? tagNeeds.map(String) : [String(tagNeeds ?? '')]).includes(publisher)) {
    violations.push(`job ${tagger} does not need ${publisher}`);
  }
  // No if at all: a status function would run it after a failed publish, any other condition
  // could skip it, and a skipped job leaves the run green with no tag.
  if (at(jobs[tagger], 'if') !== undefined) violations.push(`job ${tagger} has an if`);
  const PUBLISH_RUN = 'npm publish --provenance --access public';
  const TAG_RUN = 'node scripts/tag-release.mjs';
  const publishStep = steps(jobs[publisher]).find((step) => /\bnpm\s+publish\b/.test(String(at(step, 'run') ?? '')));
  const tagStep = steps(jobs[tagger]).find((step) => TAG_SCRIPT.test(String(at(step, 'run') ?? '')));
  for (const [what, step, command] of [
    ['npm publish', publishStep, PUBLISH_RUN],
    ['tag', tagStep, TAG_RUN],
  ] as const) {
    if (at(step, 'run') !== command) violations.push(`the ${what} step runs more than ${command}`);
    if (at(step, 'shell') !== undefined) violations.push(`the ${what} step has its own shell`);
    if (at(step, 'if') !== undefined) violations.push(`the ${what} step has an if`);
  }
  for (const [where, node] of [
    ['the workflow', workflow],
    [`job ${publisher}`, jobs[publisher]],
    [`job ${tagger}`, jobs[tagger]],
  ] as const) {
    if (at(node, 'defaults') !== undefined) violations.push(`defaults in ${where}`);
  }
  // The tag step's environment is exactly its two inputs: nothing that changes how node runs
  // (NODE_OPTIONS) or where the script looks (its test-only registry knobs).
  for (const [where, node] of [
    ['the workflow', workflow],
    [`job ${tagger}`, jobs[tagger]],
  ] as const) {
    if (at(node, 'env') !== undefined) violations.push(`env in ${where}`);
  }
  // Only checkout, setup-node and the tag step: any other action in this job would get the
  // contents: write token, and any other step could change what the tag step sees.
  for (const step of steps(jobs[tagger])) {
    const uses = String(at(step, 'uses') ?? '');
    if (step !== tagStep && !uses.startsWith('actions/checkout@') && !uses.startsWith('actions/setup-node@')) {
      violations.push(`job ${tagger} has a step other than checkout, setup-node and the tag`);
    }
    if (at(step, 'if') !== undefined && step !== tagStep) violations.push(`a step in job ${tagger} has an if`);
  }
  const tagPermissions = at(jobs[tagger], 'permissions');
  if (!isMap(tagPermissions) || tagPermissions.contents !== 'write') {
    violations.push(`job ${tagger} lacks contents: write`);
  } else if (Object.keys(tagPermissions).length !== 1) {
    violations.push(`job ${tagger} has more than contents: write`);
  }
  const grantsContentsWrite = (permissions: Yaml | undefined) =>
    permissions === 'write-all' || at(permissions, 'contents') === 'write';
  if (grantsContentsWrite(workflowPermissions)) violations.push('workflow-level permissions grant contents: write');
  for (const [name, job] of Object.entries(jobs)) {
    if (name !== tagger && grantsContentsWrite(at(job, 'permissions'))) {
      violations.push(`contents: write in job ${name}`);
    }
  }
  const tagEnv = at(tagStep, 'env');
  if (
    !isMap(tagEnv) ||
    Object.keys(tagEnv).sort().join() !== 'GITHUB_TOKEN,INPUT_VERSION' ||
    tagEnv.INPUT_VERSION !== '${{ inputs.version }}' ||
    tagEnv.GITHUB_TOKEN !== '${{ github.token }}'
  ) {
    violations.push(`the tag step in job ${tagger} does not get exactly INPUT_VERSION and GITHUB_TOKEN`);
  }

  // Install scripts (SDKTS-PUBLISH-SQLITE): no dependency's preinstall, install or postinstall
  // runs, least of all in the job with id-token, except better-sqlite3's (`npm rebuild
  // better-sqlite3`, for its native binary) in `check`, which can only read. npm takes aliases,
  // abbreviations and flags anywhere, so every npm or npx command, in a run or in a package.json
  // script that one reaches, must be one of NPM_COMMANDS word for word, or `npm run <script>`.
  const allowed = (job: string, words: string[]) =>
    NPM_COMMANDS.has(words.join(' ')) ||
    (job === 'check' && words.join(' ') === REBUILD) ||
    (words.length === 3 && words[0] === 'npm' && words[1] === 'run' && Object.hasOwn(scripts, words[2]));
  const follow = (job: string, text: string, via: string, seen: Set<string>) => {
    for (const words of npmCommands(text)) {
      if (!allowed(job, words)) violations.push(`job ${job} runs ${words.join(' ')}${via}, which is not allowed`);
      for (const script of reachedScripts(words)) {
        if (scripts[script] === undefined || seen.has(script)) continue;
        seen.add(script);
        follow(job, scripts[script], ` (package.json ${script})`, seen);
      }
    }
  };
  for (const [name, job] of Object.entries(jobs)) {
    const seen = new Set<string>();
    for (const run of runs(job)) follow(name, run, '', seen);
  }
  if (/^\s*(-\s+)?run:\s*>/m.test(source)) violations.push('a folded run, which the shell reads unlike this test');
  const checkRuns = runs(jobs.check);
  const rebuildAt = checkRuns.indexOf(REBUILD);
  if (rebuildAt < 0 || rebuildAt > checkRuns.indexOf('npm run test:run')) {
    violations.push(`job check does not run ${REBUILD} before its tests`);
  }

  // Nothing that script produced reaches `publish`: no action but checkout and setup-node, no
  // setup-node cache, no outputs, and no permissions beyond the workflow's contents: read but
  // those of `publish` and `tag`.
  if (!isMap(workflowPermissions) || Object.entries(workflowPermissions).join() !== 'contents,read') {
    violations.push('workflow-level permissions are not exactly contents: read');
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (at(job, 'outputs') !== undefined) violations.push(`outputs in job ${name}`);
    if (name !== publisher && name !== tagger && at(job, 'permissions') !== undefined) {
      violations.push(`permissions in job ${name}`);
    }
    for (const step of steps(job)) {
      const uses = String(at(step, 'uses') ?? '');
      if (uses !== '' && !uses.startsWith('actions/checkout@') && !uses.startsWith('actions/setup-node@')) {
        violations.push(`job ${name} uses ${uses}`);
      }
      if (uses.startsWith('actions/setup-node@')) {
        if (at(step, 'with', 'package-manager-cache') !== 'false' || at(step, 'with', 'cache') !== undefined) {
          violations.push(`setup-node caches in job ${name}`);
        }
      }
    }
  }

  // The variable that lets src/reputation/outbox.test.ts skip without that binary is set only in
  // the job that runs npm publish, whose prepublishOnly re-runs the tests `check` ran with it.
  const mentions = (node: Yaml | undefined) => JSON.stringify(node ?? '').includes(SKIP_SQLITE);
  for (const [name, job] of Object.entries(jobs)) {
    if (name !== publisher && mentions(job)) violations.push(`${SKIP_SQLITE} in job ${name}`);
  }
  return violations;
}

const SKIP_SQLITE = 'UVD_SKIP_SQLITE_WITHOUT_BINARY';
const REBUILD = 'npm rebuild better-sqlite3';
const NPM_COMMANDS = new Set([
  'npm --version',
  'npm ci --ignore-scripts',
  'npm pack --dry-run',
  'npm publish --provenance --access public',
]);
const SCRIPTS: Record<string, string> = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')
).scripts;

// The npm and npx commands in a run, each as its words from `npm` or `npx` up to the next shell
// separator. Anything else (a comment, a trailing backslash) stays a word and fails the list.
function npmCommands(run: string): string[][] {
  return run.split(/&&|\|\||[;&|\n(){}`]/).flatMap((segment) => {
    const words = segment.trim().split(/\s+/);
    const npm = words.findIndex((word) => word === 'npm' || word === 'npx');
    return npm < 0 ? [] : [words.slice(npm)];
  });
}

// The package.json scripts an npm command runs: `npm run x` runs prex, x and postx; npm pack and
// npm publish run their lifecycle (with prepare's own pre and post).
function reachedScripts(words: string[]): string[] {
  const pack = ['prepack', 'preprepare', 'prepare', 'postprepare', 'postpack'];
  if (words[1] === 'run' && words[2]) return [`pre${words[2]}`, words[2], `post${words[2]}`];
  if (words[1] === 'pack') return pack;
  if (words[1] === 'publish') return ['prepublishOnly', ...pack, 'prepublish', 'publish', 'postpublish'];
  return [];
}

describe('publish.yml: trusted publishing, run by hand from main, approved by the owner, tagged after', () => {
  const source = readFileSync(resolve(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8').replace(
    /\r\n/g,
    '\n'
  );

  it('keeps every rule', () => {
    expect(publishWorkflowViolations(source)).toEqual([]);
  });

  // The guard itself: each edit below is how the workflow used to publish, or a way to skip the
  // approval. If one stops being caught, the test above proves nothing.
  // The install step of `check` (the first one) and of `publish`, for the edits below.
  const CHECK_CI = '      - run: npm ci --ignore-scripts\n';
  const PUBLISH_CI = /(\n  publish:\n[\s\S]*?)run: npm ci --ignore-scripts\n/;
  const mutations: Array<[string, (s: string) => string, string]> = [
    [
      'the npm token back',
      (s) =>
        s.replace(
          '    environment: npm\n',
          '    environment: npm\n    env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'
        ),
      'reads secrets',
    ],
    ['a push on v* tags', (s) => s.replace(/^on:\n/m, "on:\n  push:\n    tags:\n      - 'v*'\n"), 'trigger push'],
    ['no approval environment', (s) => s.replace('    environment: npm\n', ''), 'has no environment: npm'],
    [
      'id-token for the whole workflow',
      (s) => s.replace(/^permissions:\n/m, 'permissions:\n  id-token: write\n'),
      'grant id-token',
    ],
    ['no main-only check', (s) => s.replace(`    if: ${MAIN_ONLY}\n`, ''), `does not depend on ${MAIN_ONLY}`],
    // The tag after publishing (SDK-PUBLISH-TAG): each edit undoes one of its rules.
    ['no tag job', (s) => s.replace(/\n  tag:\n[\s\S]*$/, '\n'), '0 jobs run scripts/tag-release.mjs'],
    [
      'the tag step in the publishing job',
      (s) =>
        s
          .replace(/\n  tag:\n[\s\S]*$/, '\n')
          .replace(
            'run: npm publish --provenance --access public\n',
            'run: npm publish --provenance --access public\n\n' +
              '      - name: Tag\n        run: node scripts/tag-release.mjs\n'
          ),
      'job publish publishes and tags',
    ],
    [
      'a tag that does not wait for publish',
      (s) => s.replace('    needs: publish\n', '    needs: check\n'),
      'job tag does not need publish',
    ],
    [
      'a tag even when publish failed',
      (s) => s.replace('    needs: publish\n', '    needs: publish\n    if: ${{ !cancelled() }}\n'),
      'job tag has an if',
    ],
    [
      'a failed npm publish that passes',
      (s) =>
        s.replace(
          'run: npm publish --provenance --access public\n',
          'run: npm publish --provenance --access public\n        continue-on-error: true\n'
        ),
      'continue-on-error in job publish',
    ],
    [
      'a tag on another commit that passes',
      (s) =>
        s.replace(
          '  tag:\n    name: Tag the published version\n',
          '  tag:\n    name: Tag the published version\n    continue-on-error: true\n'
        ),
      'continue-on-error in job tag',
    ],
    [
      'a tag job that cannot write',
      (s) => s.replace('      contents: write # the tag;', '      contents: read # the tag;'),
      'job tag lacks contents: write',
    ],
    [
      'a tag job with more than contents',
      (s) => s.replace('      contents: write # the tag;', '      actions: write\n      contents: write # the tag;'),
      'job tag has more than contents: write',
    ],
    [
      'contents: write for the whole workflow',
      (s) => s.replace(/^permissions:\n  contents: read/m, 'permissions:\n  contents: write'),
      'workflow-level permissions grant contents: write',
    ],
    [
      'contents: write in the publishing job',
      (s) => s.replace('      contents: read # checkout\n', '      contents: write # checkout\n'),
      'contents: write in job publish',
    ],
    [
      'npm in the tag job',
      (s) =>
        s.replace(
          '      - name: Tag v<version> on the published commit\n',
          '      - run: npm ci\n\n      - name: Tag v<version> on the published commit\n'
        ),
      'job tag has a step other than checkout, setup-node and the tag',
    ],
    [
      'the version written into the shell',
      (s) =>
        s.replace('run: node scripts/tag-release.mjs', 'run: node scripts/tag-release.mjs "${{ inputs.version }}"'),
      'expression inside a run in job tag',
    ],
    [
      'the tag step without its token',
      (s) => s.replace('          GITHUB_TOKEN: ${{ github.token }}\n', ''),
      'does not get exactly INPUT_VERSION and GITHUB_TOKEN',
    ],
    [
      'npm publish allowed to fail',
      (s) =>
        s.replace(
          'run: npm publish --provenance --access public\n',
          'run: npm publish --provenance --access public || true\n'
        ),
      'the npm publish step runs more than npm publish --provenance --access public',
    ],
    [
      'the tag script allowed to fail',
      (s) => s.replace('run: node scripts/tag-release.mjs', 'run: node scripts/tag-release.mjs || true'),
      'the tag step runs more than node scripts/tag-release.mjs',
    ],
    [
      'a shell of its own for npm publish',
      (s) =>
        s.replace(
          'run: npm publish --provenance --access public\n',
          'run: npm publish --provenance --access public\n        shell: bash --noprofile --norc {0}\n'
        ),
      'the npm publish step has its own shell',
    ],
    [
      'a shell of its own for the tag',
      (s) => s.replace('run: node scripts/tag-release.mjs', 'run: node scripts/tag-release.mjs\n        shell: sh {0}'),
      'the tag step has its own shell',
    ],
    [
      'npm publish skipped',
      (s) => s.replace('      - name: Publish\n', '      - name: Publish\n        if: false\n'),
      'the npm publish step has an if',
    ],
    [
      'the tag step skipped',
      (s) =>
        s.replace(
          '      - name: Tag v<version> on the published commit\n',
          '      - name: Tag v<version> on the published commit\n        if: false\n'
        ),
      'the tag step has an if',
    ],
    [
      'a default shell for the workflow',
      (s) => s.replace(/^jobs:\n/m, 'defaults:\n  run:\n    shell: sh {0}\n\njobs:\n'),
      'defaults in the workflow',
    ],
    [
      'a default shell for the tag job',
      (s) =>
        s.replace(
          '    timeout-minutes: 5\n',
          '    timeout-minutes: 5\n    defaults:\n      run:\n        shell: sh {0}\n'
        ),
      'defaults in job tag',
    ],
    [
      'another action in the tag job',
      (s) =>
        s.replace(
          '      - name: Tag v<version> on the published commit\n',
          '      - uses: example/some-action@v1\n\n      - name: Tag v<version> on the published commit\n'
        ),
      'job tag has a step other than checkout, setup-node and the tag',
    ],
    [
      'a checkout skipped in the tag job',
      (s) =>
        s.replace(
          /(\n  tag:\n[\s\S]*?)      - uses: actions\/checkout@/,
          '$1      - if: false\n        uses: actions/checkout@'
        ),
      'a step in job tag has an if',
    ],
    [
      'a tag on Always (), since expressions ignore case',
      (s) => s.replace('    needs: publish\n', '    needs: publish\n    if: ${{ Always () }}\n'),
      'job tag has an if',
    ],
    [
      'a tag job skipped',
      (s) => s.replace('    needs: publish\n', "    needs: publish\n    if: github.ref == 'refs/heads/release'\n"),
      'job tag has an if',
    ],
    [
      'NODE_OPTIONS on the tag step',
      (s) =>
        s.replace(
          '          GITHUB_TOKEN: ${{ github.token }}\n',
          '          GITHUB_TOKEN: ${{ github.token }}\n          NODE_OPTIONS: --require ./x.js\n'
        ),
      'does not get exactly INPUT_VERSION and GITHUB_TOKEN',
    ],
    [
      'another registry for the tag step',
      (s) =>
        s.replace(
          '          GITHUB_TOKEN: ${{ github.token }}\n',
          '          GITHUB_TOKEN: ${{ github.token }}\n          NPM_REGISTRY_URL: http://127.0.0.1:1\n'
        ),
      'does not get exactly INPUT_VERSION and GITHUB_TOKEN',
    ],
    [
      'env for the whole tag job',
      (s) =>
        s.replace(
          '    timeout-minutes: 5\n',
          '    timeout-minutes: 5\n    env:\n      NODE_OPTIONS: --require ./x.js\n'
        ),
      'env in job tag',
    ],
    [
      'env for the whole workflow',
      (s) => s.replace(/^jobs:\n/m, 'env:\n  NODE_OPTIONS: --require ./x.js\n\njobs:\n'),
      'env in the workflow',
    ],
    [
      "a checkout of another repository's script",
      (s) => s.replace(/(\n  tag:\n[\s\S]*?persist-credentials: false\n)/, '$1          repository: someone/fork\n'),
      'checkout of another repository in job tag',
    ],
    [
      'a checkout of another ref',
      (s) => s.replace(/(\n  tag:\n[\s\S]*?persist-credentials: false\n)/, '$1          ref: main\n'),
      'checkout of another ref in job tag',
    ],
    [
      'a checkout that keeps its token',
      (s) => s.replace(/(\n  tag:\n[\s\S]*?)          persist-credentials: false\n/, '$1          fetch-depth: 1\n'),
      'checkout keeps its token in job tag',
    ],
    // Install scripts (SDKTS-PUBLISH-SQLITE): only better-sqlite3's, and only in `check`.
    [
      'install scripts back in the check job',
      (s) => s.replace('      - run: npm ci --ignore-scripts\n', '      - run: npm ci\n'),
      'job check runs npm ci, which is not allowed',
    ],
    [
      'install scripts back in the publishing job',
      (s) => s.replace(PUBLISH_CI, '$1run: npm ci\n'),
      'job publish runs npm ci, which is not allowed',
    ],
    [
      'install scripts turned back on after --ignore-scripts',
      (s) => s.replace(PUBLISH_CI, '$1run: npm ci --ignore-scripts --ignore-scripts=false\n'),
      'job publish runs npm ci --ignore-scripts --ignore-scripts=false,',
    ],
    [
      '--ignore-scripts given the value false',
      (s) => s.replace('      - run: npm ci --ignore-scripts\n', '      - run: npm ci --ignore-scripts false\n'),
      'job check runs npm ci --ignore-scripts false,',
    ],
    [
      'a flag with a value before the subcommand',
      (s) => s.replace('      - run: npm ci --ignore-scripts\n', '      - run: npm --prefix . ci\n'),
      'job check runs npm --prefix . ci,',
    ],
    [
      'a shell comment where the flag was',
      (s) => s.replace(CHECK_CI, '      - run: |\n          npm ci # was --ignore-scripts\n'),
      'job check runs npm ci # was --ignore-scripts,',
    ],
    [
      'a line continuation that adds a flag',
      (s) =>
        s.replace(PUBLISH_CI, '$1run: |\n          npm ci --ignore-scripts \\\n            --ignore-scripts=false\n'),
      'job publish runs npm ci --ignore-scripts \\,',
    ],
    [
      'a folded run',
      (s) => s.replace(CHECK_CI, '      - run: >-\n          npm ci --ignore-scripts\n'),
      'a folded run',
    ],
    [
      'an npm install in the publishing job',
      (s) => s.replace(PUBLISH_CI, '$1run: npm ci --ignore-scripts && npm i --no-save left-pad\n'),
      'job publish runs npm i --no-save left-pad,',
    ],
    ['npm update by its alias u', (s) => s.replace(PUBLISH_CI, '$1run: npm u\n'), 'job publish runs npm u,'],
    [
      'npm ci by its camelCase name',
      (s) => s.replace('      - run: npm ci --ignore-scripts\n', '      - run: npm cleanInstall --ignore-scripts\n'),
      'job check runs npm cleanInstall --ignore-scripts,',
    ],
    [
      'npx in the publishing job',
      (s) => s.replace(PUBLISH_CI, '$1run: npx --yes prebuild-install\n'),
      'job publish runs npx --yes prebuild-install,',
    ],
    [
      'every install script in the check job',
      (s) => s.replace('run: npm rebuild better-sqlite3\n', 'run: npm rebuild\n'),
      'job check runs npm rebuild, which is not allowed',
    ],
    [
      'every install script, behind a flag, in the check job',
      (s) => s.replace('run: npm rebuild better-sqlite3\n', 'run: npm --loglevel verbose rebuild\n'),
      'job check runs npm --loglevel verbose rebuild,',
    ],
    [
      "another package's install script in the check job",
      (s) => s.replace('run: npm rebuild better-sqlite3\n', 'run: npm rebuild better-sqlite3 esbuild\n'),
      'job check runs npm rebuild better-sqlite3 esbuild,',
    ],
    [
      'the rebuild in the publishing job',
      (s) => s.replace(PUBLISH_CI, '$1run: npm ci --ignore-scripts && npm rebuild better-sqlite3\n'),
      'job publish runs npm rebuild better-sqlite3,',
    ],
    [
      'the rebuild, abbreviated, in the publishing job',
      (s) => s.replace(PUBLISH_CI, '$1run: npm ci --ignore-scripts && npm reb better-sqlite3\n'),
      'job publish runs npm reb better-sqlite3,',
    ],
    [
      'the rebuild, by its alias, in the publishing job',
      (s) => s.replace(PUBLISH_CI, '$1run: npm ci --ignore-scripts && npm rb better-sqlite3\n'),
      'job publish runs npm rb better-sqlite3,',
    ],
    [
      'the rebuild in the tag job',
      (s) =>
        s.replace(
          '      - name: Tag v<version> on the published commit\n',
          '      - run: npm rebuild better-sqlite3\n\n      - name: Tag v<version> on the published commit\n'
        ),
      'job tag runs npm rebuild better-sqlite3,',
    ],
    [
      'no rebuild in the check job',
      (s) => s.replace('      - run: npm rebuild better-sqlite3\n', ''),
      'job check does not run npm rebuild better-sqlite3 before its tests',
    ],
    [
      'the rebuild after the tests',
      (s) =>
        s
          .replace('      - run: npm rebuild better-sqlite3\n', '')
          .replace('        run: npm run test:run\n', `        run: npm run test:run\n\n      - run: ${REBUILD}\n`),
      'job check does not run npm rebuild better-sqlite3 before its tests',
    ],
    // What the check job's install script produced, carried into the publishing job.
    [
      'a setup-node cache in the publishing job',
      (s) => s.replace(/( {10}registry-url: .*\n)/, '$1          cache: npm\n'),
      'setup-node caches in job publish',
    ],
    [
      'the package-manager cache on in the check job',
      (s) => s.replace('          package-manager-cache: false\n', '          package-manager-cache: true\n'),
      'setup-node caches in job check',
    ],
    [
      'node_modules saved to the cache in the check job',
      (s) =>
        s.replace(
          '      - run: npm rebuild better-sqlite3\n',
          '      - run: npm rebuild better-sqlite3\n\n' +
            '      - uses: actions/cache/save@v4\n        with:\n          path: node_modules\n          key: modules\n'
        ),
      'job check uses actions/cache/save@v4',
    ],
    [
      'an artifact downloaded into the publishing job',
      (s) =>
        s.replace(
          PUBLISH_CI,
          '$1run: npm ci --ignore-scripts\n\n' +
            '      - uses: actions/download-artifact@v4\n        with:\n          name: modules\n'
        ),
      'job publish uses actions/download-artifact@v4',
    ],
    [
      'a local action in the publishing job',
      (s) => s.replace(PUBLISH_CI, '$1uses: ./.github/actions/install\n'),
      'job publish uses ./.github/actions/install',
    ],
    [
      'actions: write in the check job',
      (s) =>
        s.replace('    timeout-minutes: 20\n', '    timeout-minutes: 20\n    permissions:\n      actions: write\n'),
      'permissions in job check',
    ],
    [
      'actions: write for the whole workflow',
      (s) => s.replace(/^permissions:\n/m, 'permissions:\n  actions: write\n'),
      'workflow-level permissions are not exactly contents: read',
    ],
    [
      'outputs from the check job',
      (s) => s.replace('    timeout-minutes: 20\n', '    timeout-minutes: 20\n    outputs:\n      modules: x\n'),
      'outputs in job check',
    ],
    [
      'the SQLite suites skipped in the check job',
      (s) =>
        s.replace(
          '      - name: Test\n',
          "      - name: Test\n        env:\n          UVD_SKIP_SQLITE_WITHOUT_BINARY: '1'\n"
        ),
      'UVD_SKIP_SQLITE_WITHOUT_BINARY in job check',
    ],
    [
      'the SQLite suites skipped inline in the check job',
      (s) => s.replace('run: npm run test:run\n', 'run: UVD_SKIP_SQLITE_WITHOUT_BINARY=1 npm run test:run\n'),
      'UVD_SKIP_SQLITE_WITHOUT_BINARY in job check',
    ],
    [
      'the SQLite suites skipped in the tag job',
      (s) =>
        s.replace(
          '          GITHUB_TOKEN: ${{ github.token }}\n',
          "          GITHUB_TOKEN: ${{ github.token }}\n          UVD_SKIP_SQLITE_WITHOUT_BINARY: '1'\n"
        ),
      'UVD_SKIP_SQLITE_WITHOUT_BINARY in job tag',
    ],
  ];

  it.each(mutations)('catches %s', (_name, mutate, expected) => {
    const mutated = mutate(source);
    expect(mutated).not.toBe(source);
    expect(publishWorkflowViolations(mutated).join('\n')).toContain(expected);
  });

  // The same rules reach the package.json scripts that the workflow's npm commands run: npm
  // publish runs prepublishOnly, which runs `npm run test:run`, which runs pretest:run first.
  const scriptMutations: Array<[string, (s: Record<string, string>) => Record<string, string>, string]> = [
    [
      'a pre hook that rebuilds, run by prepublishOnly in the publishing job',
      (s) => ({ ...s, 'pretest:run': 'npm rebuild better-sqlite3' }),
      'job publish runs npm rebuild better-sqlite3 (package.json pretest:run),',
    ],
    [
      'the rebuild inside prepublishOnly',
      (s) => ({ ...s, prepublishOnly: `npm rebuild better-sqlite3 && ${s.prepublishOnly}` }),
      'job publish runs npm rebuild better-sqlite3 (package.json prepublishOnly),',
    ],
    [
      'an install inside the test script',
      (s) => ({ ...s, 'test:run': `npm i && ${s['test:run']}` }),
      'job check runs npm i (package.json test:run),',
    ],
    [
      'a prepare that installs, run by npm publish',
      (s) => ({ ...s, prepare: 'npm ci' }),
      'job publish runs npm ci (package.json prepare),',
    ],
    [
      'npx in a prepack, run by npm pack',
      (s) => ({ ...s, prepack: 'npx --yes prebuild-install' }),
      'job check runs npx --yes prebuild-install (package.json prepack),',
    ],
  ];

  it.each(scriptMutations)('catches %s', (_name, mutate, expected) => {
    expect(publishWorkflowViolations(source, mutate(SCRIPTS)).join('\n')).toContain(expected);
  });

  it('refuses YAML it cannot read rather than passing it', () => {
    expect(() => publishWorkflowViolations(source.replace(/^on:\n/m, 'on: [push, workflow_dispatch]\n'))).toThrow(
      /flow collections/
    );
  });

  // `npm ci` installs the tarball the lock names only if it matches the lock's integrity, and
  // `npm rebuild better-sqlite3` then runs the script of that tarball: the lock is what fixes it.
  it('the better-sqlite3 that check rebuilds is one exact version, from the registry, by integrity', () => {
    const root = resolve(__dirname, '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
    const version = pkg.devDependencies['better-sqlite3'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(lock.packages).filter((path) => path.endsWith('node_modules/better-sqlite3'))).toEqual([
      'node_modules/better-sqlite3',
    ]);
    const entry = lock.packages['node_modules/better-sqlite3'];
    expect(entry.version).toBe(version);
    expect(entry.resolved).toBe(`https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-${version}.tgz`);
    expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  // The other places that could set it for every run: ci.yml, package.json, a vitest config.
  it('nothing outside the publishing job skips the SQLite suites', () => {
    const root = resolve(__dirname, '..');
    const configs = readdirSync(root).filter((file) => /^vite(st)?\.(config|workspace)\./.test(file));
    for (const file of ['.github/workflows/ci.yml', 'package.json', ...configs]) {
      expect(readFileSync(resolve(root, file), 'utf8'), file).not.toContain(SKIP_SQLITE);
    }
  });
});
