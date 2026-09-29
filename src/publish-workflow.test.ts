import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// publish.yml releases uvd-x402-sdk by npm trusted publishing (OIDC): no token, run by hand
// only, only from main, and every run waits for the owner's approval in the `npm` environment.
// Each of those is one YAML line away from being undone (until this test's PR the workflow
// published with a stored token on every v* tag), so this reads it and names what broke.
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

function publishWorkflowViolations(source: string): string[] {
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
    if (/always\(|cancelled\(/.test(condition(name))) violations.push(`job ${name} runs even when main is not the ref`);
  }
  return violations;
}

describe('publish.yml: trusted publishing, run by hand from main, approved by the owner', () => {
  const source = readFileSync(resolve(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8').replace(
    /\r\n/g,
    '\n'
  );

  it('keeps every rule', () => {
    expect(publishWorkflowViolations(source)).toEqual([]);
  });

  // The guard itself: each edit below is how the workflow used to publish, or a way to skip the
  // approval. If one stops being caught, the test above proves nothing.
  const mutations: Array<[string, (s: string) => string, string]> = [
    [
      'the npm token back',
      (s) =>
        s.replace(
          'run: npm publish --provenance --access public',
          'run: npm publish --provenance --access public\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'
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
  ];

  it.each(mutations)('catches %s', (_name, mutate, expected) => {
    const mutated = mutate(source);
    expect(mutated).not.toBe(source);
    expect(publishWorkflowViolations(mutated).join('\n')).toContain(expected);
  });

  it('refuses YAML it cannot read rather than passing it', () => {
    expect(() => publishWorkflowViolations(source.replace(/^on:\n/m, 'on: [push, workflow_dispatch]\n'))).toThrow(
      /flow collections/
    );
  });
});
