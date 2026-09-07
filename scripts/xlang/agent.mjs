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
 *           {"op":"build_envelope","cases":[{id,marker,scheme,payloadNetwork,
 *                                            requirementsNetwork,pin,payload,requirements,
 *                                            payloadV2?}]}
 *           {"op":"price_network","cases":[{id,network,amount,payTo}]}
 *           {"op":"sign_lifecycle","cases":[{id,action,paymentInfo,payer,amount,
 *                                            chainId,deadline,nonce,privateKey}]}
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
// The envelope builders live in the package ROOT, not in the erc8128 subpath.
const ROOT_DIST = join(HERE, '..', '..', 'dist', 'index.mjs');

function die(message) {
  process.stdout.write(JSON.stringify({ error: message }));
  process.exit(1);
}

for (const artefact of [DIST, ROOT_DIST]) {
  if (!existsSync(artefact)) {
    die(
      `the TypeScript SDK is not built: ${artefact} does not exist. ` +
        'Run `npm run build` in uvd-x402-sdk-typescript. ' +
        'This agent does NOT fall back to src/ and does NOT skip.'
    );
  }
}

const sdk = await import(pathToFileURL(DIST).href);
const root = await import(pathToFileURL(ROOT_DIST).href);

const {
  buildLifecycleAuth,
  buildPaymentRequirements,
  buildSettleRequestForVersion,
  buildVerifyRequestForVersion,
  resolveEnvelopeVersion,
} = root;

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

/**
 * Build the /verify and /settle bodies this wire has to travel in.
 *
 * The driver supplies EVERY field -- payload, requirements, the two networks,
 * the payer's marker, the pin -- so neither SDK gets to fall back on a default
 * the other one does not share. All this agent does is call the public
 * selection API and hand back what came out.
 *
 * A throw is a RESULT, not a crash: `pin: 2` on a network with no CAIP-2 form
 * has to fail, and whether the two SDKs fail on the same wires is exactly the
 * kind of divergence this phase exists to catch.
 *
 * `payloadV2` is passed through UNTOUCHED when the driver sends one. That shape
 * -- `{x402Version, resource, accepted, payload}`, with no top-level `network`
 * at all -- is what a buyer following a v2 402 actually produces, and building
 * it here out of the flat fields would be this agent inventing the very thing
 * under test.
 */
async function buildEnvelope(cases) {
  const results = [];
  for (const c of cases) {
    const paymentHeader = c.payloadV2 ?? {
      x402Version: c.marker,
      scheme: c.scheme,
      network: c.payloadNetwork,
      payload: c.payload,
    };
    const requirements = { ...c.requirements, network: c.requirementsNetwork };
    try {
      const version = resolveEnvelopeVersion(paymentHeader, requirements, c.pin ?? 'auto');
      results.push({
        id: c.id,
        version,
        verify: buildVerifyRequestForVersion(paymentHeader, requirements, version),
        settle: buildSettleRequestForVersion(paymentHeader, requirements, version),
      });
    } catch (error) {
      results.push({ id: c.id, error: String(error?.message ?? error) });
    }
  }
  return { runtime: 'typescript', results };
}

/**
 * Turn a price written in DOLLARS into the atomic amount this SDK would put in
 * a 402, or refuse.
 *
 * Phases 1-6 are ERC-8128 signatures and x402 envelopes -- they compare how the
 * two SDKs SHAPE a request, and never once what either one would CHARGE for it.
 * That blind spot had a name: both SDKs scaled a USD price by the settlement
 * token's decimals, which is only a currency conversion when one whole unit is
 * one dollar, and XRPL settles in native XRP. `$10.00` came out as 10 XRP in
 * both languages while every check here was green.
 *
 * A refusal is a RESULT, not a crash. The two SDKs must refuse the same prices
 * and, where they do convert, produce the same integer.
 */
