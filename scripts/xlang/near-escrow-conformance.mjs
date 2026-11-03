/** Offline TS/PY Arras conformance against actual dist/ and Python source. No skip path.
 * Requires the H-7 Python checkout with near extra installed, and npm run build here.
 * UVD_X402_PY_ROOT selects that checkout; UVD_PYTHON selects its interpreter.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as sdk from '../../dist/providers/near/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pyRoot = resolve(process.env.UVD_X402_PY_ROOT ?? join(here, '../../../uvd-x402-sdk-python'));
const raw = readFileSync(join(here, '../../src/providers/near/vectors/arras-v1.json'));
const vectors = JSON.parse(raw);
const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
const signer = sdk.createNearLocalSigner(seed);
// Delegates are signed only for registered contracts. Until NEAR_ESCROW_CONTRACTS has a mainnet row, every vector
// signs on testnet with testnet USDC; the mainnet vector keeps its own msg, preimage and payment ID.
const network = 'near:testnet';
const escrowContract = sdk.NEAR_ESCROW_CONTRACTS[network][0];
const results = [];
for (const v of vectors.payment_id.vectores) {
  const options = { network, signer, senderId: v.payer, escrowContract, nonce: '7', maxBlockHeight: '100000000' };
  const calls = [['release', { payment_id: v.payment_id }], ['release', { payment_id: v.payment_id, amount: '400000' }],
    ['refund', { payment_id: v.payment_id }], ['reclaim', { payment_id: v.payment_id }],
    ['withdraw', {}], ['withdraw_for', { account: v.receiver }]];
  results.push({ id: v.id, msg: sdk.buildEscrowMsg(v), preimage: Buffer.from(sdk.paymentIdPreimage(v)).toString('hex'),
    paymentId: sdk.computePaymentId(v),
    authorization: await sdk.signEscrowAuthorization({ ...options, token: sdk.NEAR_ESCROW_TOKENS[network], amount: v.amount, msg: v }),
    lifecycle: await Promise.all(calls.map(([method, args]) => sdk.signEscrowLifecycle(options, method, args))) });
}
assert.equal(results.flatMap((r) => [r.authorization, ...r.lifecycle]).length, 21);

// Policy parity: each case must be refused before the signer runs, in both runtimes.
const [v1, , v3] = vectors.payment_id.vectores;
const authorize = (v, net) => ({ method: 'authorize', token: v.token, amount: v.amount, msg: v, network: net, senderId: v.payer });
const cases = [
  { ...authorize(v3, 'near:mainnet'), escrowContract: 'evil-sink.near', nonce: '7', maxBlockHeight: '100000000' },
  { ...authorize(v3, 'near:mainnet'), escrowContract, nonce: '7', maxBlockHeight: '100000000' },
  { method: 'withdraw', args: {}, network: 'near:mainnet', senderId: v3.payer, escrowContract: 'arras.near', nonce: '7', maxBlockHeight: '100000000' },
  { ...authorize(v1, network), escrowContract: 'evil-sink.testnet', nonce: '7', maxBlockHeight: '100000000' },
  { method: 'withdraw', args: {}, network, senderId: v1.payer, escrowContract, nonce: '100000000', maxBlockHeight: '100' },
];
async function refused(c) {
  let calls = 0;
  const spy = { publicKey: signer.publicKey, sign: (digest) => { calls += 1; return signer.sign(digest); } };
  const options = { network: c.network, signer: spy, senderId: c.senderId, escrowContract: c.escrowContract,
    nonce: c.nonce, maxBlockHeight: c.maxBlockHeight };
  try {
    if (c.method === 'authorize') await sdk.signEscrowAuthorization({ ...options, token: c.token, amount: c.amount, msg: c.msg });
    else await sdk.signEscrowLifecycle(options, c.method, c.args);
  } catch {
    return calls === 0;
  }
  return false;
}
const refusals = [];
for (const c of cases) refusals.push(await refused(c));
assert.deepEqual(refusals, cases.map(() => true), 'TypeScript signed a case it must refuse');

const py = spawnSync(process.env.UVD_PYTHON ?? 'python', [join(here, 'near-escrow-agent.py'), pyRoot], {
  input: JSON.stringify({ vectors, cases }), encoding: 'utf8', timeout: 120_000, windowsHide: true,
  env: { ...process.env, PYTHONPATH: [join(pyRoot, 'src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
});
if (py.error) throw py.error;
assert.equal(py.status, 0, `Python Arras counterpart failed: ${py.stderr}`);
assert.deepEqual(JSON.parse(py.stdout), { results, minGas: String(sdk.NEAR_ESCROW_MIN_GAS), maxGas: String(sdk.NEAR_ESCROW_MAX_GAS),
  contracts: JSON.parse(JSON.stringify(sdk.NEAR_ESCROW_CONTRACTS)), refusals,
  fixtureHash: createHash('sha256').update(raw).digest('hex') });
console.log(`NEAR TS/PY: frozen fixture bytes, V-1..V-3 msg/preimage/payment IDs, 21 signed delegates, the contract registry and ${cases.length} pre-signature refusals match exactly.`);
