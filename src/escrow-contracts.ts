/**
 * uvd-x402-sdk - Escrow contract registry
 *
 * What is deployed on each escrow chain, and the PaymentOperator and fee
 * ceiling the escrow pre-auth signs there. Its own module because the backend
 * imports `escrow-preauth.ts`: the pre-auth reads these tables from here
 * without importing the backend back. `uvd-x402-sdk/backend` re-exports
 * {@link ESCROW_CONTRACTS} from here as the same object.
 *
 * - {@link ESCROW_CONTRACTS}: chain id -> the escrow deployment on it.
 * - {@link ESCROW_OPERATORS}: chain id -> the PaymentOperator of Execution
 *   Market's payment config on that chain.
 * - {@link ESCROW_MAX_FEE_BPS}: chain id -> the highest `maxFeeBps` the
 *   pre-auth signs on that chain.
 *
 * `buildEscrowPreAuth` reads all three: on a chain with a row, a network
 * config that contradicts it is refused before anything is signed; a chain
 * without a row is signed as before. Mirrors the Python SDK's
 * `uvd_x402_sdk.escrow_contracts` (0.96.0).
 */

import { getChainByName } from './chains';
import type { AdvancedEscrowContracts } from './backend';

/**
 * An Arc network's USDC as the chain registry (`src/chains`) has it. The
 * escrow tables below read the address and the EIP-712 domain name from here
 * instead of typing them a second time.
 *
 * @internal
 */
export function arcUsdc(network: 'arc' | 'arc-testnet'): { address: string; name: string } {
  const chain = getChainByName(network);
  if (!chain) throw new Error(`The chain registry has no '${network}'.`);
  return chain.usdc;
}

/**
 * Multi-chain escrow contract addresses for the Advanced Escrow system.
 * Keyed by EVM chain ID. Source: x402r-sdk A1igator/multichain-config deployment.
 */
/**
 * Per-chain escrow contract addresses.
 *
 * KNOWN GAP, measured 2026-09-05: the `operator` entries are
 * PaymentOperatorFactory addresses, not deployed PaymentOperator instances.
 * Verified on Base mainnet, Base Sepolia and Arbitrum — they answer
 * `ESCROW()` and `operators(bytes32)` and revert on `FEE_CALCULATOR()`,
 * `FEE_RECIPIENT()` and `release(...)` — and x402-rs
 * `docs/X402R_MULTICHAIN_DEPLOYMENT.md` labels the same addresses
 * "PaymentOperatorFactory". A factory has no `release`/`charge`, so the direct
 * on-chain paths of `AdvancedEscrowClient` (`uvd-x402-sdk/backend`) cannot
 * execute against these addresses as written;
 * resolve the real operator from the marketplace's own escrow config
 * ({@link EscrowNetworkConfig}) and pass it via `options.contracts`.
 * See {@link OPERATOR_FEE_BPS} for the commands. The escrow pre-auth does not
 * read this column: it checks the config's operator against
 * {@link ESCROW_OPERATORS}.
 *
 * Arc (5042) and Arc Testnet (5042002) use the x402r canonical escrow
 * (AuthCaptureEscrow `0xBdEA0D1b…`, PaymentOperatorFactory v1.0.2
 * `0xc24153B7…`). Their `operator` is a PaymentOperator address: the one the
 * factory's `computeAddress` returns, recorded on both chains in
 * `src/fixtures/arc-escrow-d.rpc.json`. Their operator generation is `'v3'`
 * ({@link OPERATOR_ABI_V3}).
 */
