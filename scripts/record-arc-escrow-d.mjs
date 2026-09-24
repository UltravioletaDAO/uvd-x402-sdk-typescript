/**
 * Records the Arc (5042) and Arc Testnet (5042002) reads that the escrow
 * tests compare against: src/fixtures/arc-escrow-d.rpc.json.
 *
 * Read-only JSON-RPC (eth_chainId, eth_blockNumber, eth_getCode, eth_call),
 * one request at a time, a pause of 1.5 s between requests, and a hard stop at
 * the first 429 or JSON-RPC error: nothing is written unless every read
 * succeeded. Every read after eth_blockNumber is pinned to that block.
 *
 * Addresses: BackTrackCo/x402r-sdk packages/core/src/config/index.ts @ bbfec12c
 * and BackTrackCo/x402r-contracts deployments/canonical-v1.0.1.json and
 * canonical-v1.0.2.json @ c5223eaa. The operator is the one this SDK ships for
 * both Arc networks; the configuration it is computed from is data.
 *
 * Usage: node scripts/record-arc-escrow-d.mjs
 * Refuses to overwrite an existing fixture; delete it first to re-record.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'fixtures', 'arc-escrow-d.rpc.json');
const PAUSE_MS = 1500;

const CHAINS = [
  { chainId: 5042, rpcUrl: 'https://rpc.mainnet.arc.io', fullFactoryCode: true },
  { chainId: 5042002, rpcUrl: 'https://rpc.testnet.arc.io', fullFactoryCode: false },
];

const D = {
  escrow: '0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff',
  operatorFactory: '0xc24153B7ED8DC03e551F29DDEeA5CadFe57e2716',
  tokenCollector: '0x0E3dF9510de65469C4518D7843919c0b8C7A7757',
  protocolFeeConfig: '0xBe2d24614F339a1eB103A399F93AA2a39Ca815Bc',
  refundRequest: '0xe971C674fD5c3462023f3F891dF6289DFbC9CEFC',
  usdc: '0x3600000000000000000000000000000000000000',
  operator: '0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D',
};

const OPERATOR_CONFIG = [
  '0xaE07cEB6b395BC685a776a0b4c489E8d9cE9A6ad',
  '0x25cA273d6f5508f06ed186680D305DC32a997461',
  '0x0000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000000',
  '0xf50fD76d66c80AEb216c0C5879376C980a2B62eF',
  '0x0000000000000000000000000000000000000000',
  '0xd8023a72f29Bb1AB782c69744893Dea2836cb69C',
  '0x0000000000000000000000000000000000000000',
  '0x402ef720D202cb4BCbfb3Ee6577b204cA06786B9',
  '0x0000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000000',
];

// Payer-agnostic hashes (payer = 0) read from AuthCaptureEscrow.getHash:
// `static` is the PaymentInfo the escrow client's authorize test signs;
// `preAuth` is the one src/escrow-preauth.arc-vector.json builds (the Python
// SDK's Arc pre-auth case).
const VECTOR_PAYMENT_INFOS = {
  static: [D.operator, ethers.ZeroAddress, '0x1111111111111111111111111111111111111111', D.usdc,
    100000n, 1760003600, 1760007200, 1760086400, 0, 1800, D.operator, '0x' + 'ab'.repeat(32)],
  preAuth: [D.operator, ethers.ZeroAddress, '0x1111111111111111111111111111111111111111', D.usdc,
    100000n, 1760003600, 1760604800, 1761209600, 0, 1800, D.operator, '0x' + 'a7'.repeat(32)],
};

const PI = 'tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt)';
const CONFIG = 'tuple(address,address,address,address,address,address,address,address,address,address,address,address)';

const factory = new ethers.Interface([
  'function ESCROW() view returns (address)',
  'function PROTOCOL_FEE_CONFIG() view returns (address)',
  `function computeAddress(${CONFIG} config) view returns (address)`,
  `function getOperator(${CONFIG} config) view returns (address)`,
]);
const escrow = new ethers.Interface([
  `function getHash(${PI} paymentInfo) view returns (bytes32)`,
  'function paymentState(bytes32) view returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount)',
]);
const collector = new ethers.Interface(['function authCaptureEscrow() view returns (address)']);
const token = new ethers.Interface([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requestId = 0;
let first = true;

async function rpc(rpcUrl, method, params) {
  if (!first) await sleep(PAUSE_MS);
  first = false;
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  if (res.status === 429) throw new Error(`429 from ${rpcUrl} on ${method}: stopping, nothing written`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${rpcUrl} on ${method}: stopping, nothing written`);
  const body = await res.json();
  if (body.error) throw new Error(`JSON-RPC error from ${rpcUrl} on ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Hex of 32 bytes or more is stored without 0x, as in src/escrow-preauth.vectors.json. */