async function priceNetwork(cases) {
  const results = [];
  for (const c of cases) {
    try {
      const requirements = buildPaymentRequirements({
        amount: c.amount,
        recipient: c.payTo,
        resource: 'https://api.example.com/premium',
        chainName: c.network,
      });
      results.push({
        id: c.id,
        amount: String(requirements.maxAmountRequired),
        asset: requirements.asset ?? null,
      });
    } catch (error) {
      results.push({ id: c.id, error: String(error?.message ?? error) });
    }
  }
  return { runtime: 'typescript', results };
}

/**
 * Sign an escrow lifecycle order (`release` / `refundInEscrow`).
 *
 * Phases 1-7 are all ERC-8128 and pricing: not one of them touches escrow, so
 * a TypeScript that signed a DIFFERENT `LifecycleOrder` than Python would have
 * left every check here green. The order decides who may move money that is
 * already deposited, so "the two SDKs agree" has to be measured, not assumed.
 *
 * The key comes from the driver and is the synthetic 0x11*32 test key; it has
 * never held funds.
 */
/**
 * The METADATA of an EIP-712 document -- everything a signature cannot prove.
 *
 * Deliberately NOT the message values: Python signs `nonce` as bytes and
 * TypeScript as a hex string, so comparing messages across runtimes would
 * report a divergence that does not exist. What the message contains is
 * already proven identical by the signature bytes. What it CANNOT prove is
 * the envelope the signer is handed -- and viem refuses to sign a document
 * with no `primaryType`, so a missing field closes the browser route while
 * every byte-comparison stays green.
 */
function describeDocument(td) {
  if (!td || typeof td !== 'object') return null;
  return {
    keys: Object.keys(td).sort(),
    primaryType: td.primaryType ?? null,
    typeNames: Object.keys(td.types ?? {}).sort(),
    // The message travels too, and it travels THROUGH JSON -- which is the
    // point. A uint written as a JSON number instead of a string loses
    // precision the moment `JSON.parse` sees 32 bytes of salt, and the browser
    // then signs a different struct with no error anywhere. Comparing the
    // messages after they crossed the runtime boundary catches exactly that.
    message: td.message ?? null,
  };
}

async function signLifecycle(cases) {
  const { Wallet } = await import('ethers');
  const results = [];
  for (const c of cases) {
    try {
      const wallet = new Wallet(c.privateKey);
      // The document the SDK hands the wallet, captured verbatim. `primaryType`
      // does NOT enter the digest, so a signature comparison cannot see it --
      // and that is exactly how Python shipped without the field while this
      // gate stayed green (2026-09-07). The shape travels alongside the bytes.
      let handed = null;
      const signer = {
        getAddress: () => wallet.address,
        async signTypedData(typedData) {
          const parsed = JSON.parse(typedData);
          handed = parsed;
          const { domain, types, message } = parsed;
          const clean = { ...types };
          delete clean['EIP712Domain'];
          return { signature: await wallet.signTypedData(domain, clean, message) };
        },
      };
      const auth = await buildLifecycleAuth({
        action: c.action,
        paymentInfo: c.paymentInfo,
        payer: c.payer,
        amount: c.amount,
        chainId: c.chainId,
        wallet: signer,
        deadline: c.deadline,
        nonce: c.nonce,
        now: c.now,
      });
      results.push({ id: c.id, ...auth, document: describeDocument(handed) });
    } catch (error) {
      results.push({ id: c.id, error: String(error?.message ?? error) });
    }
  }
  return { runtime: 'typescript', results };
}

try {
  const request = JSON.parse(await readStdin());
  let response;
  if (request.op === 'describe') response = await describe();
  else if (request.op === 'sign') response = await sign(request.cases);
  else if (request.op === 'verify') response = await verify(request.cases);
  else if (request.op === 'build_envelope') response = await buildEnvelope(request.cases);
  else if (request.op === 'price_network') response = await priceNetwork(request.cases);
  else if (request.op === 'sign_lifecycle') response = await signLifecycle(request.cases);
  else die(`unknown op: ${JSON.stringify(request.op)}`);
  process.stdout.write(JSON.stringify(response));
} catch (error) {
  die(`typescript agent failed: ${error?.stack ?? String(error)}`);
}