export const ESCROW_CONTRACTS: Record<number, AdvancedEscrowContracts> = {
  // Base Sepolia (testnet, chain 84532)
  84532: {
    operator: '0x97d53e63A9CB97556c00BeFd325AF810c9b267B2',
    escrow: '0x29025c0E9D4239d438e169570818dB9FE0A80873',
    tokenCollector: '0x5cA789000070DF15b4663DB64a50AeF5D49c5Ee0',
    protocolFeeConfig: '0x8F96C493bAC365E41f0315cf45830069EBbDCaCe',
    refundRequest: '0x1C2Ab244aC8bDdDB74d43389FF34B118aF2E90F4',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  // Base Mainnet (chain 8453)
  8453: {
    operator: '0x3D0837fF8Ea36F417261577b9BA568400A840260',
    escrow: '0xb9488351E48b23D798f24e8174514F28B741Eb4f',
    tokenCollector: '0x48ADf6E37F9b31dC2AAD0462C5862B5422C736B8',
    protocolFeeConfig: '0x59314674BAbb1a24Eb2704468a9cCdD50668a1C6',
    refundRequest: '0x35fb2EFEfAc3Ee9f6E52A9AAE5C9655bC08dEc00',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  // Ethereum Sepolia (testnet, chain 11155111)
  11155111: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  // Ethereum Mainnet (chain 1) - Updated from Ali's redeploy (commit e6cf29d)
  1: {
    operator: '0x69B67962ffb7c5C7078ff348a87DF604dfA8001b',
    escrow: '0x9D4146EF898c8E60B3e865AE254ef438E7cEd2A0',
    tokenCollector: '0x206D4DbB6E7b876e4B5EFAAD2a04e7d7813FB6ba',
    protocolFeeConfig: '0x5b3e33791C1764cF7e2573Bf8116F1D361FD97Cd',
    refundRequest: '0xFa8C4Cb156053b867Ae7489220A29b5939E3Df70',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  // Polygon (chain 137)
  137: {
    operator: '0xb33D6502EdBbC47201cd1E53C49d703EC0a660b8',
    escrow: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    tokenCollector: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    protocolFeeConfig: '0xE78648e7af7B1BaDE717FF6E410B922F92adE80f',
    refundRequest: '0xed02d3E5167BCc9582D851885A89b050AB816a56',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  // Arbitrum (chain 42161)
  42161: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  // Celo (chain 42220)
  42220: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  },
  // Monad (chain 143)
  143: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0x754704Bc059F8C67012fEd69BC8a327a5aafb603',
  },
  // Avalanche (chain 43114)
  43114: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  },
  // Optimism (chain 10)
  10: {
    operator: '0x32d6AC59BCe8DFB3026F10BcaDB8D00AB218f5b6',
    escrow: '0x320a3c35F131E5D2Fb36af56345726B298936037',
    tokenCollector: '0x230fd3A171750FA45db2976121376b7F47Cba308',
    protocolFeeConfig: '0xD979dBfBdA5f4b16AAF60Eaab32A44f352076838',
    refundRequest: '0xc1256Bb30bd0cdDa07D8C8Cf67a59105f2EA1b98',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  // SKALE Base (chain 1187947933) - CREATE3 deployment, operator via factory
  1187947933: {
    operator: '0x28c23AE8f55aDe5Ea10a5353FC40418D0c1B3d33',
    escrow: '0xBC151792f80C0EB1973d56b0235e6bee2A60e245',
    tokenCollector: '0x9A12A116a44636F55c9e135189A1321Abcfe2f30',
    protocolFeeConfig: '0xf62788834C99B2E85a6891C0b46D1EB996f8f596',
    refundRequest: '0x69e9BF2b40Ed472b55E47e9D4205d93Ed673093F',
    usdc: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
  },
  // Arc (chain 5042) - x402r canonical escrow, 'v3' operator
  5042: {
    operator: '0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D',
    escrow: '0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff',
    tokenCollector: '0x0E3dF9510de65469C4518D7843919c0b8C7A7757',
    protocolFeeConfig: '0xBe2d24614F339a1eB103A399F93AA2a39Ca815Bc',
    refundRequest: '0xe971C674fD5c3462023f3F891dF6289DFbC9CEFC',
    usdc: arcUsdc('arc').address,
  },
  // Arc Testnet (chain 5042002) - same canonical addresses as Arc
  5042002: {
    operator: '0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D',
    escrow: '0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff',
    tokenCollector: '0x0E3dF9510de65469C4518D7843919c0b8C7A7757',
    protocolFeeConfig: '0xBe2d24614F339a1eB103A399F93AA2a39Ca815Bc',
    refundRequest: '0xe971C674fD5c3462023f3F891dF6289DFbC9CEFC',
    usdc: arcUsdc('arc-testnet').address,
  },
};

/**
 * The PaymentOperator of each chain: the operator the escrow pre-auth signs
 * as `paymentInfo.operator` (and `feeReceiver`) there.
 *
 * Not the `operator` column of {@link ESCROW_CONTRACTS}: on most of those rows
 * that column is the PaymentOperatorFactory (see the gap noted there), and a
 * factory is not an operator. Each marketplace deploys its own operator from
 * the factory, so this is its own table, as in the Python SDK.
 *
 * A row is the operator of that chain in Execution Market's network registry
 * (`mcp_server/integrations/x402/network_registry.py`, read at
 * execution-market@bf1007d8), which its payment config serves, and equals
 * `uvd_x402_sdk.escrow_contracts.ESCROW_OPERATORS` row for row. Two notes:
 * SKALE Base is retired in Execution Market and its payment config no longer
 * serves it, but the row is still the operator of the escrows in flight there;
 * and Execution Market's registry has no Arc Testnet entry: that row is the
 * factory's `computeAddress` for the same operator, recorded on both Arc chains
 * in `src/fixtures/arc-escrow-d.rpc.json`. A chain without a row is signed with
 * the config's operator.
 */
export const ESCROW_OPERATORS: Readonly<Record<number, string>> = Object.freeze({
  8453: '0x271f9fa7f8907aCf178CCFB470076D9129D8F0Eb', // Base
  1187947933: '0x43E46d4587fCCc382285C52012227555ed78D183', // SKALE Base
  5042: '0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D', // Arc
  5042002: '0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D', // Arc Testnet
  1: '0x69B67962ffb7c5C7078ff348a87DF604dfA8001b', // Ethereum
  10: '0xC2377a9Db1de2520BD6b2756eD012f4E82F7938e', // Optimism
  137: '0xB87F1ECC85f074e50df3DD16A1F40e4e1EC4102e', // Polygon
  143: '0x9620Dbe2BB549E1d080Dc8e7982623A9e1Df8cC3', // Monad
  42161: '0xC2377a9Db1de2520BD6b2756eD012f4E82F7938e', // Arbitrum
  42220: '0xC2377a9Db1de2520BD6b2756eD012f4E82F7938e', // Celo
  43114: '0xC2377a9Db1de2520BD6b2756eD012f4E82F7938e', // Avalanche
});

/**
 * The fee ceiling of each chain: the highest `maxFeeBps` the escrow pre-auth
 * signs there. Above it, `buildEscrowPreAuth` refuses before signing.
 *
 * The signed `maxFeeBps` caps what the operator may take at release, and the
 * network config chooses it. This is the SDK's policy, not a contract limit:
 * the ceiling of each network is what Execution Market serves today, 1800 bps
 * on every network it serves (the `max_fee_bps` of its payment config,
 * `mcp_server/api/h2a.py`, and `FASE5_MAX_FEE_BPS`,
 * `mcp_server/integrations/x402/fees.py`, both read at execution-market@bf1007d8),
 * the operator's 1300 bps plus room for a protocol fee of up to 500. Same rows
 * as `uvd_x402_sdk.escrow_contracts.ESCROW_MAX_FEE_BPS`. A chain without a row
 * is signed with the config's bound.
 */
export const ESCROW_MAX_FEE_BPS: Readonly<Record<number, number>> = Object.freeze({
  8453: 1800, // Base
  1187947933: 1800, // SKALE Base
  5042: 1800, // Arc
  5042002: 1800, // Arc Testnet
  1: 1800, // Ethereum
  10: 1800, // Optimism
  137: 1800, // Polygon
  143: 1800, // Monad
  42161: 1800, // Arbitrum
  42220: 1800, // Celo
  43114: 1800, // Avalanche
});
