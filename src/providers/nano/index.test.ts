import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NANO_NETWORK,
  NANO_RAW_PER_XNO,
  NanoProvider,
  createMemoryNanoReplayStore,
  createNanoVerifier,
  formatNanoRaw,
  verifyNanoPayment,
  type NanoRpc,
} from './index';
import { getChainByName, getEnabledChains, getExplorerAddressUrl, getExplorerTxUrl } from '../../chains';
import { buildPaymentRequirements, createFetchPaywall, createPaymentMiddleware } from '../../backend';
import { decodeX402Header, encodeX402Header } from '../../utils';
import { decodeNanoAddress, encodeNanoAddress, isValidNanoAddress, validateRecipient } from '../../utils/validation';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map(b => parseInt(b, 16)));

// The genesis account and its public key, and the burn account (all-zero key).
const GENESIS_KEY = 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA';
const GENESIS = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const BURN = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';

const MERCHANT = encodeNanoAddress(new Uint8Array(32).fill(7));
const BUYER = encodeNanoAddress(new Uint8Array(32).fill(9));
const OTHER = encodeNanoAddress(new Uint8Array(32).fill(11));
const HASH = 'A'.repeat(64);
const PRICE = 10n ** 27n; // 0.001 XNO

function sendBlock(overrides: Record<string, unknown> = {}, contents: Record<string, unknown> = {}) {
  return {
    block_account: BUYER,
    amount: PRICE.toString(),
    balance: '0',
    height: '2',
    confirmed: 'true',
    subtype: 'send',
    contents: { type: 'state', account: BUYER, link_as_account: MERCHANT, ...contents },
    ...overrides,
  };
}
const rpcAnswering = (answer: unknown) => vi.fn<NanoRpc>().mockResolvedValue(answer);
const verify = (rpc: NanoRpc, extra: Partial<Parameters<typeof verifyNanoPayment>[0]> = {}) =>
  verifyNanoPayment({ blockHash: HASH, payTo: MERCHANT, amountRaw: PRICE, rpc, replayStore: createMemoryNanoReplayStore(), ...extra });

describe('nano:mainnet registry', () => {
  it('registers nano:mainnet with XNO, 30 decimals, outside the facilitator networks', () => {
    for (const name of ['nano:mainnet', 'NANO:MAINNET']) {
      const chain = getChainByName(name);
      expect(chain?.name, name).toBe(NANO_NETWORK);
      expect(chain?.networkType).toBe('nano');
      expect(chain?.nativeCurrency).toEqual({ name: 'Nano', symbol: 'XNO', decimals: 30 });
      expect(chain?.usdc.usdPegged).toBe(false);
      expect(chain?.x402.enabled).toBe(false);
    }
    expect(getEnabledChains().some(chain => chain.networkType === 'nano')).toBe(false);
    expect(getExplorerTxUrl(NANO_NETWORK, HASH)).toBe(`https://nanolooker.com/block/${HASH}`);
    expect(getExplorerAddressUrl(NANO_NETWORK, GENESIS)).toBe(`https://nanolooker.com/account/${GENESIS}`);
    expect(NANO_RAW_PER_XNO).toBe(10n ** 30n);
    expect(formatNanoRaw(PRICE)).toBe('0.001');
    // No USD rate: a dollar price on Nano is refused, as on XRPL.
    expect(() => buildPaymentRequirements({ amount: '1.00', recipient: MERCHANT, resource: 'https://example.test', chainName: NANO_NETWORK })).toThrow();
  });
});

describe('Nano addresses', () => {
  it('encodes real public keys to their addresses and decodes them back', () => {
    expect(encodeNanoAddress(hex(GENESIS_KEY))).toBe(GENESIS);
    expect(encodeNanoAddress(new Uint8Array(32))).toBe(BURN);
    expect(decodeNanoAddress(GENESIS)).toEqual(hex(GENESIS_KEY));
    expect(isValidNanoAddress(GENESIS.replace('nano_', 'xrb_'))).toBe(true);
  });

  it('refuses a bad checksum, a bad prefix, a bad length and a character outside the alphabet', () => {
    const last = GENESIS.at(-1) === '3' ? '4' : '3';
    expect(isValidNanoAddress(GENESIS.slice(0, -1) + last)).toBe(false);
    expect(isValidNanoAddress(GENESIS.replace('nano_', 'ban_'))).toBe(false);
    expect(isValidNanoAddress(GENESIS.slice(0, -1))).toBe(false);
    expect(isValidNanoAddress(GENESIS.slice(0, -2) + '0' + GENESIS.at(-1))).toBe(false);
    expect(() => validateRecipient(GENESIS, 'nano')).not.toThrow();
    expect(() => validateRecipient(GENESIS.slice(0, -1) + last, 'nano')).toThrow('Invalid Nano recipient');
  });
});

