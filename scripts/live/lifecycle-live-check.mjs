#!/usr/bin/env node
/**
 * Live check of a TypeScript-signed lifecycle order against the PRODUCTION
 * facilitator, which runs `escrowLifecycleAuth: log`.
 *
 * >>> NO FUNDS, NO GAS, BY CONSTRUCTION <<<
 * The network is base-sepolia and the `tokenCollector` is deliberately wrong.
 * In `execute_release_flow` (x402-rs `operator.rs:455-477`) the order is
 * `for_network -> get_evm_provider -> lifecycle_auth::gate -> execute_release`,
 * and the first thing `execute_release` does is `validate_addresses`
 * (`operator.rs:754`), which rejects that collector. The GATE runs and logs its
 * verdict; the request then dies before a single transaction is built.
 *
 * The signing key is generated in this process and never printed, stored or
 * reused. It has never held funds.
 *
 * Usage: node scripts/live/lifecycle-live-check.mjs
 */

import { ethers } from 'ethers';
import { buildLifecycleAuth } from '../../dist/index.mjs';

const FACILITATOR = process.env.UVD_FACILITATOR ?? 'https://facilitator.ultravioletadao.xyz';
const CHAIN_ID = 84532; // base-sepolia
const OPERATOR = '0x7D092ec506B3D43EB87846F9c9739303785D7B2f'; // addresses.rs:324
const ESCROW = '0x29025c0E9D4239d438e169570818dB9FE0A80873'; // addresses.rs:83
const BAD_COLLECTOR = '0x000000000000000000000000000000000000dEaD'; // deliberately invalid
const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// Ephemeral key: generated here, never written down.
const wallet = ethers.Wallet.createRandom();
const signer = {
  getAddress: () => wallet.address,
  async signTypedData(typedData) {
    const { domain, types, message } = JSON.parse(typedData);
    const clean = { ...types };
    delete clean['EIP712Domain'];
    return { signature: await wallet.signTypedData(domain, clean, message) };
  },
};

const now = Math.floor(Date.now() / 1000);
const paymentInfo = {
  operator: OPERATOR,
  receiver: '0x2222222222222222222222222222222222222222',
  token: USDC_SEPOLIA,
  maxAmount: '1000',
  preApprovalExpiry: now + 3600,
  authorizationExpiry: now + 7200,
  refundExpiry: now + 86400,
  minFeeBps: 0,
  maxFeeBps: 1300,
  feeReceiver: '0xaE07cEB6b395BC685a776a0b4c489E8d9cE9A6ad',
  salt: ethers.hexlify(ethers.randomBytes(32)),
};

async function send(label, { withAuth, payerOverride }) {
  const payer = payerOverride ?? wallet.address;
  const amount = '1000';
  const lifecycleAuth = withAuth
    ? await buildLifecycleAuth({
        action: 'release',
        paymentInfo,
        payer,
        amount,
        chainId: CHAIN_ID,
        wallet: signer,
      })
    : undefined;

  const body = {
    x402Version: 2,
    scheme: 'escrow',
    action: 'release',
    payload: {
      paymentInfo,
      payer,
      amount,
      ...(lifecycleAuth ? { lifecycleAuth } : {}),
    },
    paymentRequirements: {
      scheme: 'escrow',
      network: `eip155:${CHAIN_ID}`,
      extra: {
        escrowAddress: ESCROW,
        operatorAddress: OPERATOR,
        tokenCollector: BAD_COLLECTOR,
      },
    },
  };

  const sentAt = new Date().toISOString();
  const res = await fetch(`${FACILITATOR}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  console.log(`\n── ${label}`);
  console.log(`   sent at   ${sentAt}`);
  console.log(`   signer    ${lifecycleAuth ? lifecycleAuth.signer : '(none)'}`);
  console.log(`   payer     ${payer}`);
  console.log(`   receiver  ${paymentInfo.receiver}`);
  console.log(`   nonce     ${lifecycleAuth ? lifecycleAuth.nonce : '(none)'}`);
  console.log(`   http      ${res.status}`);
  console.log(`   body      ${text.slice(0, 300)}`);
  if (/transaction/i.test(text) && !/null/.test(text)) {
    console.error('   !! a transaction was produced — this was supposed to be impossible');
    process.exitCode = 1;
  }
}

console.log(`facilitator: ${FACILITATOR}`);
const settleInfo = await (await fetch(`${FACILITATOR}/settle`)).json();
console.log(`escrowLifecycleAuth mode: ${settleInfo.escrowLifecycleAuth}`);

// 1. signer IS the payer -> the gate should log verdict=ok, role=payer
await send('signed by the payer (expect verdict=ok)', { withAuth: true });
// 2. signer is NOT a party -> verdict=unauthorized_role
await send('signed by a stranger (expect verdict=unauthorized_role)', {
  withAuth: true,
  payerOverride: '0x1111111111111111111111111111111111111111',
});
// 3. no order at all -> verdict=missing, and the request behaves as before
await send('no lifecycleAuth (the compatibility path)', { withAuth: false });

console.log(
  '\nNo transaction was built in any of the three: validate_addresses rejects the ' +
    'collector after the gate has already run and logged.'
);
