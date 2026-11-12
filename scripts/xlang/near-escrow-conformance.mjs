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
// arras docs/vectores.json at 9f8332f: V-1..V-3 of arras-v1.json, plus the v2 msgs and tickets T-1 and T-2.
const raw = readFileSync(join(here, '../../src/providers/near/vectors/arras-v2.json'));
const vectors = JSON.parse(raw);
const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
const signer = sdk.createNearLocalSigner(seed);
// Delegates are signed only for registered contracts. This runner keeps every vector on testnet and
// uses testnet USDC; the mainnet vector keeps its own msg, preimage and payment ID.
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

// Arras v2: the ticket bytes and signatures with the vector key, the canonical v2 msgs and one v2 authorization.
const ticketVectors = vectors.v2.operator_ticket;
const ticketKey = ticketVectors.llave_de_prueba;
const operator = sdk.createNearLocalSigner(Uint8Array.from(Buffer.from(ticketKey.semilla_hex, 'hex')));
const tickets = [];
for (const t of ticketVectors.vectores) {
  const ticket = await sdk.signOperatorTicket({ signer: operator, contract: t.contract, subject: t.subject, expiry: t.expiry, now: 0n });
  const check = (now) => sdk.checkOperatorTicket({ ticketPubkey: ticketKey.ticket_pubkey, contract: t.contract, subject: t.subject, ticket, now });
  tickets.push({ id: t.id, message: Buffer.from(sdk.operatorTicketMessage(t.contract, t.subject, t.expiry)).toString('hex'),
    ticket, live: check(BigInt(t.expiry) - 1n), expired: check(BigInt(t.expiry)) });
}
assert.deepEqual(tickets.map((t) => [t.message, t.ticket.sig]), ticketVectors.vectores.map((t) => [t.mensaje_hex, t.sig]));
const [t1] = ticketVectors.vectores;
const [v1, , v3] = vectors.payment_id.vectores;
const t1Ticket = { expiry: t1.expiry, sig: t1.sig };
const v2Msgs = [sdk.buildEscrowMsg(v1), sdk.buildEscrowMsg({ ...v1, dispute_deadline: v1.release_deadline }),
  sdk.buildEscrowMsg({ ...v1, dispute_deadline: v1.release_deadline, operator_ticket: t1Ticket })];
const m = vectors.v2.msg_authorize;
assert.deepEqual(v2Msgs, [m.canonico_v1_en_v2, m.canonico_con_dispute_deadline, m.canonico_con_ticket_t1]);
const v2Escrow = sdk.NEAR_ESCROW_V2_CONTRACTS['near:mainnet'][0];
const v2Authorization = await sdk.signEscrowAuthorization({ network: 'near:mainnet', signer, senderId: v3.payer,
  escrowContract: v2Escrow, token: sdk.NEAR_ESCROW_TOKENS['near:mainnet'], amount: v3.amount,
  msg: { ...v3, dispute_deadline: v3.release_deadline, operator_ticket: t1Ticket }, nonce: '7', maxBlockHeight: '100000000' });

// Policy parity: each case must be refused before the signer runs, in both runtimes.
const authorize = (v, net) => ({ method: 'authorize', token: v.token, amount: v.amount, msg: v, network: net, senderId: v.payer });
const cases = [
  { ...authorize(v3, 'near:mainnet'), escrowContract: 'evil-sink.near', nonce: '7', maxBlockHeight: '100000000' },
  { ...authorize(v3, 'near:mainnet'), escrowContract, nonce: '7', maxBlockHeight: '100000000' },
  // v2 msg fields toward the v1 contract (v1 answers E03).
  { ...authorize({ ...v3, dispute_deadline: v3.release_deadline }, 'near:mainnet'), escrowContract: 'v1.arras-escrow.near', nonce: '7', maxBlockHeight: '100000000' },
  { ...authorize({ ...v3, operator_ticket: t1Ticket }, 'near:mainnet'), escrowContract: 'v1.arras-escrow.near', nonce: '7', maxBlockHeight: '100000000' },
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
  contracts: JSON.parse(JSON.stringify(sdk.NEAR_ESCROW_CONTRACTS)), v2Contracts: JSON.parse(JSON.stringify(sdk.NEAR_ESCROW_V2_CONTRACTS)),
  tickets, v2Msgs, v2Authorization, refusals, fixtureHash: createHash('sha256').update(raw).digest('hex') });
console.log(`NEAR TS/PY: frozen fixture bytes, V-1..V-3 msg/preimage/payment IDs, 21 signed delegates, the v1 and v2 contract registries, `
  + `tickets T-1/T-2 (bytes, signatures, live and expired checks), 3 canonical v2 msgs, 1 signed v2 authorization and ${cases.length} pre-signature refusals match exactly.`);
