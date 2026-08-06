#!/usr/bin/env node
/**
 * THE CROSS-LANGUAGE CONFORMANCE TEST.
 *
 * The problem it exists to solve: both SDK suites were green while the two
 * implementations diverged, because each suite validated an implementation
 * against vectors that the SAME implementation had generated. Self-referential.
 * This run is not: it spawns BOTH runtimes and makes each one verify what the
 * OTHER one just signed. Nothing here compares stored strings to stored
 * strings — every signature in phase 3 and 4 is produced live, in one process,
 * and consumed live, in the other.
 *
 * Five phases, in dependency order:
 *   1. ARTEFACT      both runtimes hash the vector document they ship; the two
 *                    hashes and the two CONFORMANCE_SHA256 maps must be equal,
 *                    key for key. (This is the check the spec asked for and
 *                    that `f3_1` vs `f3-1` made unpassable.) Each package's
 *                    OWN conformance runner is also run here and the two
 *                    summaries compared — same verdict AND same number of
 *                    checks, because 62-vs-67 off one file meant "conformance
 *                    passed" said two different things.
 *   2. POSTURE       `presetAsData(n)` === `preset_as_data(n)` === the shipped
 *                    `policies` block, for every preset.
 *   3. TS → PY       TypeScript signs every request in both wire profiles;
 *                    Python verifies. Bytes must also match the pinned vector.
 *   4. PY → TS       the same, the other way round.
 *   5. MATRIX        the shipped `verify_cases` matrix, run through BOTH
 *                    verifiers: same verdict, same error code, same observed
 *                    profile, or the run fails.
 *
 * NO SKIPS. If the other runtime is missing, unbuilt or uninstallable, this
 * exits 1 with the fix printed. A "cross-language check" that quietly passes
 * when the other language is absent is the exact failure mode being fixed
 * (see execution-market's `test_erc8128_canonical_parity.py`, whose
 * byte-equality assertions never ran outside the monorepo).
 *
 * Usage:  node scripts/xlang/cross-language-conformance.mjs
 * Env:    UVD_PYTHON            python executable (default: python3, then python)
 *         UVD_X402_PY_ROOT      python SDK checkout (default ../uvd-x402-sdk-python)
 *                               its src/ is prepended to PYTHONPATH
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(HERE, '..', '..'));
const NODE_AGENT = join(HERE, 'agent.mjs');
const PY_AGENT = join(HERE, 'agent.py');
const PY_ROOT = resolve(process.env.UVD_X402_PY_ROOT ?? join(REPO, '..', 'uvd-x402-sdk-python'));

const failures = [];
let checked = 0;
function check(ok, label, detail) {
  checked += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(detail ? `${label}: ${detail}` : label);
  }
}

function fatal(message) {
  console.error('\n╳ CROSS-LANGUAGE CONFORMANCE COULD NOT RUN\n');
  console.error(message);
  console.error('\nThis is a FAILURE, not a skip: an unavailable runtime means');
  console.error('the two implementations are unchecked against each other.\n');
  process.exit(1);
}

function run(command, args, { input, env } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => resolveRun({ spawnError: error, stdout, stderr, code: -1 }));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/** Resolve a python executable, or die saying so. */
async function resolvePython() {
  const candidates = process.env.UVD_PYTHON
    ? [process.env.UVD_PYTHON]
    : ['python3', 'python', 'py'];
  for (const exe of candidates) {
    const probe = await run(exe, ['-c', 'import sys; print(sys.version.split()[0])']);
    if (!probe.spawnError && probe.code === 0) return { exe, version: probe.stdout.trim() };
  }
  fatal(
    `no Python interpreter found (tried ${candidates.join(', ')}).\n` +
      'Fix: install Python 3.9+ or set UVD_PYTHON=/path/to/python.'
  );
}

