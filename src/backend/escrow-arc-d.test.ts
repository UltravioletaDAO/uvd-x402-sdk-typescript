import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getChainByName } from '../chains';
import {
  AdvancedEscrowClient,
  ESCROW_CONTRACTS,
  ESCROW_NOTHING_TO_VOID,
  ESCROW_OPERATOR_NOT_DEPLOYED,
  ESCROW_UNSUPPORTED_ON_GENERATION,
  ESCROW_VOID_AMOUNT_MISMATCH,
  OPERATOR_ABI,
  OPERATOR_ABI_CREATE3,
  OPERATOR_ABI_V3,
  USDC_DOMAIN_NAME,
  getEscrowContractsByChainId,
  getEscrowOperatorGeneration,
  isEscrowSupportedOnChain,
} from './index';
import type { AdvancedPaymentInfo } from './index';

/**
 * Arc (5042) and Arc Testnet (5042002) on the x402r canonical escrow, with a
 * 'v3' operator. Chain facts come from `src/fixtures/arc-escrow-d.rpc.json`,
 * recorded from the public Arc RPCs by `scripts/record-arc-escrow-d.mjs`.
 * Nothing here reaches a network: sends are captured, reads are served by
 * doubles, `fetch` is stubbed.
 */

const RPC = JSON.parse(readFileSync(resolve(__dirname, '..', 'fixtures', 'arc-escrow-d.rpc.json'), 'utf8'));
const ARC = [5042, 5042002];

function read(chainId: number, label: string): any {
  const entry = RPC.chains[String(chainId)].reads.find((r: any) => r.label === label);
  if (!entry) throw new Error(`no recorded read '${label}' on chain ${chainId}`);
  return entry;
}

/** Recorded hex of 32 bytes or more is stored without 0x. */
const hex = (value: string) => (value.startsWith('0x') ? value : '0x' + value);

const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();
const decodeAddress = (value: string) => ethers.getAddress(ABI_CODER.decode(['address'], hex(value))[0]);

const PI_TUPLE =
  'tuple(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt)';

// The escrow reads, as the real AuthCaptureEscrow answered them in the fixture.
const ESCROW_READS = new ethers.Interface([
  `function getHash(${PI_TUPLE} paymentInfo) view returns (bytes32)`,
  'function paymentState(bytes32) view returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount)',
]);
const OPERATOR_V3 = new ethers.Interface(OPERATOR_ABI_V3);

const PAYER = '0x2222222222222222222222222222222222222222';
const RECEIVER = '0x1111111111111111111111111111111111111111';
const SIGNATURE = '0x' + '11'.repeat(65);
const FACILITATOR_URL = 'http://facilitator.invalid';
const PAYMENT_HASH = '0x' + 'c0'.repeat(32);
const OPERATOR_CODE = '0x6080604052';

function paymentInfo(chainId: number, maxAmount = '5000000'): AdvancedPaymentInfo {
  const c = ESCROW_CONTRACTS[chainId];
  return {
    operator: c.operator,
    receiver: RECEIVER,
    token: c.usdc,
    maxAmount,
    preApprovalExpiry: 1760003600,
    authorizationExpiry: 1761036800,
    refundExpiry: 1761641600,
    minFeeBps: 0,
    maxFeeBps: 1800,
    feeReceiver: c.operator,
    salt: '0x5eedc0de',
  };
}

/** The on-chain tuple the client builds: the payer is the signer. */
function tupleOf(pi: AdvancedPaymentInfo): unknown[] {
  return [
    pi.operator, PAYER, pi.receiver, pi.token, pi.maxAmount, pi.preApprovalExpiry,
    pi.authorizationExpiry, pi.refundExpiry, pi.minFeeBps, pi.maxFeeBps, pi.feeReceiver, pi.salt,
  ];
}

interface ChainDouble {
  capturable?: bigint;
  operatorCode?: string;
}

/** Serves getCode and the two escrow reads; records what was asked. */
function chainReads({ capturable = 5_000_000n, operatorCode = OPERATOR_CODE }: ChainDouble) {
  const log: Array<{ kind: string; to: string; name?: string; args?: unknown[] }> = [];
  const getCode = async (address: string) => {
    log.push({ kind: 'getCode', to: address });
    return operatorCode;
  };
  const call = async (tx: { to: string; data: string }) => {
    const parsed = ESCROW_READS.parseTransaction({ data: tx.data });
    if (!parsed) throw new Error(`unexpected read ${tx.data.slice(0, 10)}`);
    log.push({ kind: 'call', to: tx.to, name: parsed.name, args: parsed.args.toArray(true) });
    if (parsed.name === 'getHash') return ESCROW_READS.encodeFunctionResult('getHash', [PAYMENT_HASH]);
    if (parsed.args[0] !== PAYMENT_HASH) throw new Error('paymentState asked for another hash');
    return ESCROW_READS.encodeFunctionResult('paymentState', [false, capturable, 0n]);
  };
  return { log, getCode, call };
}

