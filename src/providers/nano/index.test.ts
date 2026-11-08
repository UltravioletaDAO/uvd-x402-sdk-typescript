import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NANO_NETWORK,
  NANO_RAW_PER_XNO,
  NanoProvider,
  SqliteNanoReplayStore,
  createNanoOrderIssuer,
  createNanoVerifier,
  createVolatileNanoReplayStore,
  nanoCommitmentAccount,
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

const NOW = 1_800_000_000;
const issuer = createNanoOrderIssuer({ secret: 'test-secret-0123456789', ttlSeconds: 600, now: () => NOW });
const RESOURCE = 'https://example.test/thing';
const order = issuer.issue({ payTo: MERCHANT, amountRaw: PRICE, resource: RESOURCE });
const requirement = { orderId: order.orderId, payTo: MERCHANT, amountRaw: PRICE, issuedAt: order.issuedAt, expiresAt: order.expiresAt };
/** A store the tests may use: persistent in the contract's eyes, held in memory. */
const testStore = () => ({ ...createVolatileNanoReplayStore(), persistent: true as const });

function sendBlock(overrides: Record<string, unknown> = {}, contents: Record<string, unknown> = {}) {
  return {
    block_account: BUYER,
    amount: PRICE.toString(),
    balance: '0',
    height: '2',
    confirmed: 'true',
    subtype: 'send',
    local_timestamp: String(NOW + 30),
    contents: { type: 'state', account: BUYER, link_as_account: MERCHANT, representative: order.representative, ...contents },
    ...overrides,
  };
}
const rpcAnswering = (answer: unknown) => vi.fn<NanoRpc>().mockResolvedValue(answer);
const verify = (rpc: NanoRpc, extra: Partial<Parameters<typeof verifyNanoPayment>[0]> = {}) =>
  verifyNanoPayment({ blockHash: HASH, requirement, rpc, replayStore: testStore(), ...extra });

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

describe('order commitment', () => {
  it('matches the XNO binding standard test vector (option C)', () => {
    expect(nanoCommitmentAccount('order-0001', BURN, 50000000000000000000000000000n))
      .toBe('nano_33q9dassq66es6mcay83n5kypqgpzjikr9bkc9ope9xch1borfphgehj4ozj');
  });

  it('changes with the order, the destination and the price', () => {
    const base = nanoCommitmentAccount('a', MERCHANT, PRICE);
    expect(nanoCommitmentAccount('b', MERCHANT, PRICE)).not.toBe(base);
    expect(nanoCommitmentAccount('a', OTHER, PRICE)).not.toBe(base);
    expect(nanoCommitmentAccount('a', MERCHANT, PRICE + 1n)).not.toBe(base);
  });
});

describe('createNanoOrderIssuer', () => {
  const req = { payTo: MERCHANT, amountRaw: PRICE.toString(), resource: RESOURCE };

  it('issues a window and a commitment, and accepts its own id for the same request only', () => {
    expect(order.expiresAt - order.issuedAt).toBe(600);
    expect(order.representative).toBe(nanoCommitmentAccount(order.orderId, MERCHANT, PRICE));
    expect(issuer.check(order.orderId, req)).toEqual({ ok: true, requirement: { ...requirement, amountRaw: PRICE.toString() } });
    expect(issuer.check(order.orderId, { ...req, resource: 'https://example.test/other' })).toEqual({ ok: false, reason: 'nano_order_not_issued_for_this_request' });
    expect(issuer.check(order.orderId, { ...req, amountRaw: '1' })).toEqual({ ok: false, reason: 'nano_order_not_issued_for_this_request' });
    expect(issuer.check(order.orderId, { ...req, payTo: OTHER })).toEqual({ ok: false, reason: 'nano_order_not_issued_for_this_request' });
  });

  it('refuses a forged window, an id from another secret, a malformed id and a missing one', () => {
    const [nonce, issued, expires, mac] = order.orderId.split('.');
    expect(issuer.check([nonce, issued, String(Number(expires) + 99999), mac].join('.'), req))
      .toEqual({ ok: false, reason: 'nano_order_not_issued_for_this_request' });
    const other = createNanoOrderIssuer({ secret: 'another-secret-0123456789', now: () => NOW });
    expect(other.check(order.orderId, req)).toMatchObject({ ok: false });
    expect(issuer.check('nope', req)).toEqual({ ok: false, reason: 'nano_order_malformed' });
    expect(issuer.check(undefined, req)).toEqual({ ok: false, reason: 'nano_order_missing' });
  });

  it('gives every request its own id, and refuses a short secret', () => {
    expect(issuer.issue(req).orderId).not.toBe(issuer.issue(req).orderId);
    expect(() => createNanoOrderIssuer({ secret: 'short' })).toThrow('16 bytes');
    expect(() => createNanoOrderIssuer({ secret: 'x'.repeat(16), ttlSeconds: 0 })).toThrow('ttlSeconds');
  });
});