async function ask(runtime, payload) {
  const request = JSON.stringify(payload);
  const result =
    runtime.kind === 'node'
      ? await run(process.execPath, [NODE_AGENT], { input: request })
      : await run(runtime.exe, [PY_AGENT], {
          input: request,
          env: {
            PYTHONPATH: [join(PY_ROOT, 'src'), process.env.PYTHONPATH]
              .filter(Boolean)
              .join(process.platform === 'win32' ? ';' : ':'),
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
          },
        });

  if (result.spawnError) {
    fatal(`could not spawn the ${runtime.kind} agent: ${result.spawnError.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fatal(
      `the ${runtime.kind} agent produced no parseable JSON (exit ${result.code}).\n` +
        `stdout: ${result.stdout.slice(0, 4000)}\nstderr: ${result.stderr.slice(0, 4000)}`
    );
  }
  if (parsed.error) {
    fatal(`the ${runtime.kind} agent refused to run:\n${parsed.error}\n${result.stderr}`);
  }
  if (result.code !== 0) {
    fatal(`the ${runtime.kind} agent exited ${result.code}\nstderr: ${result.stderr}`);
  }
  return parsed;
}

/**
 * Deep equality that is INSENSITIVE to object key order and SENSITIVE to array
 * order. A header set is a map, not a sequence: Python's `sign_request` returns
 * `Content-Digest` first and TypeScript's returns it last, and no verifier on
 * earth can tell. Comparing raw `JSON.stringify` output would report that as a
 * cross-language divergence and train everyone to ignore this run. Array order
 * IS kept, because `verify_cases` and `allowed_chain_ids` are sequences.
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}
const eq = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** Read a shipped vector document as BYTES and decode UTF-8 explicitly, so a
 *  non-ASCII path (`utf8_path`) survives a non-UTF-8 default locale. */
function readVectors(name) {
  return JSON.parse(readFileSync(join(REPO, 'src', 'erc8128', name)).toString('utf8'));
}

// ── preflight ──────────────────────────────────────────────────────────────
if (!existsSync(join(REPO, 'dist', 'erc8128', 'index.mjs'))) {
  fatal(
    'the TypeScript SDK is not built.\nFix: npm run build   (in ' + REPO + ')'
  );
}
if (!existsSync(join(PY_ROOT, 'src', 'uvd_x402_sdk', 'erc8128'))) {
  fatal(
    `the Python SDK checkout is not at ${PY_ROOT}.\n` +
      'Fix: clone UltravioletaDAO/uvd-x402-sdk-python beside this repo, or set\n' +
      '     UVD_X402_PY_ROOT=/path/to/uvd-x402-sdk-python'
  );
}

const python = await resolvePython();
const NODE = { kind: 'node' };
const PY = { kind: 'python', exe: python.exe };

console.log('ERC-8128 cross-language conformance');
console.log(`  node   ${process.version}  (${REPO})`);
console.log(`  python ${python.version} via ${python.exe}  (${PY_ROOT})\n`);

const tsInfo = await ask(NODE, { op: 'describe' });
const pyInfo = await ask(PY, { op: 'describe' });

// ── phase 1 · the artefact ─────────────────────────────────────────────────
console.log('phase 1 · one artefact, two packages');
check(
  eq(tsInfo.conformance_sha256, pyInfo.conformance_sha256),
  'CONFORMANCE_SHA256 is identical, key for key',
  `ts=${JSON.stringify(tsInfo.conformance_sha256)} py=${JSON.stringify(pyInfo.conformance_sha256)}`
);
check(
  eq(tsInfo.computed_sha256, pyInfo.computed_sha256),
  'the shipped vector BYTES hash the same in both packages',
  `ts=${JSON.stringify(tsInfo.computed_sha256)} py=${JSON.stringify(pyInfo.computed_sha256)}`
);
check(
  eq(tsInfo.computed_sha256, tsInfo.conformance_sha256),
  'typescript: shipped bytes match its own pinned map'
);
check(
  eq(pyInfo.computed_sha256, pyInfo.conformance_sha256),
  'python: shipped bytes match its own pinned map'
);
check(
  tsInfo.wire_contract_version === pyInfo.wire_contract_version,
  'both report the same WIRE_CONTRACT_VERSION',
  `ts=${tsInfo.wire_contract_version} py=${pyInfo.wire_contract_version}`
);

// The two packages' OWN conformance runners, over the one artefact. They used
// to report 62 and 67 checks off the same bytes — Python had an integrity
// section (vector hashes + pinned presets) that TypeScript did not — so
// "conformance passed" meant two different things and the weaker one was
// nobody's job to notice. The counts are compared here, not just the verdicts.
check(
  tsInfo.conformance.ok === true,
  "typescript's own runConformance() is green",
  `passed=${tsInfo.conformance.passed}/${tsInfo.conformance.total} failed=${JSON.stringify(tsInfo.conformance.failed)}`
);
check(
  pyInfo.conformance.ok === true,
  "python's own run_conformance() is green",
  `passed=${pyInfo.conformance.passed}/${pyInfo.conformance.total} failed=${JSON.stringify(pyInfo.conformance.failed)}`
);
check(
  tsInfo.conformance.total === pyInfo.conformance.total &&
    tsInfo.conformance.passed === pyInfo.conformance.passed,
  'both runners check the SAME NUMBER of things from the same file',
  `ts=${tsInfo.conformance.passed}/${tsInfo.conformance.total} py=${pyInfo.conformance.passed}/${pyInfo.conformance.total}`
);

// ── phase 2 · the postures ─────────────────────────────────────────────────
console.log('\nphase 2 · the postures, as data');
const f3_3 = readVectors('erc8128.f3-3.json');
const presetNames = Object.keys(f3_3.policies);
check(
  eq(Object.keys(tsInfo.presets).sort(), presetNames.slice().sort()),
  'both runtimes expose exactly the presets the vectors pin'
);
for (const name of presetNames) {
  check(
    eq(tsInfo.presets[name], pyInfo.presets[name]),
    `preset ${name}: typescript === python`,
    `ts=${JSON.stringify(tsInfo.presets[name])} py=${JSON.stringify(pyInfo.presets[name])}`
  );
  check(
    eq(tsInfo.presets[name], f3_3.policies[name]),
    `preset ${name}: typescript === shipped policies block`,
    `runtime=${JSON.stringify(tsInfo.presets[name])} pinned=${JSON.stringify(f3_3.policies[name])}`
  );
  check(
    eq(pyInfo.presets[name], f3_3.policies[name]),
    `preset ${name}: python === shipped policies block`,
    `runtime=${JSON.stringify(pyInfo.presets[name])} pinned=${JSON.stringify(f3_3.policies[name])}`
  );
}

// ── the signing work list ──────────────────────────────────────────────────
const FROZEN = f3_3.frozen;
const AUTHORITY = FROZEN.authority;
const NOW = FROZEN.created;
const VERIFY_AT = FROZEN.created + 1;

const f3_1 = readVectors('erc8128.f3-1.json');
const ALL_REQUESTS = { ...f3_1.requests, ...f3_3.requests };
const ALL_VECTORS = {};
for (const doc of [f3_1, f3_3]) {
  for (const [family, cases] of Object.entries(doc.vectors)) {
    for (const [name, vector] of Object.entries(cases)) ALL_VECTORS[`${family}/${name}`] = vector;
  }
}

/**
 * The `@authority` a URL derives, per RFC 9421 §2.2.3 — lowercased, with the
 * default port of THAT SCHEME dropped and any other port kept.
 *
 * Reimplemented here rather than imported: this driver is the referee, and a
 * referee that borrows the rule from one of the players cannot see that player
 * get it wrong. Six of the pinned requests exist precisely to separate this
 * rule from the scheme-blind "drop :443 and :80 always" one.
 */
const DEFAULT_PORTS = { http: '80', https: '443', ws: '80', wss: '443' };
function derivedAuthority(url) {
  const absolute = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  if (!absolute) return undefined;
  const lower = absolute[2].toLowerCase();
  const portAt = lower.lastIndexOf(':');
  // `lastIndexOf(']')` keeps an IPv6 literal's own colons from reading as a port.
  const port = portAt > lower.lastIndexOf(']') ? lower.slice(portAt + 1) : undefined;
  return port !== undefined && port === DEFAULT_PORTS[absolute[1].toLowerCase()]
    ? lower.slice(0, portAt)
    : lower;
}

/**
 * Whether that derived authority is one an operator may CONFIGURE.
 *
 * `https` on `:80` signs `host:80` and `http` on `:443` signs `host:443` — both
 * legitimate, both ordinary ports for their scheme. But a CONFIGURED authority
 * carrying a default port of either scheme is refused (503 `authority_invalid`)
 * because the configured value is the expected OUTPUT of the rule above and
 * silently re-normalising it under a scheme it does not carry is the bug being
 * removed. So those two deployments verify to a 503, in BOTH runtimes, and that
 * agreement is itself worth checking.
 */
function configurable(authority) {
  const portAt = authority.lastIndexOf(':');
  if (portAt <= authority.lastIndexOf(']')) return true;
  const port = authority.slice(portAt + 1);
  return port !== '443' && port !== '80';
}

/** Every request × every EMITTABLE profile. The checksummed-keyid family is
 *  verify-only (both signers lowercase the keyid on purpose). */
const SIGN_CASES = [];
for (const [name, spec] of Object.entries(ALL_REQUESTS)) {
  for (const [family, profile] of [
    ['canonical', 'canonical'],
    ['legacy_no_alg', 'legacy-no-alg'],
  ]) {
    SIGN_CASES.push({
      id: `${family}/${name}`,
      method: spec.method,
      url: spec.url,
      body: spec.body,
      nonce: FROZEN.nonce,
      chainId: FROZEN.chain_id,
      profile,
      now: NOW,
      // The authority the verifier is CONFIGURED with for this request. It is
      // per-case because six of these requests sign a different one — a
      // single hard-coded value made every cross-verified case run against a
      // plain lowercase host, which is why no authority regression could show
      // up here.
      authority: derivedAuthority(spec.url) ?? AUTHORITY,
    });
  }
}

/** The posture each freshly-signed request is verified under. `em-lenient`
 *  accepts both wire profiles and every request shape, so a rejection here is
 *  a real cross-language disagreement and not a policy choice. */
const CROSS_POLICY = 'em-lenient';

async function crossCheck(signer, verifier, label) {
  console.log(`\n${label}`);
  const signed = await ask(signer.runtime, { op: 'sign', cases: SIGN_CASES });
  const byId = Object.fromEntries(signed.results.map((r) => [r.id, r.headers]));

  // The freshly produced bytes must also equal the pinned vector: that is what
  // ties this live run back to the one shared artefact.
  for (const c of SIGN_CASES) {
    check(
      eq(byId[c.id], ALL_VECTORS[c.id].headers),
      `${signer.name} signed ${c.id} to the pinned bytes`,
      `got=${JSON.stringify(byId[c.id])} pinned=${JSON.stringify(ALL_VECTORS[c.id].headers)}`
    );
  }

  const verifyCases = SIGN_CASES.map((c) => ({
    id: c.id,
    method: c.method,
    url: c.url,
    body: c.body,
    headers: byId[c.id],
    policy: CROSS_POLICY,
    authority: c.authority,
    now: VERIFY_AT,
  }));
  const verified = await ask(verifier.runtime, { op: 'verify', cases: verifyCases });

  const byCaseId = Object.fromEntries(SIGN_CASES.map((c) => [c.id, c]));
  for (const result of verified.results) {
    const expectedProfile = result.id.split('/')[0];
    const { authority } = byCaseId[result.id];
    if (configurable(authority)) {
      check(
        result.ok === true &&
          result.wallet === FROZEN.address &&
          result.observed_profile === expectedProfile,
        `${verifier.name} verified ${signer.name}'s ${result.id} @ ${authority}`,
        `ok=${result.ok} code=${result.code} wallet=${result.wallet} profile=${result.observed_profile}`
      );
    } else {
      // The deployment signs `host:80` under https (or `host:443` under http)
      // and therefore CANNOT be configured: both runtimes must refuse the
      // config with the same code and the same 503, rather than one of them
      // quietly stripping the port and accepting.
      check(
        result.ok === false && result.code === 'authority_invalid' && result.status === 503,
        `${verifier.name} refuses ${signer.name}'s ${result.id} config ${authority} with 503`,
        `ok=${result.ok} code=${result.code} status=${result.status}`
      );
    }
  }
}