function signerClient(chainId: number, double: ChainDouble = {}) {
  const reads = chainReads(double);
  const sent: Array<{ to: string; data: string }> = [];
  const signTypedData = vi.fn(async () => SIGNATURE);
  const txHash = '0x' + 'ab'.repeat(32);
  const signer = {
    provider: {
      getCode: reads.getCode,
      call: reads.call,
      // What ethers' ContractTransactionResponse.wait() reads back.
      getTransactionReceipt: async () => ({ status: 1, hash: txHash, logs: [], gasUsed: 21000n, blockNumber: 1 }),
    },
    getAddress: async () => PAYER,
    signTypedData,
    sendTransaction: async (tx: { to: string; data: string }) => {
      sent.push({ to: tx.to, data: tx.data });
      return { hash: txHash, to: tx.to, data: tx.data };
    },
  };
  const client = new AdvancedEscrowClient(signer, { chainId, facilitatorUrl: FACILITATOR_URL });
  return { client, sent, reads, signTypedData };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Arc escrow registry (x402r canonical escrow)', () => {
  const EXPECTED = {
    operator: '0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D',
    escrow: '0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff',
    tokenCollector: '0x0E3dF9510de65469C4518D7843919c0b8C7A7757',
    protocolFeeConfig: '0xBe2d24614F339a1eB103A399F93AA2a39Ca815Bc',
    refundRequest: '0xe971C674fD5c3462023f3F891dF6289DFbC9CEFC',
    usdc: '0x3600000000000000000000000000000000000000',
  };

  it.each(ARC)('ESCROW_CONTRACTS[%i] is the canonical escrow with its operator', (chainId) => {
    expect(ESCROW_CONTRACTS[chainId]).toEqual(EXPECTED);
    expect(getEscrowContractsByChainId(chainId)).toBe(ESCROW_CONTRACTS[chainId]);
    expect(isEscrowSupportedOnChain(chainId)).toBe(true);
    expect(getEscrowOperatorGeneration(chainId)).toBe('v3');
  });

  it.each(ARC)('the recorder read the same addresses the registry ships (%i)', (chainId) => {
    expect(RPC.addresses).toEqual({ ...EXPECTED, operatorFactory: '0xc24153B7ED8DC03e551F29DDEeA5CadFe57e2716' });
    expect(read(chainId, 'eth_chainId').result).toBe(ethers.toQuantity(chainId));
  });

  it.each(ARC)('every contract but the operator has code on %i at the recorded block', (chainId) => {
    for (const name of ['operatorFactory', 'escrow', 'tokenCollector', 'protocolFeeConfig', 'refundRequest', 'usdc']) {
      const entry = read(chainId, `code.${name}`);
      const bytes = entry.result !== undefined ? entry.result.length / 2 : entry.resultBytes;
      expect(bytes, `${name} on ${chainId}`).toBeGreaterThan(0);
    }
  });

  it.each(ARC)('the factory and the token collector are bound to this escrow on %i', (chainId) => {
    const c = ESCROW_CONTRACTS[chainId];
    expect(decodeAddress(read(chainId, 'operatorFactory.ESCROW').result)).toBe(c.escrow);
    expect(decodeAddress(read(chainId, 'operatorFactory.PROTOCOL_FEE_CONFIG').result)).toBe(c.protocolFeeConfig);
    expect(decodeAddress(read(chainId, 'tokenCollector.authCaptureEscrow').result)).toBe(c.escrow);
  });

  it('takes the USDC address and its EIP-712 name from the chain registry', () => {
    for (const [chainId, network] of [[5042, 'arc'], [5042002, 'arc-testnet']] as const) {
      const usdc = getChainByName(network)!.usdc;
      expect(ESCROW_CONTRACTS[chainId].usdc).toBe(usdc.address);
      expect(USDC_DOMAIN_NAME[chainId]).toBe(usdc.name);
      expect(USDC_DOMAIN_NAME[chainId]).toBe('USDC');
    }
  });

  it('still throws for a chain outside the registry', () => {
    expect(() => new AdvancedEscrowClient({ getAddress: async () => PAYER }, { chainId: 999999 })).toThrow(
      /No escrow contracts found for chain ID 999999/,
    );
  });

  it('carries no address of the older escrow generations', () => {
    const older = [
      '0xF8211868187974a7Fb9d99b8fFB171AD70665Dc6',
      '0x0308703621160b894cF045E555686d99ee8bd94E',
      '0x7561DC178D9aD5bc5fb103C01f448A510d2A36D0',
      '0xD8490609d2da0ee626b0e676941b225cbc1A8C08',
      '0x15f36140bC1d444f917D306d0f5be223F55709B6',
      '0xBC151792f80C0EB1973d56b0235e6bee2A60e245',
    ].map((a) => a.toLowerCase());
    for (const chainId of ARC) {
      const entry = JSON.stringify(ESCROW_CONTRACTS[chainId]).toLowerCase();
      for (const address of older) expect(entry, `${address} in ${chainId}`).not.toContain(address.slice(2));
    }
  });
});