describe('verifyNanoPayment', () => {
  it('accepts a confirmed send of the price to payTo, read with block_info', async () => {
    const rpc = rpcAnswering(sendBlock());
    expect(await verify(rpc)).toEqual({ isValid: true, payer: BUYER, network: NANO_NETWORK, amountRaw: PRICE.toString() });
    expect(rpc).toHaveBeenCalledWith({ action: 'block_info', json_block: 'true', hash: HASH });
  });

  it('accepts an overpayment and the same account written xrb_', async () => {
    const rpc = rpcAnswering(sendBlock({ amount: (PRICE + 1n).toString() }, { link_as_account: MERCHANT.replace('nano_', 'xrb_') }));
    expect((await verify(rpc)).isValid).toBe(true);
  });

  it('refuses an underpayment by one raw', async () => {
    const result = await verify(rpcAnswering(sendBlock({ amount: (PRICE - 1n).toString() })));
    expect(result).toMatchObject({ isValid: false, invalidReason: 'nano_insufficient_amount' });
    expect(result.retryable).toBeUndefined();
  });

  it('refuses an unconfirmed block, as retryable, and does not burn its hash', async () => {
    const replayStore = createMemoryNanoReplayStore();
    const unconfirmed = await verify(rpcAnswering(sendBlock({ confirmed: 'false' })), { replayStore });
    expect(unconfirmed).toMatchObject({ isValid: false, invalidReason: 'nano_block_unconfirmed', retryable: true });
    expect((await verify(rpcAnswering(sendBlock()), { replayStore })).isValid).toBe(true);
  });

  it('refuses a send to another account', async () => {
    expect(await verify(rpcAnswering(sendBlock({}, { link_as_account: OTHER }))))
      .toMatchObject({ isValid: false, invalidReason: 'nano_wrong_destination' });
  });

  it('refuses a receive block (and any other subtype)', async () => {
    for (const subtype of ['receive', 'open', 'change', 'epoch']) {
      expect(await verify(rpcAnswering(sendBlock({ subtype }))), subtype)
        .toMatchObject({ isValid: false, invalidReason: 'nano_not_a_send_block' });
    }
  });

  it('refuses a replayed block hash, in any letter case', async () => {
    const replayStore = createMemoryNanoReplayStore();
    const rpc = rpcAnswering(sendBlock());
    expect((await verify(rpc, { replayStore })).isValid).toBe(true);
    expect(await verify(rpc, { replayStore, blockHash: HASH.toLowerCase() }))
      .toMatchObject({ isValid: false, invalidReason: 'nano_block_already_used' });
  });

  it('refuses a malformed hash without calling the node', async () => {
    const rpc = rpcAnswering(sendBlock());
    for (const blockHash of ['', 'A'.repeat(63), 'G'.repeat(64), `0x${'A'.repeat(64)}`, 42 as unknown as string]) {
      expect(await verify(rpc, { blockHash })).toMatchObject({ isValid: false, invalidReason: 'nano_malformed_block_hash' });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses a payTo or a block destination with a bad checksum', async () => {
    const last = MERCHANT.at(-1) === '3' ? '4' : '3';
    const corrupt = MERCHANT.slice(0, -1) + last;
    await expect(verify(rpcAnswering(sendBlock()), { payTo: corrupt })).rejects.toThrow('checksum');
    expect(() => createNanoVerifier({ payTo: corrupt, amountRaw: PRICE, rpc: rpcAnswering({}) })).toThrow('checksum');
    expect(await verify(rpcAnswering(sendBlock({}, { link_as_account: corrupt }))))
      .toMatchObject({ isValid: false, invalidReason: 'nano_wrong_destination' });
  });

  it('answers an RPC failure as no verdict (retryable), and an unknown block as refused', async () => {
    const down = vi.fn<NanoRpc>().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await verify(down)).toMatchObject({ isValid: false, invalidReason: 'nano_rpc_error', retryable: true });
    expect(await verify(rpcAnswering({ error: 'Unable to parse JSON' })))
      .toMatchObject({ isValid: false, invalidReason: 'nano_rpc_error', retryable: true });
    expect(await verify(rpcAnswering(null))).toMatchObject({ invalidReason: 'nano_rpc_error', retryable: true });
    const missing = await verify(rpcAnswering({ error: 'Block not found' }));
    expect(missing).toMatchObject({ isValid: false, invalidReason: 'nano_block_not_found' });
    expect(missing.retryable).toBeUndefined();
  });

  it('refuses a price that is not a positive raw integer', async () => {
    for (const amountRaw of ['0', '-1', '1.5', '1e30', 0n]) {
      await expect(verify(rpcAnswering(sendBlock()), { amountRaw })).rejects.toThrow('raw');
    }
  });
});

