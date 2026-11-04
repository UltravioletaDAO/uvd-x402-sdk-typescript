/** Read-only public fixture recorder. Tests never run --record. No keys or transaction submission. */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const output = new URL('../src/providers/near/vectors/near-erc8004.json', import.meta.url);
const arguments_ = process.argv.slice(2);
if (arguments_[0] === '--compare' && arguments_.length === 2) {
  if (!readFileSync(output).equals(readFileSync(arguments_[1]))) throw new Error('NEAR ERC-8004 fixture bytes differ');
  console.log('NEAR ERC-8004 fixture bytes: identical');
  process.exit(0);
}
if (arguments_.length !== 1 || arguments_[0] !== '--record') throw new Error('Use --record (public RPC) or --compare <fixture> (offline)');
const networks = [
  { network: 'near:mainnet', rpc: 'https://rpc.mainnet.near.org', identity: 'identity-registry.erc-8004.near', reputation: 'reputation-registry.erc-8004.near', verifier: 'erc8004-verifier.arras-escrow.near', payer: 'fe0a574258f8277099875e46d4ca0043cdb6274ff2501b375a0d3d64bc211079', proof: 'EbkEtGaM7ZwY6aHSdHSqxdFx9cJV13KPT7fYBWjxbfd9', txs: ['EFEP8ySmwnySWwtc3FeezvETBR1GadLt4ZQGyydu76uQ','5LX8yTQUvMD7uYSmKg4TQQ2HFPAjJmtiSRFFoVU67s4','Cxcj2Bo1ZkhAeBiu9bFaKY2iFvsPrYy9bBzvYyVHWTfg'] },
  { network: 'near:testnet', rpc: 'https://rpc.testnet.near.org', identity: 'identity-registry.erc-8004.testnet', reputation: 'reputation-registry.erc-8004.testnet', verifier: 'erc8004-verifier.arras-dev.testnet', payer: 'payer-demo.arras-dev.testnet', proof: '5RbdKfx4giehMpctWhSvzDrrTycMuWv83cLzqPA3dfKA', txs: ['2aBxPraCa84y7JjoL9NevoRMVhmVf7Darx2PAdFgZzDY','DQn4xqxk1rAxu15dY1MFzKmpgN9Lh2ksWRd2sVQ3TSuU','9LNL3dyMVAn81LiDcYipLKM1HXjDVgcSw79hj5vB9h6Z'] },
];
let last = 0;
async function rpc(url, method, params) {
  if (!['query','EXPERIMENTAL_tx_status'].includes(method) || (method === 'query' && params.request_type !== 'call_function')) throw new Error('Read-only RPC required');
  await delay(Math.max(0, 1100 - (performance.now() - last))); last = performance.now();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'near-erc8004', method, params }), signal: AbortSignal.timeout(30000) });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 8 * 1024 * 1024) throw new Error('RPC response too large'); chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (json.error || !Object.hasOwn(json, 'result')) throw new Error(JSON.stringify(json.error));
  return json.result;
}
const recorded = [];
for (const n of networks) {
  const feedback = { agent_id: '0', client_address: n.payer, feedback_index: '1' };
  const views = [
    [n.identity, 'get_config', {}], [n.reputation, 'get_config', {}], [n.verifier, 'get_config', {}],
    [n.identity, 'nft_token', { token_id: '0' }],
    [n.reputation, 'read_feedback', feedback], [n.reputation, 'read_feedback_proof', feedback],
    [n.reputation, 'get_verified_summary', { agent_id: '0', verifier: n.verifier, context: 'em' }],
    [n.reputation, 'list_verified_feedback', { agent_id: '0', verifier: n.verifier }],
    [n.reputation, 'read_all_feedback', { agent_id: '0' }],
    [n.reputation, 'get_proof_feedback', { verifier: n.verifier, proof: n.proof, client_address: n.payer }],
  ];
  const calls = [], transactions = [];
  for (const [contract, method, args] of views) {
    const args_json = JSON.stringify(args);
    const response = await rpc(n.rpc, 'query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(args_json).toString('base64') });
    const result = JSON.parse(Buffer.from(response.result).toString('utf8'));
    calls.push({ contract, method, args, args_json, args_hex: Buffer.from(args_json).toString('hex'), result });
    console.log(n.network, method, contract);
  }
  for (let i = 0; i < n.txs.length; i++) {
    const result = await rpc(n.rpc, 'EXPERIMENTAL_tx_status', [n.txs[i], n.payer]);
    const method = ['register','nft_transfer','give_feedback_with_proof'][i];
    if (result.transaction.actions[0].FunctionCall.method_name !== method) throw new Error('Historical transaction method mismatch');
    transactions.push({ method, transaction_hash: n.txs[i], result });
    console.log(n.network, method, n.txs[i]);
  }
  recorded.push({ network: n.network, calls, transactions });
}
writeFileSync(output, JSON.stringify({ format: 'near-erc8004-v1', networks: recorded }, null, 2) + '\n');