function dehydrate(hex) {
  return /^0x[0-9a-f]{64,}$/.test(hex) ? hex.slice(2) : hex;
}

async function recordChain({ chainId, rpcUrl, fullFactoryCode }) {
  const reads = [];
  const chainIdHex = await rpc(rpcUrl, 'eth_chainId', []);
  if (BigInt(chainIdHex) !== BigInt(chainId)) throw new Error(`${rpcUrl} answered chain ${chainIdHex}`);
  reads.push({ label: 'eth_chainId', request: { method: 'eth_chainId', params: [] }, result: chainIdHex });
  const block = await rpc(rpcUrl, 'eth_blockNumber', []);
  reads.push({ label: 'eth_blockNumber', request: { method: 'eth_blockNumber', params: [] }, result: block });

  const code = async (label, address, full) => {
    const params = [address, block];
    const result = await rpc(rpcUrl, 'eth_getCode', params);
    const entry = { label, request: { method: 'eth_getCode', params } };
    if (full) entry.result = dehydrate(result);
    else Object.assign(entry, { resultBytes: (result.length - 2) / 2, resultKeccak: dehydrate(ethers.keccak256(result)) });
    reads.push(entry);
  };
  const call = async (label, to, data) => {
    const params = [{ to, data }, block];
    const result = await rpc(rpcUrl, 'eth_call', params);
    reads.push({ label, request: { method: 'eth_call', params: [{ to, data: dehydrate(data) }, block] }, result: dehydrate(result) });
    return result;
  };

  await code('code.operatorFactory', D.operatorFactory, fullFactoryCode);
  await call('operatorFactory.ESCROW', D.operatorFactory, factory.encodeFunctionData('ESCROW'));
  await call('operatorFactory.PROTOCOL_FEE_CONFIG', D.operatorFactory, factory.encodeFunctionData('PROTOCOL_FEE_CONFIG'));
  await call('operatorFactory.computeAddress', D.operatorFactory, factory.encodeFunctionData('computeAddress', [OPERATOR_CONFIG]));
  await call('operatorFactory.getOperator', D.operatorFactory, factory.encodeFunctionData('getOperator', [OPERATOR_CONFIG]));
  await code('code.operator', D.operator, false);
  await code('code.escrow', D.escrow, false);
  await code('code.tokenCollector', D.tokenCollector, false);
  await call('tokenCollector.authCaptureEscrow', D.tokenCollector, collector.encodeFunctionData('authCaptureEscrow'));
  await code('code.protocolFeeConfig', D.protocolFeeConfig, false);
  await code('code.refundRequest', D.refundRequest, false);
  await code('code.usdc', D.usdc, false);
  await call('usdc.name', D.usdc, token.encodeFunctionData('name'));
  await call('usdc.version', D.usdc, token.encodeFunctionData('version'));
  await call('usdc.DOMAIN_SEPARATOR', D.usdc, token.encodeFunctionData('DOMAIN_SEPARATOR'));
  const staticHash = await call('escrow.getHash.static', D.escrow, escrow.encodeFunctionData('getHash', [VECTOR_PAYMENT_INFOS.static]));
  await call('escrow.getHash.preAuth', D.escrow, escrow.encodeFunctionData('getHash', [VECTOR_PAYMENT_INFOS.preAuth]));
  await call('escrow.paymentState.static', D.escrow, escrow.encodeFunctionData('paymentState', [staticHash]));
  return { rpcUrl, block, reads };
}

async function main() {
  if (existsSync(OUT)) throw new Error(`${OUT} exists; delete it to re-record`);
  const chains = {};
  const startedAt = new Date().toISOString();
  for (const chain of CHAINS) chains[String(chain.chainId)] = await recordChain(chain);
  const fixture = {
    _note: [
      'Recorded by scripts/record-arc-escrow-d.mjs from the public Arc RPCs; never edited by hand.',
      'Every read after eth_blockNumber is pinned to that block.',
      'Hex values of 32 bytes or more are stored without the 0x prefix.',
      'eth_getCode results other than the mainnet operator factory are stored as byte length + keccak256.',
    ],
    recordedAt: startedAt,
    addresses: D,
    operatorConfig: OPERATOR_CONFIG,
    chains,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