const NODE_RT = { runtime: NODE, name: 'typescript' };
const PY_RT = { runtime: PY, name: 'python' };

// ── phase 3 · TypeScript signs, Python verifies ────────────────────────────
await crossCheck(NODE_RT, PY_RT, 'phase 3 · TypeScript signs → Python verifies');

// ── phase 4 · Python signs, TypeScript verifies ────────────────────────────
await crossCheck(PY_RT, NODE_RT, 'phase 4 · Python signs → TypeScript verifies');

// ── phase 5 · the shipped verify matrix, through BOTH verifiers ────────────
console.log('\nphase 5 · the shipped verify_cases matrix, through both verifiers');
const matrixCases = f3_3.verify_cases.map((c, index) => {
  const requestName = c.vector_id.split('/')[1];
  const spec = ALL_REQUESTS[requestName];
  return {
    id: `${index}:${c.vector_id}|${c.policy}`,
    method: spec.method,
    url: spec.url,
    body: spec.body,
    headers: ALL_VECTORS[c.vector_id].headers,
    policy: c.policy,
    // The CONFIGURED authority. A case that names one is testing R2 — what an
    // operator may write in `VerifyPolicy.authority` — and the rest run
    // against the value the fleet actually deploys. Ignoring this field is how
    // a matrix full of authority cases could still run every one of them
    // against the same well-formed string.
    authority: c.authority ?? AUTHORITY,
    now: VERIFY_AT,
    _expected: c,
  };
});
const stripped = matrixCases.map(({ _expected, ...rest }) => rest);
const tsMatrix = await ask(NODE, { op: 'verify', cases: stripped });
const pyMatrix = await ask(PY, { op: 'verify', cases: stripped });