describe('NanoProvider', () => {
  const chain = getChainByName(NANO_NETWORK)!;

  it('holds no key: it sends through the injected send and pays with the block hash', async () => {
    const send = vi.fn().mockResolvedValue(HASH.toLowerCase());
    const provider = new NanoProvider({ address: BUYER, send });
    expect(await provider.connect()).toBe(BUYER);
    const payload = await provider.signPayment({ recipient: MERCHANT, amount: '0.001' }, chain);
    expect(send).toHaveBeenCalledWith(MERCHANT, PRICE.toString());
    expect(JSON.parse(payload)).toEqual({ blockHash: HASH });
    expect(decodeX402Header(provider.encodePaymentHeader(payload)))
      .toEqual({ x402Version: 2, scheme: 'exact', network: NANO_NETWORK, payload: { blockHash: HASH } });
    expect(Object.keys(provider)).not.toContain('privateKey');
  });

  it('pays the nano recipient when the offer lists several, and 1 XNO is 10^30 raw', async () => {
    const send = vi.fn().mockResolvedValue(HASH);
    const provider = new NanoProvider({ address: BUYER, send });
    await provider.connect(NANO_NETWORK);
    await provider.signPayment({ recipient: '0x0000000000000000000000000000000000000002', recipients: { nano: MERCHANT }, amount: '1' }, chain);
    expect(send).toHaveBeenCalledWith(MERCHANT, (10n ** 30n).toString());
  });

  it('refuses another chain, a bad recipient, self-payment and a send that returns no hash', async () => {
    const provider = new NanoProvider({ address: BUYER, send: vi.fn().mockResolvedValue('not-a-hash') });
    await expect(provider.connect('base')).rejects.toThrow('nano:mainnet');
    await provider.connect();
    await expect(provider.signPayment({ recipient: MERCHANT, amount: '1' }, getChainByName('base')!)).rejects.toThrow('nano:mainnet');
    await expect(provider.signPayment({ recipient: MERCHANT.slice(0, -1), amount: '1' }, chain)).rejects.toThrow('checksum');
    await expect(provider.signPayment({ recipient: BUYER, amount: '1' }, chain)).rejects.toThrow('distinct');
    await expect(provider.signPayment({ recipient: MERCHANT, amount: '1' }, chain)).rejects.toThrow('block hash');
  });

  it('reads the balance in XNO with account_balance', async () => {
    const rpc = rpcAnswering({ balance: (15n * 10n ** 29n).toString(), pending: '0', receivable: '0' });
    const provider = new NanoProvider({ address: BUYER, send: vi.fn(), rpc });
    expect(await provider.getBalance(chain)).toBe('1.5');
    expect(rpc).toHaveBeenCalledWith({ action: 'account_balance', account: BUYER });
  });
});