describe('the Arc operator address is the factory computeAddress result', () => {
  // The configuration the operator is computed from. Data only.
  const CONFIG = [
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
  const FACTORY = new ethers.Interface([
    'function computeAddress(tuple(address,address,address,address,address,address,address,address,address,address,address,address) config) view returns (address)',
  ]);

  it.each(ARC)('re-encoded calldata equals the recorded call, and its answer is the registry operator (%i)', (chainId) => {
    const recorded = read(chainId, 'operatorFactory.computeAddress');
    expect(recorded.request.params[0].to).toBe('0xc24153B7ED8DC03e551F29DDEeA5CadFe57e2716');
    expect(FACTORY.encodeFunctionData('computeAddress', [CONFIG])).toBe(hex(recorded.request.params[0].data));
    expect(decodeAddress(recorded.result)).toBe(ESCROW_CONTRACTS[chainId].operator);
  });
});

describe('OPERATOR_ABI_V3 against the recorded factory bytecode', () => {
  const code = read(5042, 'code.operatorFactory').result as string;
  const selector = (abi: string[], name: string) => new ethers.Interface(abi).getFunction(name)!.selector;
  const push4 = (sel: string) => '63' + sel.slice(2);

  it('has the selectors the canonical operator publishes', () => {
    expect(OPERATOR_V3.getFunction('capture')!.selector).toBe('0xf12b86f6');
    expect(OPERATOR_V3.getFunction('void')!.selector).toBe('0xc3c5090e');
    expect(OPERATOR_V3.getFunction('FEE_RECEIVER')!.selector).toBe('0xd3e78e4d');
  });

  it('finds every OPERATOR_ABI_V3 function in the operator code the factory deploys', () => {
    OPERATOR_V3.forEachFunction((fn) => {
      expect(code.includes(push4(fn.selector)), `${fn.format()} ${fn.selector}`).toBe(true);
    });
  });

  it('finds none of the v1/v2 calls there, which is why v3 is mapped', () => {
    const absent = [
      selector(OPERATOR_ABI, 'release'),
      selector(OPERATOR_ABI, 'refundInEscrow'),
      selector(OPERATOR_ABI, 'charge'),
      selector(OPERATOR_ABI, 'refundPostEscrow'),
      selector(OPERATOR_ABI_CREATE3, 'release'),
      selector(OPERATOR_ABI_CREATE3, 'refundInEscrow'),
    ];
    for (const sel of absent) expect(code.includes(sel.slice(2)), sel).toBe(false);
  });

  it('is the same factory code on Arc Testnet', () => {
    expect(hex(read(5042002, 'code.operatorFactory').resultKeccak)).toBe(ethers.keccak256(hex(code)));
  });

  it('reads the escrow with the ABI the real escrow answered', () => {
    const state = ESCROW_READS.decodeFunctionResult('paymentState', hex(read(5042, 'escrow.paymentState.static').result));
    expect(state.toArray()).toEqual([false, 0n, 0n]);
    expect(hex(read(5042, 'escrow.getHash.static').request.params[0].data).slice(0, 10)).toBe(
      ESCROW_READS.getFunction('getHash')!.selector,
    );
  });
});

describe("v3 operator calls, ethers.Signer mode", () => {
  const chainId = 5042;
  const operator = ESCROW_CONTRACTS[chainId].operator;

  it('release sends capture(paymentInfo, maxAmount, 0x) to the operator', async () => {
    const pi = paymentInfo(chainId);
    const { client, sent } = signerClient(chainId);
    const result = await client.release(pi);
    expect(result.success).toBe(true);
    expect(sent).toEqual([{ to: operator, data: OPERATOR_V3.encodeFunctionData('capture', [tupleOf(pi), '5000000', '0x']) }]);
    expect(sent[0].data.slice(0, 10)).toBe('0xf12b86f6');
  });

  it('release with an amount captures exactly that amount', async () => {
    const pi = paymentInfo(chainId);
    const { client, sent } = signerClient(chainId);
    await client.release(pi, '1250000');
    expect(sent).toEqual([{ to: operator, data: OPERATOR_V3.encodeFunctionData('capture', [tupleOf(pi), '1250000', '0x']) }]);
  });

  it('refundInEscrow(capturableAmount) sends void(paymentInfo, 0x) after reading that amount', async () => {
    const pi = paymentInfo(chainId);
    const { client, sent, reads } = signerClient(chainId, { capturable: 3_750_000n });
    const result = await client.refundInEscrow(pi, '3750000');
    expect(result.success).toBe(true);
    expect(sent).toEqual([{ to: operator, data: OPERATOR_V3.encodeFunctionData('void', [tupleOf(pi), '0x']) }]);
    expect(sent[0].data.slice(0, 10)).toBe('0xc3c5090e');
    const escrowReads = reads.log.filter((r) => r.kind === 'call');
    expect(escrowReads.map((r) => [r.to, r.name])).toEqual([
      [ESCROW_CONTRACTS[chainId].escrow, 'getHash'],
      [ESCROW_CONTRACTS[chainId].escrow, 'paymentState'],
    ]);
    expect(escrowReads[0].args![0]).toEqual(
      ethers.AbiCoder.defaultAbiCoder().decode([PI_TUPLE], ethers.AbiCoder.defaultAbiCoder().encode([PI_TUPLE], [tupleOf(pi)])).toArray(true)[0],
    );
  });

  it('refundInEscrow() with no amount voids when maxAmount is still all capturable', async () => {
    const pi = paymentInfo(chainId);
    const { client, sent } = signerClient(chainId, { capturable: 5_000_000n });
    expect((await client.refundInEscrow(pi)).success).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['part of it', '1250000', 5_000_000n],
    ['more than it', '6000000', 5_000_000n],
    ['maxAmount after a partial release', undefined, 3_750_000n],
  ])('refundInEscrow for %s is refused with no transaction', async (_label, amount, capturable) => {
    const { client, sent } = signerClient(chainId, { capturable });
    const result = await client.refundInEscrow(paymentInfo(chainId), amount);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ESCROW_VOID_AMOUNT_MISMATCH);
    expect(result.error).toContain(String(capturable));
    expect(sent).toEqual([]);
  });

  it('refundInEscrow with nothing capturable is its own refusal, not the partial one', async () => {
    const { client, sent } = signerClient(chainId, { capturable: 0n });
    const result = await client.refundInEscrow(paymentInfo(chainId), '5000000');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ESCROW_NOTHING_TO_VOID);
    expect(result.errorCode).not.toBe(ESCROW_VOID_AMOUNT_MISMATCH);
    expect(sent).toEqual([]);
  });

  it('refundInEscrow with a zero amount is refused before reading the chain', async () => {
    const { client, sent, reads } = signerClient(chainId);
    const result = await client.refundInEscrow(paymentInfo(chainId), '0');
    expect(result.success).toBe(false);
    expect(reads.log).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each([
    ['release', (c: AdvancedEscrowClient, pi: AdvancedPaymentInfo) => c.release(pi)],
    ['refundInEscrow', (c: AdvancedEscrowClient, pi: AdvancedPaymentInfo) => c.refundInEscrow(pi)],
  ])('%s against an operator with no code sends nothing', async (_name, call) => {
    const { client, sent } = signerClient(chainId, { operatorCode: '0x' });
    const result = await call(client, paymentInfo(chainId));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ESCROW_OPERATOR_NOT_DEPLOYED);
    expect(sent).toEqual([]);
  });

  it.each([
    ['charge', (c: AdvancedEscrowClient, pi: AdvancedPaymentInfo) => c.charge(pi)],
    ['refundPostEscrow', (c: AdvancedEscrowClient, pi: AdvancedPaymentInfo) => c.refundPostEscrow(pi)],
  ])('%s is refused on v3 without signing or sending', async (_name, call) => {
    const { client, sent, signTypedData, reads } = signerClient(chainId);
    const result = await call(client, paymentInfo(chainId));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(ESCROW_UNSUPPORTED_ON_GENERATION);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(reads.log).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a signer with no provider cannot run a v3 call and sends nothing', async () => {
    const sent: unknown[] = [];
    const signer = {
      provider: null,
      getAddress: async () => PAYER,
      sendTransaction: async (tx: unknown) => {
        sent.push(tx);
        throw new Error('must not send');
      },
    };
    const client = new AdvancedEscrowClient(signer, { chainId });
    const result = await client.release(paymentInfo(chainId));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no provider/);
    expect(sent).toEqual([]);
  });
});