/**
 * Fields the shared artefact PINS, and which therefore must agree or the build
 * breaks. On an accept that includes the wallet; on a reject the matrix pins
 * `code`, the HTTP `status` and `observed_profile`, and says nothing about the
 * rest. `status` is pinned because 401-vs-503 is the whole distinction the
 * authority rule turns on: a config typo answered 401 blames a client that
 * cannot see, let alone fix, it.
 */
const PINNED_FIELDS = (expect) =>
  expect === 'accept'
    ? ['ok', 'wallet', 'observed_profile']
    : ['ok', 'code', 'status', 'observed_profile'];

/**
 * The RATCHET. Fields the two runtimes are KNOWN to disagree on today, outside
 * anything the artefact pins. Listed one by one, with the decision each one is
 * waiting for. A divergence that is NOT on this list fails the build; that is
 * how a future drift gets caught without this run silently blessing today's.
 *
 * - `wallet` on a REJECT: Python's failure result carries the wallet, chain id,
 *   keyid and label parsed out of `Signature-Input`; TypeScript's carries only
 *   `observedProfile`. Both are deliberate (verifier.py:385-396,
 *   verifier.ts:518-527) and they are opposite calls about whether a failed
 *   verification may hand back an UNVERIFIED identity claim in the same field
 *   that means "authenticated wallet" on success. OWNER DECISION — it is a
 *   security contract, not a formatting detail, and changing either side is a
 *   behaviour change for live verifiers that log or rate-limit on it. Once
 *   decided, pin it in the artefact and delete this entry.
 */
