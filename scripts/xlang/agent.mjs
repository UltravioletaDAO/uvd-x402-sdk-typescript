#!/usr/bin/env node
/**
 * Cross-language conformance AGENT — TypeScript side.
 *
 * A thin, dumb adapter: it reads ONE JSON request on stdin, calls the public
 * `uvd-x402-sdk/erc8128` API, and writes ONE JSON response on stdout. It holds
 * no expectations and asserts nothing — the driver
 * (`cross-language-conformance.mjs`) owns every comparison, so neither side can
 * grade its own homework.
 *
 * It imports the BUILT package (`dist/erc8128/index.mjs`), not `src/`: that is
 * the artefact npm publishes, and a divergence that only exists after bundling
 * is still a divergence. If `dist/` is missing the agent EXITS 1 with the fix —
 * it never degrades to source and it never reports "skipped".
 *
 * The signing key is the synthetic public test key from the F3-1 fixture
 * (a key that never held funds). No secret is read, written or printed.
 *
 * Protocol
 *   stdin   {"op":"describe"}
 *           {"op":"sign","cases":[{id,method,url,body,nonce,chainId,profile,now}]}
 *           {"op":"verify","cases":[{id,method,url,body,headers,policy,authority,now}]}
 *   stdout  {"runtime":"typescript", ...}   exit 0
 *           {"error":"…"}                   exit 1
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist', 'erc8128', 'index.mjs');

function die(message) {
  process.stdout.write(JSON.stringify({ error: message }));
  process.exit(1);
}

if (!existsSync(DIST)) {
  die(
    `the TypeScript SDK is not built: ${DIST} does not exist. ` +
      'Run `npm run build` in uvd-x402-sdk-typescript. ' +
      'This agent does NOT fall back to src/ and does NOT skip.'
  );
}

const sdk = await import(pathToFileURL(DIST).href);

const {
  CONFORMANCE_SHA256,
  CONFORMANCE_VECTORS_F3_1,
  F3_1_VECTORS_JSON,
  F3_3_VECTORS_JSON,
  POLICY_PRESETS,
  policyFromPreset,
  presetAsData,
  runConformance,
  signRequest,
  verifyRequest,
  WIRE_CONTRACT_VERSION,
} = sdk;

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** First-use-wins, per verify case. A shared store would report every case
 *  after the first as a replay, because the vectors all carry one nonce. */
function freshNonceStore() {
  const seen = new Set();
  return {
    consume(nonce, ctx) {
      const key = `erc8128:${ctx.chainId}:${ctx.wallet}:${nonce}`;
      if (seen.has(key)) return 'replayed';
      seen.add(key);
      return 'ok';
    },
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (raw += chunk));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

async function describe() {
  // The package's OWN conformance runner, reduced to the fields both languages
  // spell the same way. The driver compares these two summaries: the runners
  // read one byte-identical file, so a different `total` means one of them is
  // not checking something the other is — which is exactly how TypeScript ran
  // 62 checks against Python's 67 without anything going red.
  const report = await runConformance();
  return {
    runtime: 'typescript',
    wire_contract_version: WIRE_CONTRACT_VERSION,
    // The map the package EXPORTS…
    conformance_sha256: { ...CONFORMANCE_SHA256 },
    // …and the hash of the bytes it actually ships, computed here.
    computed_sha256: {
      'f3-1': sha256(F3_1_VECTORS_JSON),
      'f3-3': sha256(F3_3_VECTORS_JSON),
    },
    conformance: {
      ok: report.ok,
      passed: report.passed,
      total: report.total,
      failed_count: report.failed.length,
      failed: report.failed.slice(0, 5).map((f) => `${f.id}: ${f.detail ?? ''}`),
    },
    presets: Object.fromEntries(Object.keys(POLICY_PRESETS).map((n) => [n, presetAsData(n)])),
    frozen_address: CONFORMANCE_VECTORS_F3_1.frozen.address,
  };
}

async function sign(cases) {
  // Synthetic public test key from the shipped F3-1 fixture; never inlined.
  const privateKey = `0x${CONFORMANCE_VECTORS_F3_1.frozen.private_key}`;
  const results = [];
  for (const c of cases) {
    const headers = await signRequest({
      privateKey,
      method: c.method,
      url: c.url,
      body: c.body ?? null,
      nonce: c.nonce,
      chainId: c.chainId,
      profile: c.profile,
      now: () => c.now,
    });
    results.push({ id: c.id, headers });
  }
  return { runtime: 'typescript', results };
}

async function verify(cases) {
  const results = [];
  for (const c of cases) {
    const headers = {
      signature: c.headers.Signature,
      'signature-input': c.headers['Signature-Input'],
    };
    if (c.headers['Content-Digest']) headers['content-digest'] = c.headers['Content-Digest'];

    let rawBody;
    if (c.body !== null && c.body !== undefined) {
      rawBody = Buffer.from(c.body, 'utf8');
      headers['content-length'] = String(rawBody.length);
    }

    const policy = policyFromPreset(c.policy, {
      authority: c.authority,
      nonceStore: freshNonceStore(),
      now: () => c.now,
    });

    const result = await verifyRequest(
      { method: c.method, url: c.url, headers, rawBody },
      policy
    );
    results.push({
      id: c.id,
      ok: result.ok,
      code: result.code ?? null,
      // 401 or 503 — the authority rule turns on which of the two a
      // misconfiguration gets, so the driver has to be able to see it.
      status: result.status ?? null,
      wallet: result.wallet ?? null,
      observed_profile: result.observedProfile ?? null,
    });
  }
  return { runtime: 'typescript', results };
}

try {
  const request = JSON.parse(await readStdin());
  let response;
  if (request.op === 'describe') response = await describe();
  else if (request.op === 'sign') response = await sign(request.cases);
  else if (request.op === 'verify') response = await verify(request.cases);
  else die(`unknown op: ${JSON.stringify(request.op)}`);
  process.stdout.write(JSON.stringify(response));
} catch (error) {
  die(`typescript agent failed: ${error?.stack ?? String(error)}`);
}
