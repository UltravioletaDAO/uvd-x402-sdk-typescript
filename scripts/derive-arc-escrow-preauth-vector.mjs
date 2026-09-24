/**
 * Derives src/escrow-preauth.arc-vector.json: the Arc (chain 5042) escrow
 * pre-auth vector. It is the Python SDK's Arc pre-auth case
 * (uvd-x402-sdk-python tests/fixtures/arc-escrow-d.json, `pre_auth`): `pre_auth`
 * below reproduces that object key for key, and its payment_info is what this
 * SDK's builder produces from those inputs.
 *
 * What anchors it outside this SDK (the script stops if any of them differs):
 * - the nonce is the AuthCaptureEscrow.getHash answer (payer = 0) recorded on
 *   chain 5042 in src/fixtures/arc-escrow-d.rpc.json;
 * - the PaymentInfo the builder produces is the one sent to getHash;
 * - the EIP-712 domain name and version are the USDC contract's name() and
 *   version() recorded on chain 5042.
 * The signer is the synthetic key (0x42 * 32) of src/escrow-preauth.vectors.json,
 * read from that file; the payer is the signer's own address.
 *
 * src/escrow-preauth.vectors.json itself is never written: it stays
 * byte-identical to its mirrored copies.
 *
 * Usage, after `npm run build`:
 *   node scripts/derive-arc-escrow-preauth-vector.mjs           writes the file (refuses to overwrite)
 *   node scripts/derive-arc-escrow-preauth-vector.mjs --check   re-derives and compares
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { buildEscrowPreAuth, EnvKeyAdapter } from '../dist/index.mjs';
import { ESCROW_CONTRACTS } from '../dist/backend/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_VECTORS = resolve(ROOT, 'src', 'escrow-preauth.vectors.json');
const OUT = resolve(ROOT, 'src', 'escrow-preauth.arc-vector.json');
const RPC_FIXTURE = resolve(ROOT, 'src', 'fixtures', 'arc-escrow-d.rpc.json');
const CHAIN_ID = 5042;
const CHECK = process.argv.includes('--check');

// The case: inputs of the Python SDK's Arc pre-auth fixture.
const CASE = {
  network: 'arc',
  now: 1760000000,
  salt: 'a7'.repeat(32),
  signer: 'synthetic test key 0x42 * 32, never held funds',
  worker: '0x1111111111111111111111111111111111111111',
  bounty_usd: '0.10',
  tier: 'micro',
};

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

const shared = hydrate(JSON.parse(readFileSync(SHARED_VECTORS, 'utf8')));
const rpc = JSON.parse(readFileSync(RPC_FIXTURE, 'utf8'));
const chain = rpc.chains[String(CHAIN_ID)];
const read = (label) => {
  const entry = chain.reads.find((r) => r.label === label);
  if (!entry) fail(`no recorded read '${label}' on chain ${CHAIN_ID}`);
  return entry;
};
const coder = ethers.AbiCoder.defaultAbiCoder();
const text = (label) => coder.decode(['string'], '0x' + read(label).result)[0];
const onChainHash = '0x' + read('escrow.getHash.preAuth').result;

const c = ESCROW_CONTRACTS[CHAIN_ID];
const networkConfig = {
  chain_id: CHAIN_ID,
  operator: c.operator,
  escrow: c.escrow,
  token_collector: c.tokenCollector,
  usdc: c.usdc,
  usdc_domain_name: text('usdc.name'),
  usdc_domain_version: text('usdc.version'),
  payment_info_typehash: shared.network_config.payment_info_typehash,
  min_fee_bps: shared.network_config.min_fee_bps,
  max_fee_bps: shared.network_config.max_fee_bps,
};

const adapter = new EnvKeyAdapter(shared.frozen_build.signer_private_key);
const payer = adapter.getAddress();
const bountyAtomic = ethers.parseUnits(CASE.bounty_usd, 6).toString();

const realNow = Date.now;
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const saltBytes = ethers.getBytes('0x' + CASE.salt);
Date.now = () => CASE.now * 1000;
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { getRandomValues: (arr) => { arr.set(saltBytes); return arr; } },
});
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
        networkConfig: { ...networkConfig, tiers: shared.escrow_tier_windows },
        payerWallet: payer,
        workerWallet: CASE.worker,
        bountyAtomic,
        tier: CASE.tier,
      },
    ),
  );
} finally {
  Date.now = realNow;
  Object.defineProperty(globalThis, 'crypto', realCrypto);
}

if (wrapper.payload.authorization.nonce !== onChainHash) {
  fail(`nonce ${wrapper.payload.authorization.nonce} is not the on-chain getHash ${onChainHash}`);
}
const PI = 'tuple(address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256)';
const sentToChain = coder.decode([PI], '0x' + read('escrow.getHash.preAuth').request.params[0].data.slice(8))[0];
const pi = wrapper.payload.paymentInfo;
const built = [pi.operator, ethers.ZeroAddress, pi.receiver, pi.token, BigInt(pi.maxAmount), BigInt(pi.preApprovalExpiry),
  BigInt(pi.authorizationExpiry), BigInt(pi.refundExpiry), BigInt(pi.minFeeBps), BigInt(pi.maxFeeBps), pi.feeReceiver, BigInt(pi.salt)];
const asText = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
if (asText(sentToChain.toArray()) !== asText(built)) fail('the PaymentInfo is not the one sent to getHash on chain');
if (signed.length !== 1) fail(`expected one signature, got ${signed.length}`);

const vector = dehydrate({
  _note: [
    'Arc (chain 5042) escrow pre-auth vector. `pre_auth` is the Arc pre-auth case of the',
    'Python SDK (uvd-x402-sdk-python tests/fixtures/arc-escrow-d.json), key for key.',
    'buildEscrowPreAuth(network_config, payer, pre_auth.worker, bounty_atomic, no review',
    'deadline, pre_auth.tier), with time frozen at pre_auth.now and the salt RNG at',
    'pre_auth.salt, signed by frozen_build.signer_private_key of',
    'src/escrow-preauth.vectors.json (whose address is `payer`), yields expected_wrapper.',
    `expected_nonce is AuthCaptureEscrow.getHash (payer = 0) read on chain 5042 at block ${BigInt(chain.block)};`,
    'usdc_domain_name / usdc_domain_version are the USDC contract\'s name() / version() read',
    'at the same block (src/fixtures/arc-escrow-d.rpc.json).',
    'Derived by scripts/derive-arc-escrow-preauth-vector.mjs. Hex values of 32 bytes or more',
    'are stored without the 0x prefix.',
  ],
  pre_auth: { ...CASE, salt: '0x' + CASE.salt, payment_info: pi },
  payer,
  bounty_atomic: bountyAtomic,
  network_config: networkConfig,
  expected_nonce: onChainHash,
  expected_typed_data: {
    domain: signed[0].domain,
    primaryType: signed[0].primaryType,
    message: signed[0].message,
  },
  expected_wrapper: wrapper,
});
const out = JSON.stringify(vector, null, 2) + '\n';

if (CHECK) {
  if (!existsSync(OUT)) fail(`${OUT} is missing`);
  if (readFileSync(OUT, 'utf8') !== out) fail(`${OUT} differs from a fresh derivation`);
  console.log('src/escrow-preauth.arc-vector.json matches a fresh derivation');
} else {
  if (existsSync(OUT)) fail(`${OUT} exists; use --check`);
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
}