describe('v3 operator calls, SigningWalletAdapter mode', () => {
  const chainId = 5042002;
  const operator = ESCROW_CONTRACTS[chainId].operator;

  function adapterClient(double: ChainDouble = {}) {
    const reads = chainReads(double);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getCode').mockImplementation(reads.getCode as any);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'call').mockImplementation(reads.call as any);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionCount').mockResolvedValue(3);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue(
      new ethers.FeeData(null, 2_000_000_000n, 1_000_000_000n),
    );
    const signed: Array<{ to: string | null; data: string; chainId: bigint }> = [];
    const wallet = {
      getAddress: () => PAYER,
      signTransaction: async (unsignedSerialized: string) => {
        const tx = ethers.Transaction.from(unsignedSerialized);
        signed.push({ to: tx.to, data: tx.data, chainId: tx.chainId });
        throw new Error('signed, not broadcast');
      },
    };
    const client = new AdvancedEscrowClient(null, { chainId, wallet: wallet as any, rpcUrl: 'http://127.0.0.1:9' });
    return { client, signed, reads };
  }

  it('release signs capture(paymentInfo, amount, 0x) for the operator', async () => {
    const pi = paymentInfo(chainId);
    const { client, signed } = adapterClient();
    const result = await client.release(pi, '2000000');
    expect(result.success).toBe(false);
    expect(signed).toEqual([
      { to: operator, data: OPERATOR_V3.encodeFunctionData('capture', [tupleOf(pi), '2000000', '0x']), chainId: 5042002n },
    ]);
  });

  it('refundInEscrow signs void(paymentInfo, 0x) only for the whole capturable amount', async () => {
    const pi = paymentInfo(chainId);
    const { client, signed } = adapterClient({ capturable: 5_000_000n });
    await client.refundInEscrow(pi, '5000000');
    expect(signed).toEqual([
      { to: operator, data: OPERATOR_V3.encodeFunctionData('void', [tupleOf(pi), '0x']), chainId: 5042002n },
    ]);
  });

  it('refundInEscrow for part of it signs nothing', async () => {
    const { client, signed } = adapterClient({ capturable: 5_000_000n });
    const result = await client.refundInEscrow(paymentInfo(chainId), '1000000');
    expect(result.errorCode).toBe(ESCROW_VOID_AMOUNT_MISMATCH);
    expect(signed).toEqual([]);
  });
});