describe('verifyNanoPayment', () => {
  it('accepts a confirmed send of the price to payTo, bound to the order, inside the window', async () => {
    const rpc = rpcAnswering(sendBlock());
    expect(await verify(rpc)).toEqual({ isValid: true, payer: BUYER, network: NANO_NETWORK, amountRaw: PRICE.toString() });
    expect(rpc).toHaveBeenCalledWith({ action: 'block_info', json_block: 'true', hash: HASH });
  });

  it('accepts an overpayment and the same account written xrb_', async () => {
    const rpc = rpcAnswering(sendBlock({ amount: (PRICE + 1n).toString() }, { link_as_account: MERCHANT.replace('nano_', 'xrb_') }));
    expect((await verify(rpc)).isValid).toBe(true);
  });

  it('refuses a block that is not bound to this order (the old code accepted any send to payTo)', async () => {
    // Somebody else's payment, seen on the ledger: right destination, right amount, no commitment.
    for (const representative of [BUYER, OTHER, nanoCommitmentAccount('another-order', MERCHANT, PRICE), undefined]) {
      expect(await verify(rpcAnswering(sendBlock({}, { representative }))), String(representative))
        .toMatchObject({ isValid: false, invalidReason: 'nano_block_not_bound_to_order' });
    }
  });

  it('refuses a block made before the order was issued or after it expired', async () => {
    for (const local_timestamp of [String(order.issuedAt - 1), String(order.expiresAt + 1)]) {
      expect(await verify(rpcAnswering(sendBlock({ local_timestamp }))))
        .toMatchObject({ isValid: false, invalidReason: 'nano_block_outside_order_window' });
    }
    for (const local_timestamp of [String(order.issuedAt), String(order.expiresAt)]) {
      expect((await verify(rpcAnswering(sendBlock({ local_timestamp })))).isValid).toBe(true);
    }
  });

  it('refuses a block whose time the node does not know', async () => {
    for (const local_timestamp of ['0', undefined, 'x']) {
      expect(await verify(rpcAnswering(sendBlock({ local_timestamp }))))
        .toMatchObject({ isValid: false, invalidReason: 'nano_block_time_unknown' });
    }
  });

  it('refuses an underpayment by one raw', async () => {
    const result = await verify(rpcAnswering(sendBlock({ amount: (PRICE - 1n).toString() })));
    expect(result).toMatchObject({ isValid: false, invalidReason: 'nano_insufficient_amount' });
    expect(result.retryable).toBeUndefined();
  });

  it('refuses an unconfirmed block, as retryable, and does not burn its hash', async () => {
    const replayStore = testStore();
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

  it('refuses a replayed block hash, in any letter case, and a second block for the same order', async () => {
    const replayStore = testStore();
    const rpc = rpcAnswering(sendBlock());
    expect((await verify(rpc, { replayStore })).isValid).toBe(true);
    expect(await verify(rpc, { replayStore, blockHash: HASH.toLowerCase() }))
      .toMatchObject({ isValid: false, invalidReason: 'nano_block_already_used' });
    expect(await verify(rpc, { replayStore, blockHash: 'B'.repeat(64) }))
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
    await expect(verify(rpcAnswering(sendBlock()), { requirement: { ...requirement, payTo: corrupt } })).rejects.toThrow('checksum');
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

  it('refuses a price that is not a positive raw integer and a requirement without a window', async () => {
    for (const amountRaw of ['0', '-1', '1.5', '1e30', 0n]) {
      await expect(verify(rpcAnswering(sendBlock()), { requirement: { ...requirement, amountRaw } })).rejects.toThrow('raw');
    }
    await expect(verify(rpcAnswering(sendBlock()), { requirement: { ...requirement, expiresAt: requirement.issuedAt } })).rejects.toThrow('window');
    await expect(verify(rpcAnswering(sendBlock()), { requirement: { ...requirement, orderId: '' } })).rejects.toThrow('orderId');
  });

  it('requires a persistent replay store', async () => {
    await expect(verify(rpcAnswering(sendBlock()), { replayStore: createVolatileNanoReplayStore() })).rejects.toThrow('persistent');
    await expect(verify(rpcAnswering(sendBlock()), { replayStore: undefined as never })).rejects.toThrow('persistent');
  });
});

describe('createNanoVerifier', () => {
  const requirements = { payTo: MERCHANT, maxAmountRequired: PRICE.toString(), resource: RESOURCE } as never;
  const payment = (orderId: unknown = order.orderId, blockHash = HASH) => ({ x402Version: 2, scheme: 'exact', network: NANO_NETWORK, payload: { blockHash, orderId } }) as never;

  it('has no default replay store: one is required, and a volatile one is refused', () => {
    const rpc = rpcAnswering({});
    expect(() => createNanoVerifier({ rpc, issuer } as never)).toThrow('replayStore is required');
    expect(() => createNanoVerifier({ rpc, issuer, replayStore: createVolatileNanoReplayStore() })).toThrow('persistent');
    expect(() => createNanoVerifier({ rpc, issuer, replayStore: createVolatileNanoReplayStore(), allowVolatileReplayStore: true })).not.toThrow();
    expect(() => createNanoVerifier({ rpc, replayStore: testStore() } as never)).toThrow('issuer is required');
  });

  it('verifies against the requirements of the request, not against the header', async () => {
    const verifier = createNanoVerifier({ rpc: rpcAnswering(sendBlock()), issuer, replayStore: testStore() });
    expect((await verifier(payment(), requirements)).isValid).toBe(true);
  });

  it('refuses an order id issued for another resource or price, a missing one, and a payment for a cheaper requirement', async () => {
    const verifier = createNanoVerifier({ rpc: rpcAnswering(sendBlock()), issuer, replayStore: testStore() });
    expect(await verifier(payment(), { ...(requirements as object), resource: 'https://example.test/other' } as never))
      .toMatchObject({ isValid: false, invalidReason: 'nano_order_not_issued_for_this_request' });
    expect(await verifier(payment(), { ...(requirements as object), maxAmountRequired: '1' } as never))
      .toMatchObject({ isValid: false, invalidReason: 'nano_order_not_issued_for_this_request' });
    expect(await verifier(payment(null), requirements)).toMatchObject({ isValid: false, invalidReason: 'nano_order_missing' });
    expect(await verifier(payment(), { ...(requirements as object), payTo: 'nope' } as never))
      .toMatchObject({ isValid: false, invalidReason: 'nano_bad_requirements' });
  });

  it('refuses the same hash presented again by anyone', async () => {
    const verifier = createNanoVerifier({ rpc: rpcAnswering(sendBlock()), issuer, replayStore: testStore() });
    expect((await verifier(payment(), requirements)).isValid).toBe(true);
    expect(await verifier(payment(), requirements)).toMatchObject({ isValid: false, invalidReason: 'nano_block_already_used' });
  });
});

describe('SqliteNanoReplayStore', () => {
  /** A stand-in with better-sqlite3's surface and a UNIQUE/PRIMARY KEY behaviour, so the contract is tested without a native build. */
  function fakeDb(synchronous = 2) {
    const rows: Array<[string, string, number]> = [];
    const db = {
      exec: vi.fn(),
      pragma: vi.fn(() => synchronous),
      prepare: vi.fn((sql: string) => ({
        run: (...p: unknown[]) => {
          if (sql.startsWith('INSERT')) {
            if (rows.some(r => r[0] === p[0] || r[1] === p[1])) throw Object.assign(new Error('UNIQUE'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
            rows.push([p[0] as string, p[1] as string, p[2] as number]);
          } else if (sql.startsWith('DELETE')) {
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i][2] < (p[0] as number)) rows.splice(i, 1);
          }
        },
        get: () => undefined,
      })),
    };
    return { db, rows };
  }

  it('claims a block and an order once each, refuses either again, and prunes by window end', () => {
    const { db, rows } = fakeDb();
    const store = new SqliteNanoReplayStore(db as never);
    expect(store.persistent).toBe(true);
    expect(store.claim('H1', 'O1', 100)).toBe(true);
    expect(store.claim('H1', 'O2', 100)).toBe(false);
    expect(store.claim('H2', 'O1', 100)).toBe(false);
    expect(store.claim('H2', 'O2', 200)).toBe(true);
    store.prune(150);
    expect(rows.map(r => r[0])).toEqual(['H2']);
  });

  it('refuses a connection that can lose a commit, and rethrows a failure that is not a constraint', () => {
    expect(() => new SqliteNanoReplayStore(fakeDb(1).db as never)).toThrow('synchronous');
    const { db } = fakeDb();
    const store = new SqliteNanoReplayStore(db as never);
    db.prepare = vi.fn(() => ({ run: () => { throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); }, get: () => undefined }));
    const broken = new SqliteNanoReplayStore(db as never);
    expect(() => broken.claim('H', 'O', 1)).toThrow('disk full');
    expect(store.claim('X', 'Y', 1)).toBe(true);
  });
});

describe('NanoProvider', () => {
  const chain = getChainByName(NANO_NETWORK)!;
  const info = (overrides: Record<string, unknown> = {}) => ({
    recipient: MERCHANT,
    amount: '0.001',
    accepted: { extra: { nano: order } },
    ...overrides,
  }) as never;

  it('holds no key: it sends through the injected send, commits to the order, and pays with the block hash', async () => {
    const send = vi.fn().mockResolvedValue(HASH.toLowerCase());
    const provider = new NanoProvider({ address: BUYER, send });
    expect(await provider.connect()).toBe(BUYER);
    const payload = await provider.signPayment(info(), chain);
    expect(send).toHaveBeenCalledWith(MERCHANT, PRICE.toString(), { representative: order.representative });
    expect(JSON.parse(payload)).toEqual({ blockHash: HASH, orderId: order.orderId });
    expect(decodeX402Header(provider.encodePaymentHeader(payload)))
      .toEqual({ x402Version: 2, scheme: 'exact', network: NANO_NETWORK, payload: { blockHash: HASH, orderId: order.orderId } });
    expect(Object.keys(provider)).not.toContain('privateKey');
  });

  it('does not pay a 402 without an order, or with a commitment that does not match what it would send', async () => {
    const send = vi.fn().mockResolvedValue(HASH);
    const provider = new NanoProvider({ address: BUYER, send });
    await provider.connect();
    await expect(provider.signPayment(info({ accepted: undefined }), chain)).rejects.toThrow('no Nano order');
    await expect(provider.signPayment(info({ accepted: { extra: { nano: { ...order, representative: OTHER } } } }), chain)).rejects.toThrow('does not match');
    await expect(provider.signPayment(info({ amount: '0.002' }), chain)).rejects.toThrow('does not match');
    expect(send).not.toHaveBeenCalled();
  });

  it('pays the nano recipient when the offer lists several, and 1 XNO is 10^30 raw', async () => {
    const send = vi.fn().mockResolvedValue(HASH);
    const provider = new NanoProvider({ address: BUYER, send });
    await provider.connect(NANO_NETWORK);
    const one = issuer.issue({ payTo: MERCHANT, amountRaw: 10n ** 30n, resource: RESOURCE });
    await provider.signPayment(info({ recipient: '0x0000000000000000000000000000000000000002', recipients: { nano: MERCHANT }, amount: '1', accepted: { extra: { nano: one } } }), chain);
    expect(send).toHaveBeenCalledWith(MERCHANT, (10n ** 30n).toString(), { representative: one.representative });
  });

  it('refuses another chain, a bad recipient, self-payment and a send that returns no hash', async () => {
    const provider = new NanoProvider({ address: BUYER, send: vi.fn().mockResolvedValue('not-a-hash') });
    await expect(provider.connect('base')).rejects.toThrow('nano:mainnet');
    await provider.connect();
    await expect(provider.signPayment(info(), getChainByName('base')!)).rejects.toThrow('nano:mainnet');
    await expect(provider.signPayment(info({ recipient: MERCHANT.slice(0, -1) }), chain)).rejects.toThrow('checksum');
    await expect(provider.signPayment(info({ recipient: BUYER }), chain)).rejects.toThrow('distinct');
    await expect(provider.signPayment(info(), chain)).rejects.toThrow('block hash');
  });

  it('reads the balance in XNO with account_balance', async () => {
    const rpc = rpcAnswering({ balance: (15n * 10n ** 29n).toString(), pending: '0', receivable: '0' });
    const provider = new NanoProvider({ address: BUYER, send: vi.fn(), rpc });
    expect(await provider.getBalance(chain)).toBe('1.5');
    expect(rpc).toHaveBeenCalledWith({ action: 'account_balance', account: BUYER });
  });
});

describe('createFetchPaywall localVerifiers.nano', () => {
  afterEach(() => vi.unstubAllGlobals());

  const accepts = [{ network: NANO_NETWORK, asset: 'XNO', amount: PRICE.toString(), payTo: MERCHANT }];
  const nanoHeader = (orderId: string, blockHash = HASH) =>
    encodeX402Header({ x402Version: 2, scheme: 'exact', network: NANO_NETWORK, payload: { blockHash, orderId } } as never);
  const facilitator = () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  /** A node that answers a send bound to whatever order the 402 just issued. */
  const nodeFor = (issued: () => { representative: string; issuedAt: number }, overrides: Record<string, unknown> = {}) =>
    vi.fn<NanoRpc>(async () => sendBlock({ local_timestamp: String(issued().issuedAt + 5), ...overrides }, { representative: issued().representative }));

  it('puts a fresh order in the 402, then takes the payment bound to it, once, without the facilitator', async () => {
    const fetchMock = facilitator();
    let challenged: any;
    const verifier = createNanoVerifier({
      rpc: nodeFor(() => challenged, {}),
      issuer: createNanoOrderIssuer({ secret: 'test-secret-0123456789', now: () => NOW }),
      replayStore: testStore(),
    });
    const route = createFetchPaywall({ accepts, localVerifiers: { nano: verifier } })(async () => new Response('paid content'));

    const body = await (await route(new Request(RESOURCE))).json();
    challenged = body.accepts[0].extra.nano;
    expect(challenged).toMatchObject({ orderId: expect.any(String), representative: expect.stringMatching(/^nano_/), issuedAt: NOW, expiresAt: NOW + 600 });
    const second = await (await route(new Request(RESOURCE))).json();
    expect(second.accepts[0].extra.nano.orderId).not.toBe(challenged.orderId);

    const paid = await route(new Request(RESOURCE, { headers: { 'X-PAYMENT': nanoHeader(challenged.orderId) } }));
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe('paid content');
    expect(fetchMock).not.toHaveBeenCalled();

    // The hash is public: presenting it again, with the same or another order, takes nothing.
    const again = await route(new Request(RESOURCE, { headers: { 'X-PAYMENT': nanoHeader(challenged.orderId) } }));
    expect(again.status).toBe(402);
    expect((await again.json()).reason).toBe('nano_block_already_used');
    const other = await route(new Request(RESOURCE, { headers: { 'X-PAYMENT': nanoHeader(second.accepts[0].extra.nano.orderId) } }));
    expect(other.status).toBe(402);
  });

  it('refuses a ledger-watcher: a public send to payTo that carries no commitment, and an order id for another URL', async () => {
    facilitator();
    let challenged: any;
    const verifier = createNanoVerifier({
      rpc: vi.fn<NanoRpc>(async () => sendBlock({}, { representative: BUYER })),
      issuer: createNanoOrderIssuer({ secret: 'test-secret-0123456789', now: () => NOW }),
      replayStore: testStore(),
    });
    const route = createFetchPaywall({ accepts, localVerifiers: { nano: verifier } })(async () => new Response('paid content'));
    challenged = (await (await route(new Request(RESOURCE))).json()).accepts[0].extra.nano;
    const stolen = await route(new Request(RESOURCE, { headers: { 'X-PAYMENT': nanoHeader(challenged.orderId) } }));
    expect(stolen.status).toBe(402);
    expect((await stolen.json()).reason).toBe('nano_block_not_bound_to_order');
    const elsewhere = await route(new Request('https://example.test/other', { headers: { 'X-PAYMENT': nanoHeader(challenged.orderId) } }));
    expect((await elsewhere.json()).reason).toBe('nano_order_not_issued_for_this_request');
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
});