// Empty on purpose. 'reject:wallet' lived here until it turned out not to be a
// reporting difference: Python was returning the client-declared keyid address
// in a rejected result's `wallet` field, where no check had confirmed it. That
// is fixed in the verifier, not tolerated here.
const KNOWN_UNPINNED = new Set([]);
const seenUnpinned = new Set();

for (let i = 0; i < matrixCases.length; i += 1) {
  const expected = matrixCases[i]._expected;
  const a = tsMatrix.results[i];
  const b = pyMatrix.results[i];
  // The authority is part of the identity of a case: several rows reuse one
  // (vector, policy) pair and differ ONLY in what the policy was configured
  // with, so a label without it names two different checks the same way.
  const configured =
    expected.authority === undefined ? '' : ` @ ${JSON.stringify(expected.authority)}`;
  const label = `${expected.vector_id} | ${expected.policy}${configured} → ${expected.expect}`;
  const pinned = PINNED_FIELDS(expected.expect);

  const pick = (r) => Object.fromEntries(pinned.map((f) => [f, r[f] ?? null]));
  check(
    eq(pick(a), pick(b)),
    `both verifiers agree on ${label}`,
    `ts=${JSON.stringify(pick(a))} py=${JSON.stringify(pick(b))}`
  );

  const wantOk = expected.expect === 'accept';
  const matchesPin =
    a.ok === wantOk &&
    (a.observed_profile ?? null) === (expected.observed_profile ?? null) &&
    (wantOk
      ? a.wallet === expected.wallet
      : a.code === expected.code &&
        (expected.status === undefined || a.status === expected.status));
  check(matchesPin, `the pinned verdict holds for ${label}`, `got=${JSON.stringify(a)}`);

  // Everything the artefact does NOT pin still has to be accounted for.
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (field === 'id' || pinned.includes(field)) continue;
    if ((a[field] ?? null) === (b[field] ?? null)) continue;
    const key = `${expected.expect}:${field}`;
    seenUnpinned.add(key);
    check(
      KNOWN_UNPINNED.has(key),
      `divergence on ${label} field '${field}' is a DECLARED one`,
      `ts=${JSON.stringify(a[field] ?? null)} py=${JSON.stringify(b[field] ?? null)} — ` +
        `add '${key}' to KNOWN_UNPINNED with the decision it needs, or fix it`
    );
  }
}

for (const key of KNOWN_UNPINNED) {
  if (!seenUnpinned.has(key)) {
    console.log(
      `  note  known divergence '${key}' no longer reproduces — delete it from KNOWN_UNPINNED`
    );
  }
}
if (seenUnpinned.size) {
  console.log(
    `\n  ⚠ ${seenUnpinned.size} declared divergence(s) outside what the artefact pins: ` +
      `${[...seenUnpinned].join(', ')} — see KNOWN_UNPINNED for the decision each is waiting on.`
  );
}

// ── report ─────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────');
if (failures.length) {
  console.error(`CROSS-LANGUAGE CONFORMANCE FAILED — ${failures.length} check(s):\n`);
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exit(1);
}
console.log(
  `CROSS-LANGUAGE CONFORMANCE PASSED — ${checked} checks across 5 phases.\n` +
    `  ${SIGN_CASES.length} signatures produced live by TypeScript and verified live by Python,\n` +
    `  ${SIGN_CASES.length} produced live by Python and verified live by TypeScript,\n` +
    `  ${f3_3.verify_cases.length} matrix verdicts compared verifier to verifier.\n` +
    '  Nothing here was a stored-string comparison; both runtimes were invoked.'
);
