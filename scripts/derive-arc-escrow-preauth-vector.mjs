/**
 * Derives the `arc_vector` section of src/escrow-preauth.vectors.json: Arc
 * (chain 5042) on the x402r canonical escrow, with the payer, worker, bounty,
 * frozen time, salt, tier and synthetic signer of the Base vectors.
 *
 * What anchors it outside this SDK (the script stops if any of them differs):
 * - both nonces are AuthCaptureEscrow.getHash answers (payer = 0) recorded on
 *   chain 5042 in src/fixtures/arc-escrow-d.rpc.json;
 * - the frozen PaymentInfo the builder produces is the one sent to getHash;
 * - the EIP-712 domain name and version are the USDC contract's name() and
 *   version() recorded on chain 5042.
 * The signature comes from the synthetic key (0x42 * 32) of the Base vectors.
 *
 * The existing bytes of the vectors file are kept: the section is appended as
 * the last key, and the script checks the prefix before writing.
 *
 * Usage, after `npm run build`:
 *   node scripts/derive-arc-escrow-preauth-vector.mjs           appends arc_vector (refuses if present)
 *   node scripts/derive-arc-escrow-preauth-vector.mjs --check   re-derives and compares
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { buildEscrowPreAuth, computeEscrowNonce, EnvKeyAdapter } from '../dist/index.mjs';
import { ESCROW_CONTRACTS } from '../dist/backend/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = resolve(ROOT, 'src', 'escrow-preauth.vectors.json');
const RPC_FIXTURE = resolve(ROOT, 'src', 'fixtures', 'arc-escrow-d.rpc.json');
const CHAIN_ID = 5042;
const CHECK = process.argv.includes('--check');

const LONG_HEX = /^[0-9a-f]{64,}$/;
const hydrate = (v) =>
  typeof v === 'string' && LONG_HEX.test(v) ? '0x' + v
    : Array.isArray(v) ? v.map(hydrate)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hydrate(x)]))
    : v;
const dehydrate = (v) =>
  typeof v === 'string' && /^0x[0-9a-f]{64,}$/.test(v) ? v.slice(2)
    : Array.isArray(v) ? v.map(dehydrate)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dehydrate(x)]))
    : v;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const original = readFileSync(VECTORS, 'utf8');
const fx = JSON.parse(original);
const rpc = JSON.parse(readFileSync(RPC_FIXTURE, 'utf8'));
const chain = rpc.chains[String(CHAIN_ID)];
const read = (label) => {
  const entry = chain.reads.find((r) => r.label === label);
  if (!entry) fail(`no recorded read '${label}' on chain ${CHAIN_ID}`);
  return entry;
};
const coder = ethers.AbiCoder.defaultAbiCoder();
const text = (label) => coder.decode(['string'], '0x' + read(label).result)[0];
const onChainHash = (label) => '0x' + read(label).result;

const c = ESCROW_CONTRACTS[CHAIN_ID];
const base = hydrate(fx);
const networkConfig = {
  chain_id: CHAIN_ID,
  operator: c.operator,
  escrow: c.escrow,
  token_collector: c.tokenCollector,
  usdc: c.usdc,
  usdc_domain_name: text('usdc.name'),
  usdc_domain_version: text('usdc.version'),
  payment_info_typehash: base.network_config.payment_info_typehash,
  min_fee_bps: base.network_config.min_fee_bps,
  max_fee_bps: base.network_config.max_fee_bps,
};

// Static vector: the Base static PaymentInfo, moved to Arc.
const staticPaymentInfo = {
  ...base.static_vector.payment_info,
  operator: c.operator,
  token: c.usdc,
  feeReceiver: c.operator,
};
const staticNonce = computeEscrowNonce(CHAIN_ID, c.escrow, networkConfig.payment_info_typehash, staticPaymentInfo);
if (staticNonce !== onChainHash('escrow.getHash.static')) {
  fail(`static nonce ${staticNonce} is not the on-chain getHash ${onChainHash('escrow.getHash.static')}`);
}

// Frozen build: the Base frozen inputs, on Arc.
const frozen = base.frozen_build;
const realNow = Date.now;
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Date.now = () => frozen.now * 1000;
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { getRandomValues: (arr) => arr.fill(0xab) },
});
const adapter = new EnvKeyAdapter(frozen.signer_private_key);
const signed = [];
let wrapper;
try {
  wrapper = JSON.parse(
    await buildEscrowPreAuth(
      {
        signTypedData: (typedData) => {
          signed.push(JSON.parse(typedData));
          return adapter.signTypedData(typedData);
        },
      },
      {
        networkConfig: { ...networkConfig, tiers: base.escrow_tier_windows },
        payerWallet: base.payer,
        workerWallet: base.worker,
        bountyAtomic: base.bounty_atomic,
        tier: frozen.tier,
        reviewDeadlineSec: frozen.deadline,
      },
    ),
  );
} finally {
  Date.now = realNow;
  Object.defineProperty(globalThis, 'crypto', realCrypto);
}

if (wrapper.payload.authorization.nonce !== onChainHash('escrow.getHash.frozen')) {
  fail(`frozen nonce ${wrapper.payload.authorization.nonce} is not the on-chain getHash ${onChainHash('escrow.getHash.frozen')}`);
}
const PI = 'tuple(address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256)';
const sentToChain = coder.decode([PI], '0x' + read('escrow.getHash.frozen').request.params[0].data.slice(8))[0];
const pi = wrapper.payload.paymentInfo;
const built = [pi.operator, ethers.ZeroAddress, pi.receiver, pi.token, BigInt(pi.maxAmount), BigInt(pi.preApprovalExpiry),
  BigInt(pi.authorizationExpiry), BigInt(pi.refundExpiry), BigInt(pi.minFeeBps), BigInt(pi.maxFeeBps), pi.feeReceiver, BigInt(pi.salt)];
if (JSON.stringify(sentToChain.toArray(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  !== JSON.stringify(built, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) {
  fail('the frozen PaymentInfo is not the one sent to getHash on chain');
}
if (signed.length !== 1) fail(`expected one signature, got ${signed.length}`);

const arcVector = dehydrate({
  _note: [
    'Arc (chain 5042) on the x402r canonical escrow, with the payer, worker, bounty,',
    'frozen now/salt/deadline/tier and signer_private_key of frozen_build above.',
    'Both expected nonces are AuthCaptureEscrow.getHash answers (payer = 0) read on',
    `chain 5042 at block ${BigInt(chain.block)}; usdc_domain_name / usdc_domain_version are the`,
    'USDC contract\'s name() / version() read at the same block.',
    'Recorded in uvd-x402-sdk-typescript src/fixtures/arc-escrow-d.rpc.json; derived by',
    'scripts/derive-arc-escrow-preauth-vector.mjs.',
  ],
  network: 'arc',
  network_config: networkConfig,
  static_vector: {
    payment_info: staticPaymentInfo,
    expected_nonce: staticNonce,
  },
  frozen_build: {
    now: frozen.now,
    salt: frozen.salt,
    deadline: frozen.deadline,
    tier: frozen.tier,
    expected_typed_data: {
      domain: signed[0].domain,
      primaryType: signed[0].primaryType,
      message: signed[0].message,
    },
    expected_wrapper: wrapper,
  },
});

if (CHECK) {
  if (!fx.arc_vector) fail('arc_vector is missing');
  if (JSON.stringify(fx.arc_vector) !== JSON.stringify(arcVector)) fail('arc_vector differs from a fresh derivation');
  console.log('arc_vector matches a fresh derivation');
} else {
  if (fx.arc_vector) fail('arc_vector already present; use --check');
  const out = JSON.stringify({ ...fx, arc_vector: arcVector }, null, 2) + '\n';
  const kept = original.slice(0, original.lastIndexOf('\n}'));
  if (!out.startsWith(kept)) fail('appending arc_vector would change the existing bytes');
  writeFileSync(VECTORS, out);
  console.log(`appended arc_vector to ${VECTORS}`);
}
