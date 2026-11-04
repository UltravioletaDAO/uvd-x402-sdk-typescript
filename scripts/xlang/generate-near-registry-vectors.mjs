import { writeFileSync, readFileSync } from 'node:fs';
import { encodeBase58 } from 'ethers';
import * as registry from '../../dist/providers/near/index.mjs';

// Public deterministic seed, not a wallet credential. Contract ABI fixtures only.
const seed = new Uint8Array(32).fill(1);
const signer = registry.createNearLocalSigner(seed);
const blockHash = encodeBase58(new Uint8Array(32).fill(2));
const common = { network: 'near:mainnet', signerId: 'payer.near' };
const payment = { escrow: 'v1.arras-escrow.near', payment_id: '1'.repeat(32) };
const register = registry.buildRegistryRegister({ ...common, agent_uri: 'https://agente.example/card.json' });
const feedback = registry.buildGiveFeedback({ ...common, ...payment, score: 90, tag1: 'quality', tag2: 'successRate',
  feedback_uri: 'https://agente.example/f/1.json', feedback_hash: 'ab'.repeat(32) });
const revoke = registry.buildRevokeFeedback({ ...common, ...payment });
const logs = [
  'EVENT_JSON:{"standard":"arras-registry","version":"1.0.0","event":"agent_registered","data":[{"account_id":"agente.near","agent_uri":"https://agente.example/card.json","metadata":null,"at":"5"}]}',
  'EVENT_JSON:{"standard":"arras-registry","version":"1.0.0","event":"agent_updated","data":[{"account_id":"agente.near","agent_uri":"ipfs://bafy","metadata":"{\\"k\\":\\"v\\"}","at":"6"}]}',
  'EVENT_JSON:{"standard":"arras-registry","version":"1.0.0","event":"feedback_given","data":[{"feedback_id":0,"rater":"payer.near","ratee":"worker.near","ratee_role":"receiver","escrow":"v1.arras-escrow.near","payment_id":"DN5eMA3sNES7xsoy6qvy24cVF6Dmwjxpkvd2b4e8P38M","operator_id":"em","released":"1000000","score":90,"tag1":"quality","tag2":null,"feedback_uri":null,"feedback_hash":null,"created_at":"7"}]}',
  'EVENT_JSON:{"standard":"arras-registry","version":"1.0.0","event":"feedback_revoked","data":[{"feedback_id":0,"rater":"payer.near","ratee":"worker.near","escrow":"v1.arras-escrow.near","payment_id":"x","revoked_at":"8"}]}',
];
const calls = {};
for (const [name, descriptor] of Object.entries({ register, give_feedback: feedback, revoke_feedback: revoke })) {
  const params = descriptor.actions[0].params;
  calls[name] = { args: params.args, args_json: JSON.stringify(params.args),
    args_hex: Buffer.from(JSON.stringify(params.args)).toString('hex'), gas: params.gas, deposit: params.deposit };
  if (name !== 'revoke_feedback') calls[name].signed_transaction_base64 = await registry.signRegistryTransaction(descriptor, signer, '1', blockHash);
}
const vector = { network: common.network, receiver_id: register.receiverId, signer_id: common.signerId,
  seed_hex: Buffer.from(seed).toString('hex'), public_key: `ed25519:${encodeBase58(signer.publicKey)}`,
  public_key_hex: Buffer.from(signer.publicKey).toString('hex'), nonce: '1', block_hash: blockHash, calls,
  events: logs.map((log) => ({ log, parsed: registry.parseRegistryEvents([log])[0] })) };
if (vector.events.some((e) => !e.parsed)) throw new Error('Invalid contract event fixture');
const path = new URL('../../src/providers/near/vectors/near-registry.json', import.meta.url);
const bytes = JSON.stringify(vector, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== bytes) throw new Error('Registry vectors differ; review ABI/signature changes');
  console.log('NEAR registry vectors: exact');
} else { writeFileSync(path, bytes); console.log('Wrote NEAR registry vectors'); }
