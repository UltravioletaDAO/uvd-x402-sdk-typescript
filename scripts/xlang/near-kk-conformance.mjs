/** Actual TS bundle / Python golden-flow conformance. No RPC, credentials or skip path. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as sdk from '../../dist/providers/near/index.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.UVD_X402_PY_ROOT ?? join(here, '../../../uvd-x402-sdk-python'));
const vectors = JSON.parse(readFileSync(join(here, '../../src/providers/near/vectors/near-kk.json'), 'utf8'));
const signer = sdk.createNearLocalSigner(Uint8Array.from({ length: 32 }, (_, i) => i));
const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);
const messages = await Promise.all(vectors.nep413.map((v) => sdk.signNep413({ signer, accountId: 'payer-demo.testnet',
  message: v.message, recipient: v.recipient, callbackUrl: v.callbackUrl ?? undefined, nonce })));
const preimages = vectors.nep413.map((v) => Buffer.from(sdk.nep413Preimage({ ...v, callbackUrl: v.callbackUrl ?? undefined, nonce })).toString('hex'));
const exact = await Promise.all(vectors.exact.map((v) => sdk.signExactNearDelegate({ ...v, signer, nonce: '7', maxBlockHeight: '100000000' })));
for (let i = 0; i < exact.length; i++) assert.equal(exact[i].payload.signedDelegateAction, vectors.exact[i].signedDelegateAction);
for (let i = 0; i < messages.length; i++) assert.equal(messages[i].signature, vectors.nep413[i].signatureBase64);
const options = { network: 'near:testnet', payerId: 'payer-demo.testnet', escrowContract: 'arras-v1b-1101.testnet' };
const storage = [sdk.buildArrasStorageDeposit(options), sdk.buildUsdcStorageDeposit(options),
  sdk.buildArrasStorageDeposit({ ...options, accountId: 'worker.testnet', deposit: '60000000000000000000000' })];
const events = sdk.parseArrasEvents(['foreign log', ...vectors.arrasEvents]);
const py = spawnSync(process.env.UVD_PYTHON ?? 'python', [join(here, 'near-kk-agent.py')], {
  input: JSON.stringify(vectors), encoding: 'utf8', timeout: 120000, windowsHide: true,
  env: { ...process.env, PYTHONPATH: [join(root, 'src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
});
if (py.error) throw py.error;
assert.equal(py.status, 0, py.stderr);
assert.deepEqual(JSON.parse(py.stdout), { messages, preimages, exact, storage, events });
console.log('NEAR golden-flow TS/PY: 3 NEP-413 preimages/signatures, 2 exact delegates, 3 storage transactions and all 11 event variants match exactly.');