describe('authorize on Arc signs the nonce the escrow itself computes', () => {
  // The PaymentInfo whose payer-agnostic hash the recorder read from
  // AuthCaptureEscrow.getHash on each chain.
  function recordedPaymentInfo(chainId: number): AdvancedPaymentInfo {
    return {
      ...paymentInfo(chainId, '100000'),
      authorizationExpiry: 1760007200,
      refundExpiry: 1760086400,
      salt: '0x' + 'ab'.repeat(32),
    };
  }

  it.each(ARC)('nonce, domain and collector on %i', async (chainId) => {
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ success: true, transaction: '0xfeed' }) };
      }),
    );
    const typedData: any[] = [];
    const signer = {
      getAddress: async () => PAYER,
      signTypedData: async (domain: unknown, _types: unknown, message: unknown) => {
        typedData.push({ domain, message });
        return SIGNATURE;
      },
    };
    const client = new AdvancedEscrowClient(signer, { chainId, facilitatorUrl: FACILITATOR_URL });
    const result = await client.authorize(recordedPaymentInfo(chainId));
    expect(result.success).toBe(true);

    const c = ESCROW_CONTRACTS[chainId];
    const onChainHash = hex(read(chainId, 'escrow.getHash.static').result);
    expect(typedData).toEqual([
      {
        domain: { name: 'USDC', version: '2', chainId, verifyingContract: c.usdc },
        message: {
          from: PAYER,
          to: c.tokenCollector,
          value: '100000',
          validAfter: '0',
          validBefore: '1760003600',
          nonce: onChainHash,
        },
      },
    ]);
    expect(bodies[0].paymentRequirements.network).toBe(`eip155:${chainId}`);
    expect(bodies[0].paymentRequirements.extra).toEqual({
      escrowAddress: c.escrow,
      operatorAddress: c.operator,
      tokenCollector: c.tokenCollector,
    });
  });
});