describe('createPaymentMiddleware localVerifiers.nano', () => {
  afterEach(() => vi.unstubAllGlobals());

  function expressRes() {
    const sent: { code?: number; body?: any } = {};
    const chain = (code: number) => ({
      json: (body: unknown) => { sent.code = code; sent.body = body; },
      set: () => ({ json: (body: unknown) => { sent.code = code; sent.body = body; } }),
    });
    return { res: { status: chain }, sent };
  }
  const getRequirements = () => ({
    amount: '1.00',
    recipient: '0x0000000000000000000000000000000000000002',
    resource: 'https://example.test/thing',
    chainName: 'base',
  });
  const nanoHeader = (blockHash = HASH) =>
    encodeX402Header({ x402Version: 2, scheme: 'exact', network: NANO_NETWORK, payload: { blockHash } });
  const baseHeader = () =>
    encodeX402Header({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: '0xdead',
        authorization: {
          from: '0x0000000000000000000000000000000000000001',
          to: '0x0000000000000000000000000000000000000002',
          value: '1000000',
          validAfter: '0',
          validBefore: '1800000000',
          nonce: '0x' + '11'.repeat(32),
        },
      },
    } as never);
  const facilitator = () => {
    const fetchMock = vi.fn(async (url: string) => new Response(
      JSON.stringify(url.endsWith('/verify')
        ? { isValid: true, payer: '0x0000000000000000000000000000000000000001' }
        : { success: true, transaction: '0x' + 'ab'.repeat(32), network: 'base', payer: '0x0000000000000000000000000000000000000001' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('verifies a Nano payment against the node, never the facilitator, and settles with the block hash', async () => {
    const fetchMock = facilitator();
    const rpc = rpcAnswering(sendBlock());
    const middleware = createPaymentMiddleware(getRequirements, {
      retries: 0,
      localVerifiers: { nano: createNanoVerifier({ payTo: MERCHANT, amountRaw: PRICE, rpc }) },
    });
    const req: any = { headers: { 'x-payment': nanoHeader() } };
    const next = vi.fn();
    await middleware(req, expressRes().res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await req.x402.settle()).toEqual({ success: true, transactionHash: HASH, network: NANO_NETWORK, payer: BUYER });

    // The same block again is a replay.
    const { res, sent } = expressRes();
    await middleware({ headers: { 'x-payment': nanoHeader() } }, res as never, next);
    expect(sent).toEqual({ code: 402, body: { error: 'Payment verification failed', reason: 'nano_block_already_used' } });
    expect(next).toHaveBeenCalledOnce();
  });

  it('answers an underpaid Nano payment 402 and an unreachable node 503', async () => {
    facilitator();
    const underpaid = createPaymentMiddleware(getRequirements, {
      localVerifiers: { nano: createNanoVerifier({ payTo: MERCHANT, amountRaw: PRICE, rpc: rpcAnswering(sendBlock({ amount: '1' })) }) },
    });
    const first = expressRes();
    await underpaid({ headers: { 'x-payment': nanoHeader() } }, first.res as never, () => { throw new Error('handler must not run'); });
    expect(first.sent).toEqual({ code: 402, body: { error: 'Payment verification failed', reason: 'nano_insufficient_amount' } });

    const down = createPaymentMiddleware(getRequirements, {
      localVerifiers: { nano: createNanoVerifier({ payTo: MERCHANT, amountRaw: PRICE, rpc: vi.fn<NanoRpc>().mockRejectedValue(new Error('down')) }) },
    });
    const second = expressRes();
    await down({ headers: { 'x-payment': nanoHeader() } }, second.res as never, () => { throw new Error('handler must not run'); });
    expect(second.sent.code).toBe(503);
  });

  it('leaves a Base USDC payment exactly as it was: same facilitator calls, same result', async () => {
    const run = async (options: Parameters<typeof createPaymentMiddleware>[1]) => {
      const fetchMock = facilitator();
      const req: any = { headers: { 'x-payment': baseHeader() } };
      const next = vi.fn();
      await createPaymentMiddleware(getRequirements, options)(req, expressRes().res as never, next);
      vi.unstubAllGlobals();
      return {
        calls: fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))]),
        next: next.mock.calls.length,
        // The idempotency key is random per request; everything else must match.
        settle: { ...(await req.x402.settle()), idempotencyKey: undefined },
      };
    };
    const nano = vi.fn();
    const without = await run({ retries: 0 });
    const withNano = await run({ retries: 0, localVerifiers: { nano } });
    expect(nano).not.toHaveBeenCalled();
    expect(without.calls.map(([url]) => url)).toEqual([
      'https://facilitator.ultravioletadao.xyz/verify',
      'https://facilitator.ultravioletadao.xyz/settle',
    ]);
    expect(withNano).toEqual(without);
    expect(without.next).toBe(1);
    expect(without.settle.success).toBe(true);
  });

  it('advertises a Nano accept in raw and verifies it locally in the fetch paywall', async () => {
    const fetchMock = facilitator();
    const route = createFetchPaywall({
      accepts: [{ network: NANO_NETWORK, asset: 'XNO', amount: PRICE.toString(), payTo: MERCHANT }],
      localVerifiers: { nano: createNanoVerifier({ payTo: MERCHANT, amountRaw: PRICE, rpc: rpcAnswering(sendBlock()) }) },
    })(async () => new Response('paid content'));
    const challenge = await route(new Request('https://example.test/thing'));
    expect(challenge.status).toBe(402);
    expect((await challenge.json()).accepts).toEqual([expect.objectContaining({ network: NANO_NETWORK, asset: 'XNO', amount: PRICE.toString(), payTo: MERCHANT })]);
    const paid = await route(new Request('https://example.test/thing', { headers: { 'X-PAYMENT': nanoHeader() } }));
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe('paid content');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
