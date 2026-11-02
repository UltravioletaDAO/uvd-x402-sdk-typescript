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
const results = [];
const signer = sdk.createNearLocalSigner(Uint8Array.from({ length: 32 }, (_, i) => i));
for (const v of vectors.payment_id.vectores) {
  const network = v.token === sdk.NEAR_ESCROW_TOKENS['near:mainnet'] ? 'near:mainnet' : 'near:testnet';
  const options = { network, signer, senderId: v.payer,
    escrowContract: network === 'near:mainnet' ? 'arras.near' : 'arras.testnet', nonce: '7', maxBlockHeight: '100000000' };
  const calls = [['release', { payment_id: v.payment_id }], ['release', { payment_id: v.payment_id, amount: '400000' }],
    ['refund', { payment_id: v.payment_id }], ['reclaim', { payment_id: v.payment_id }],
    ['withdraw', {}], ['withdraw_for', { account: v.receiver }]];
  results.push({ id: v.id, msg: sdk.buildEscrowMsg(v), preimage: Buffer.from(sdk.paymentIdPreimage(v)).toString('hex'),
    paymentId: sdk.computePaymentId(v), authorization: await sdk.signEscrowAuthorization({ ...options, token: v.token, amount: v.amount, msg: v }),
    lifecycle: await Promise.all(calls.map(([method, args]) => sdk.signEscrowLifecycle(options, method, args))) });
}
const py = spawnSync(process.env.UVD_PYTHON ?? 'python', [join(here, 'near-escrow-agent.py'), pyRoot], {
  input: raw, encoding: 'utf8', timeout: 120_000, windowsHide: true,
  env: { ...process.env, PYTHONPATH: [join(pyRoot, 'src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
});
if (py.error) throw py.error;
assert.equal(py.status, 0, `Python Arras counterpart failed: ${py.stderr}`);
assert.deepEqual(JSON.parse(py.stdout), { results, minGas: String(sdk.NEAR_ESCROW_MIN_GAS), maxGas: String(sdk.NEAR_ESCROW_MAX_GAS),
  fixtureHash: createHash('sha256').update(raw).digest('hex') });
console.log('NEAR TS/PY: frozen fixture bytes, V-1..V-3 msg/preimage/payment IDs and 21 signed delegates match exactly.');
