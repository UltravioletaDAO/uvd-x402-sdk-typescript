/**
 * OWSWalletAdapter against the REAL @open-wallet-standard/core 1.4.2.
 *
 * No double: every test signs through the installed native library, in a
 * vault created for this file in the OS temp directory, with an ephemeral key
 * that never held funds, and no network. Where a test needs to see or bend a
 * call, it wraps the real function (`spyOn` below); it never replaces the
 * library with invented signatures.
 *
 * The same key is imported into the vault and given to `EnvKeyAdapter`, and
 * every method must return the SAME BYTES from both.
 *
 * If the library cannot load (a platform without its prebuilt binary, e.g.
 * Windows or musl), the suite is skipped with the reason in its name; with
 * `CI` set it fails instead, and CI also checks that it loads before testing.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { ethers } from 'ethers';
import type * as OwsModule from '@open-wallet-standard/core';
import { OWSWalletAdapter, type OWSCore } from './ows';
import { EnvKeyAdapter } from './env-key';
import { X402Error } from '../types';
import { getChainsByNetworkType } from '../chains';
import {
  buildLifecycleAuth,
  buildLifecycleTypedData,
  type LifecyclePaymentInfo,
} from '../lifecycle-auth';
import lifecycleVectors from '../lifecycle-auth.vectors.json';

// Both adapters draw the EIP-3009 nonce from ethers.randomBytes(32). A test
// that compares their outputs sets `nonces.next` so both draw the same one.
const nonces = vi.hoisted(() => ({ next: null as Uint8Array | null }));
vi.mock('ethers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('ethers')>();
  const randomBytes = (length: number) =>
    nonces.next && length === 32 ? nonces.next : mod.ethers.randomBytes(length);
  return { ...mod, randomBytes, ethers: { ...mod.ethers, randomBytes } };
});

const require = createRequire(import.meta.url);
let real: typeof OwsModule | null = null;
let loadError = '';
try {
  real = require('@open-wallet-standard/core') as typeof OwsModule;
} catch (error) {
  loadError = error instanceof Error ? error.message.split('\n')[0] : String(error);
}
if (!real && process.env.CI) {
  throw new Error(`@open-wallet-standard/core must load in CI and did not: ${loadError}`);
}

const PASS = 'uvd-ows-test-passphrase-7f3a';
const WALLET = 'uvd-ows-test';
const KEY = ethers.Wallet.createRandom().privateKey;
const OTHER = new ethers.Wallet(`0x${'22'.repeat(32)}`);

let vault = '';
let ows: typeof OwsModule;
let adapter: OWSWalletAdapter;
let env: EnvKeyAdapter;

/** The real module with some of its functions wrapped. */
function wrapped(overrides: Partial<OWSCore>): OWSCore {
  return { ...(ows as unknown as OWSCore), ...overrides };
}

/** An adapter over the real module whose `name` function is spied on. */
function spied(name: 'signMessage' | 'signTypedData' | 'signTransaction') {
  const spy = vi.fn((...args: unknown[]) => (ows[name] as (...a: unknown[]) => unknown)(...args));
  const a = new OWSWalletAdapter(wrapped({ [name]: spy } as Partial<OWSCore>), {
    wallet: WALLET,
    passphrase: PASS,
    vaultPath: vault,
  });
  return { a, spy };
}

async function rejection(promise: Promise<unknown>): Promise<X402Error> {
  try {
    await promise;
  } catch (error) {
    return error as X402Error;
  }
  throw new Error('expected a rejection, got a result');
}

function typed(
  types: Record<string, Array<{ name: string; type: string }>>,
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    types,
    primaryType: Object.keys(types)[0],
    message,
    ...extra,
  });
}

const U256 = { Order: [{ name: 'amount', type: 'uint256' }] };
const I256 = { Order: [{ name: 'delta', type: 'int256' }] };

describe.skipIf(!real)(
  `OWSWalletAdapter over @open-wallet-standard/core 1.4.2${real ? '' : ` (SKIPPED: the library did not load: ${loadError})`}`,
  () => {
    beforeAll(() => {
      ows = real!;
      vault = fs.mkdtempSync(path.join(os.tmpdir(), 'uvd-ows-vault-'));
      ows.importWalletPrivateKey(WALLET, KEY.slice(2), PASS, vault);
      adapter = new OWSWalletAdapter(ows, { wallet: WALLET, passphrase: PASS, vaultPath: vault });
      env = new EnvKeyAdapter(KEY);
    });

    afterAll(() => {
      if (vault) fs.rmSync(vault, { recursive: true, force: true });
    });

    // ------------------------------------------------------------------------
    describe('the library the adapter is written against', () => {
      it('is 1.4.2 and declares the four functions exactly as OWSCore does', () => {
        const dir = path.dirname(require.resolve('@open-wallet-standard/core/package.json'));
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('1.4.2');
        const dts = fs.readFileSync(path.join(dir, 'index.d.ts'), 'utf8');
        const declared = (name: string) =>
          new RegExp(`export declare function ${name}\\(([^)]*)\\)`).exec(dts)?.[1];
        // The parameters OWSCore (src/adapters/ows.ts) was written from.
        expect(declared('getWallet')).toBe('nameOrId: string, vaultPathOpt?: string | undefined | null');
        expect(declared('signMessage')).toBe(
          'wallet: string, chain: string, message: string, passphrase?: string | undefined | null, ' +
            'encoding?: string | undefined | null, index?: number | undefined | null, ' +
            'vaultPathOpt?: string | undefined | null'
        );
        expect(declared('signTypedData')).toBe(
          'wallet: string, chain: string, typedDataJson: string, passphrase?: string | undefined | null, ' +
            'index?: number | undefined | null, vaultPathOpt?: string | undefined | null'
        );
        expect(declared('signTransaction')).toBe(
          'wallet: string, chain: string, txHex: string, passphrase?: string | undefined | null, ' +
            'index?: number | undefined | null, vaultPathOpt?: string | undefined | null'
        );
        for (const name of ['getWallet', 'signMessage', 'signTypedData', 'signTransaction']) {
          expect(typeof (ows as unknown as Record<string, unknown>)[name]).toBe('function');
        }
      });

      it('returns the shapes the adapter reads: hex without 0x, v 27/28 for messages and 0/1 for transactions', () => {
        const message = ows.signMessage(WALLET, 'eip155:8453', 'hi', PASS, 'utf8', null, vault);
        expect(message.signature).toMatch(/^[0-9a-f]{130}$/);
        expect([27, 28]).toContain(message.recoveryId);
        expect(parseInt(message.signature.slice(128), 16)).toBe(message.recoveryId);
        const tx = ethers.Transaction.from({ type: 2, chainId: 8453, nonce: 0, gasLimit: 21000, maxFeePerGas: 1, maxPriorityFeePerGas: 1 });
        const signed = ows.signTransaction(WALLET, 'eip155:8453', tx.unsignedSerialized.slice(2), PASS, null, vault);
        expect([0, 1]).toContain(signed.recoveryId);
        expect(parseInt(signed.signature.slice(128), 16)).toBe(signed.recoveryId);
      });

      it('signs 2**256 as a uint256 as if it were 0 (why the range check exists)', () => {
        const doc = {
          types: {
            EIP712Domain: [{ name: 'name', type: 'string' }],
            Order: U256.Order,
          },
          primaryType: 'Order',
          domain: { name: 'x' },
          message: { amount: `0x01${'00'.repeat(32)}` },
        };
        const { signature } = ows.signTypedData(WALLET, 'eip155:1', JSON.stringify(doc), PASS, null, vault);
        const digestOfZero = ethers.TypedDataEncoder.hash({ name: 'x' }, U256, { amount: 0 });
        expect(ethers.recoverAddress(digestOfZero, `0x${signature}`)).toBe(env.getAddress());
      });
    });

    // ------------------------------------------------------------------------
    describe('construction', () => {
      it('reads the EVM address of the wallet from the vault, by name or by id', () => {
        expect(adapter.getAddress()).toBe(env.getAddress());
        const id = ows.getWallet(WALLET, vault).id;
        expect(new OWSWalletAdapter(ows, { wallet: id, passphrase: PASS, vaultPath: vault }).getAddress()).toBe(
          env.getAddress()
        );
      });

      it('refuses the old wallet-object shape with a pointer to the module', () => {
        const old = { accounts: [{ address: env.getAddress() }], signMessage: async () => ({ signature: '0x' }) };
        const error = (() => {
          try {
            new OWSWalletAdapter(old as unknown as OWSCore, { wallet: WALLET });
          } catch (e) {
            return e as X402Error;
          }
        })();
        expect(error?.code).toBe('INVALID_CONFIG');
        expect(error?.message).toContain("import * as ows from '@open-wallet-standard/core'");
      });

      it('refuses a wallet the vault does not have, and a network that is not EVM', () => {
        expect(() => new OWSWalletAdapter(ows, { wallet: 'nope', passphrase: PASS, vaultPath: vault })).toThrow(
          /OWS getWallet failed: wallet not found/
        );
        expect(
          () => new OWSWalletAdapter(ows, { wallet: WALLET, passphrase: PASS, vaultPath: vault, network: 'solana' })
        ).toThrow(/EVM network/);
      });

      it('an explicit passphrase wins over OWS_PASSPHRASE, which is the fallback', async () => {
        vi.stubEnv('OWS_PASSPHRASE', 'not-the-passphrase');
        try {
          const explicit = new OWSWalletAdapter(ows, { wallet: WALLET, passphrase: PASS, vaultPath: vault });
          expect(await explicit.signMessage('x')).toBe(await env.signMessage('x'));
          const fromEnv = new OWSWalletAdapter(ows, { wallet: WALLET, vaultPath: vault });
          expect((await rejection(fromEnv.signMessage('x'))).message).toMatch(/decryption failed/);
          vi.stubEnv('OWS_PASSPHRASE', PASS);
          const fallback = new OWSWalletAdapter(ows, { wallet: WALLET, vaultPath: vault });
          expect(await fallback.signMessage('x')).toBe(await env.signMessage('x'));
        } finally {
          vi.unstubAllEnvs();
        }
      });

      it('never shows the passphrase: not in the object, not in an error', async () => {
        expect(JSON.stringify(adapter)).not.toContain(PASS);
        expect(util.inspect(adapter, { depth: 10, showHidden: true })).not.toContain(PASS);

        const wrong = new OWSWalletAdapter(ows, { wallet: WALLET, passphrase: `${PASS}-wrong`, vaultPath: vault });
        for (const attempt of [
          wrong.signMessage('x'),
          wrong.signTypedData(typed(U256, { amount: '1' })),
          wrong.signTransaction(ethers.Transaction.from({ type: 2, chainId: 1, nonce: 0, gasLimit: 21000, maxFeePerGas: 1, maxPriorityFeePerGas: 1 }).unsignedSerialized),
        ]) {
          const error = await rejection(attempt);
          expect(error.message).toMatch(/decryption failed/);
          expect(`${error.message}${error.stack}${util.inspect(error, { depth: 10 })}`).not.toContain(PASS);
          expect(error.details).toBeUndefined();
        }

        // The native binding echoes a mistyped argument in its errors: a
        // passphrase that is not a string never reaches it.
        const secret = { token: PASS };
        expect(
          () => new OWSWalletAdapter(ows, { wallet: WALLET, passphrase: secret as unknown as string, vaultPath: vault })
        ).toThrow(/^OWSWalletAdapter: options.passphrase must be a string$/);

        // A library error that did carry it comes out redacted.
        const leaky = new OWSWalletAdapter(
          wrapped({
            signMessage: (_w, _c, _m, passphrase) => {
              throw new Error(`could not use ${passphrase}`);
            },
          }),
          { wallet: WALLET, passphrase: PASS, vaultPath: vault }
        );
        const error = await rejection(leaky.signMessage('x'));
        expect(error.message).toBe('OWS signMessage failed: could not use [redacted]');
      });
    });

    // ------------------------------------------------------------------------
    describe('same bytes as EnvKeyAdapter', () => {
      it('messages', async () => {
        for (const message of ['', 'hello', '0xdeadbeef', 'é😀', 'a\r\nb', '\x00', 'x'.repeat(20_000)]) {
          const signature = await adapter.signMessage(message);
          expect(signature).toBe(await env.signMessage(message));
          expect(ethers.verifyMessage(message, signature)).toBe(adapter.getAddress());
        }
      });

      it('EIP-3009 on every EVM network of the registry, at several amounts', async () => {
        const networks = getChainsByNetworkType('evm').map((chain) => chain.name);
        expect(networks.length).toBeGreaterThan(10);
        for (const network of networks) {
          for (const amountUsdc of [0.000001, 0.5, 123456.78]) {
            nonces.next = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`${network}:${amountUsdc}`)));
            try {
              const params = {
                to: OTHER.address,
                amountUsdc,
                network,
                validAfter: 1_700_000_000,
                validBefore: 1_900_000_000,
              };
              const got = await adapter.signEIP3009(params);
              expect(got, `${network} ${amountUsdc}`).toEqual(await env.signEIP3009(params));
              expect(got.from).toBe(adapter.getAddress());
            } finally {
              nonces.next = null;
            }
          }
        }
      });

      it('EIP-3009 with the default window', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
        nonces.next = new Uint8Array(32).fill(7);
        try {
          const params = { to: OTHER.address, amountUsdc: 1.25, network: 'base' };
          const got = await adapter.signEIP3009(params);
          expect(got).toEqual(await env.signEIP3009(params));
          expect(got.validBefore).toBe(String(Date.parse('2026-09-29T00:05:00Z') / 1000));
        } finally {
          nonces.next = null;
          vi.useRealTimers();
        }
      });

      it('uint256 given as decimal strings, hex and numbers, up to 2**256 - 1 (2**128 exactly included)', async () => {
        const values: unknown[] = [
          0, 1, 42, Number.MAX_SAFE_INTEGER, '0', '7', '007', '0x10', '0X10', '0x00',
          (2n ** 64n).toString(), (2n ** 128n - 1n).toString(), (2n ** 128n).toString(), `0x${(2n ** 128n).toString(16)}`,
          (2n ** 128n + 1n).toString(), (2n ** 200n).toString(), (2n ** 256n - 1n).toString(), `0x${'ff'.repeat(32)}`,
        ];
        for (const amount of values) {
          const json = typed(U256, { amount });
          expect((await adapter.signTypedData(json)).signature, String(amount)).toBe((await env.signTypedData(json)).signature);
        }
      });

      it('int256 and small signed and unsigned widths', async () => {
        for (const delta of ['-1', '1', (-(2n ** 127n)).toString(), (-(2n ** 127n) - 1n).toString(), (-(2n ** 255n)).toString(), (2n ** 255n - 1n).toString(), '-0x10', -5]) {
          const json = typed(I256, { delta });
          expect((await adapter.signTypedData(json)).signature, String(delta)).toBe((await env.signTypedData(json)).signature);
        }
        const small = { Order: [{ name: 'a', type: 'uint8' }, { name: 'b', type: 'int8' }, { name: 'c', type: 'uint128' }, { name: 'd', type: 'int128' }] };
        for (const message of [
          { a: 255, b: -128, c: (2n ** 128n - 1n).toString(), d: (-(2n ** 127n)).toString() },
          { a: '0', b: '127', c: '0x01', d: (2n ** 127n - 1n).toString() },
        ]) {
          const json = typed(small, message);
          expect((await adapter.signTypedData(json)).signature).toBe((await env.signTypedData(json)).signature);
        }
      });

      it('strings, bools, bytes, addresses, nested structs, arrays, domain salt and domain order', async () => {
        const types = {
          Outer: [
            { name: 'label', type: 'string' },
            { name: 'ok', type: 'bool' },
            { name: 'blob', type: 'bytes' },
            { name: 'tag', type: 'bytes32' },
            { name: 'who', type: 'address' },
            { name: 'inner', type: 'Inner' },
            { name: 'list', type: 'uint256[]' },
            { name: 'pair', type: 'Inner[2]' },
          ],
          Inner: [{ name: 'v', type: 'uint256' }],
        };
        const message = {
          label: 'hola ✓',
          ok: false,
          blob: '0xdeadbeef',
          tag: `0x${'AB'.repeat(32)}`,
          who: OTHER.address.toLowerCase(),
          inner: { v: (2n ** 255n).toString() },
          list: ['1', '0x02', (2n ** 130n).toString()],
          pair: [{ v: 1 }, { v: '0x' + 'ff'.repeat(32) }],
          notInTheType: 'ignored by both',
        };
        const json = typed(types, message);
        expect((await adapter.signTypedData(json)).signature).toBe((await env.signTypedData(json)).signature);

        const salted = JSON.stringify({
          domain: { name: 'x', chainId: '0x2105', salt: `0x${'11'.repeat(32)}` },
          // An EIP712Domain in another order: EnvKeyAdapter ignores it; so does this adapter.
          types: {
            EIP712Domain: [{ name: 'salt', type: 'bytes32' }, { name: 'chainId', type: 'uint256' }, { name: 'name', type: 'string' }],
            ...U256,
          },
          message: { amount: '5' },
        });
        expect((await adapter.signTypedData(salted)).signature).toBe((await env.signTypedData(salted)).signature);
      });

      it('lifecycle orders: the uint256 salt goes as a decimal string above 2**128', async () => {
        const salts = [`0x${'ab'.repeat(32)}`, `0x${'00'.repeat(31)}01`, ...Array.from({ length: 20 }, () => ethers.hexlify(ethers.randomBytes(32)))];
        for (const salt of salts) {
          const doc = buildLifecycleTypedData({
            action: 'release',
            paymentInfo: { ...(lifecycleVectors.paymentInfo as LifecyclePaymentInfo), salt },
            payer: adapter.getAddress(),
            amount: '1000',
            chainId: lifecycleVectors.chainId,
            now: 1_800_000_000,
            deadline: 1_800_000_300,
            nonce: `0x${'33'.repeat(32)}`,
          });
          const json = JSON.stringify(doc);
          expect((await adapter.signTypedData(json)).signature, salt).toBe((await env.signTypedData(json)).signature);
        }

        const auth = await buildLifecycleAuth({
          action: 'refundInEscrow',
          paymentInfo: { ...(lifecycleVectors.paymentInfo as LifecyclePaymentInfo), salt: `0x${'ab'.repeat(32)}` },
          payer: adapter.getAddress(),
          amount: '1000',
          chainId: lifecycleVectors.chainId,
          wallet: adapter,
        });
        expect(auth.signer).toBe(adapter.getAddress());
        expect(auth.signature).toMatch(/^0x[0-9a-f]{130}$/);
      });

      const base = { to: `0x${'11'.repeat(20)}`, nonce: 7, gasLimit: 90_000n, value: 10n ** 15n, data: '0xa9059cbb' };
      const transactions: Array<[string, ethers.TransactionLike<string>]> = [
        ['EIP-1559 on Base', { ...base, type: 2, chainId: 8453, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n }],
        ['EIP-1559 on Arc Testnet', { ...base, type: 2, chainId: 5042002, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n }],
        ['EIP-2930', { ...base, type: 1, chainId: 137, gasPrice: 10n ** 9n, accessList: [{ address: base.to, storageKeys: [`0x${'00'.repeat(32)}`] }] }],
        ['legacy with EIP-155', { ...base, type: 0, chainId: 43114, gasPrice: 25n * 10n ** 9n }],
        ['legacy with EIP-155, large chain id', { ...base, type: 0, chainId: 1187947933, gasPrice: 1n }],
        ['legacy without a chain id (pre-EIP-155)', { ...base, type: 0, gasPrice: 10n ** 9n }],
        ['contract creation, value 2**256 - 1', { type: 2, chainId: 1, nonce: 0, gasLimit: 10n ** 6n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, value: 2n ** 256n - 1n, data: '0x6000' }],
      ];

      it.each(transactions)('transaction, serialized, no from: %s', async (_label, fields) => {
        const unsigned = ethers.Transaction.from(fields).unsignedSerialized;
        const signed = await adapter.signTransaction(unsigned);
        expect(signed).toBe(await env.signTransaction(unsigned));
        expect(ethers.Transaction.from(signed).from).toBe(adapter.getAddress());
      });

      it.each(transactions)('transaction, with from = the wallet: %s', async (_label, fields) => {
        const local = new ethers.Wallet(KEY);
        const expected = await env.signTransaction(ethers.Transaction.from(fields).unsignedSerialized);
        // As an object with from (what ethers' populateTransaction returns),
        // checksummed or not: the bytes ethers.Wallet signs.
        for (const from of [adapter.getAddress(), adapter.getAddress().toLowerCase()]) {
          const withFrom = { ...fields, from };
          expect(await adapter.signTransaction(withFrom)).toBe(await local.signTransaction(withFrom));
          expect(await adapter.signTransaction(withFrom)).toBe(expected);
        }
        // As a transaction already signed by this wallet: signed again, as EnvKeyAdapter does.
        expect(await adapter.signTransaction(expected)).toBe(await env.signTransaction(expected));
        // As ethers.Transaction objects, unsigned and signed: their fields sit behind getters.
        const unsignedTx = ethers.Transaction.from(fields);
        expect(await adapter.signTransaction(unsignedTx)).toBe(expected);
        expect(await adapter.signTransaction(ethers.Transaction.from(expected))).toBe(expected);
      });

      it.each(transactions)('transaction, with from = another address, is refused before signing: %s', async (_label, fields) => {
        const { a, spy } = spied('signTransaction');
        const error = await rejection(a.signTransaction({ ...fields, from: OTHER.address }));
        expect(error.code).toBe('INVALID_CONFIG');
        expect(error.message).toContain('is not this wallet');

        const byOther = await OTHER.signTransaction(fields);
        expect((await rejection(a.signTransaction(byOther))).message).toContain('is not this wallet');
        await expect(env.signTransaction(byOther)).rejects.toThrow(/from address mismatch/);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    // ------------------------------------------------------------------------
    describe('refused before signing (the library is not called)', () => {
      const cases: Array<[string, string, string]> = [
        ['uint256 = 2**256, decimal', typed(U256, { amount: (2n ** 256n).toString() }), 'INVALID_AMOUNT'],
        ['uint256 = 2**256, hex', typed(U256, { amount: `0x01${'00'.repeat(32)}` }), 'INVALID_AMOUNT'],
        ['uint256 = -1', typed(U256, { amount: '-1' }), 'INVALID_AMOUNT'],
        ['uint8 = 256', typed({ Order: [{ name: 'a', type: 'uint8' }] }, { a: 256 }), 'INVALID_AMOUNT'],
        ['int8 = 128', typed({ Order: [{ name: 'a', type: 'int8' }] }, { a: '128' }), 'INVALID_AMOUNT'],
        ['int8 = -129', typed({ Order: [{ name: 'a', type: 'int8' }] }, { a: '-129' }), 'INVALID_AMOUNT'],
        ['int256 = -2**255 - 1', typed(I256, { delta: (-(2n ** 255n) - 1n).toString() }), 'INVALID_AMOUNT'],
        ['uint256 as a float', typed(U256, { amount: 1.5 }), 'INVALID_CONFIG'],
        ['uint256 as an unsafe number', typed(U256, { amount: 2 ** 60 }), 'INVALID_CONFIG'],
        ['uint256 with spaces', typed(U256, { amount: ' 1' }), 'INVALID_CONFIG'],
        ['uint256 missing', typed(U256, {}), 'INVALID_CONFIG'],
        ['string given a number', typed({ Order: [{ name: 's', type: 'string' }] }, { s: 5 }), 'INVALID_CONFIG'],
        ['address with a bad checksum', typed({ Order: [{ name: 'w', type: 'address' }] }, { w: '0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913' }), 'INVALID_CONFIG'],
        ['bytes without 0x', typed({ Order: [{ name: 'b', type: 'bytes' }] }, { b: 'dead' }), 'INVALID_CONFIG'],
        ['bytes32 too short', typed({ Order: [{ name: 'b', type: 'bytes32' }] }, { b: '0xab' }), 'INVALID_CONFIG'],
        ['fixed array of the wrong length', typed({ Order: [{ name: 'l', type: 'uint256[2]' }] }, { l: ['1'] }), 'INVALID_CONFIG'],
        ['unknown domain key', JSON.stringify({ domain: { name: 'x', foo: 'bar' }, types: U256, message: { amount: '1' } }), 'INVALID_CONFIG'],
        ['primaryType that is not the root', typed({ Order: [{ name: 'i', type: 'Inner' }], Inner: [{ name: 'v', type: 'uint256' }] }, { i: { v: '1' } }, { primaryType: 'Inner' }), 'INVALID_CONFIG'],
        ['not JSON', '{', 'INVALID_CONFIG'],
      ];

      it.each(cases)('%s', async (_label, json, code) => {
        const { a, spy } = spied('signTypedData');
        const error = await rejection(a.signTypedData(json));
        expect(error).toBeInstanceOf(X402Error);
        expect(error.code).toBe(code);
        expect(error.message).toContain('nothing was signed');
        expect(spy).not.toHaveBeenCalled();
      });

      // Where ethers is laxer, this adapter refuses (fails closed) and
      // EnvKeyAdapter signs: " 1" (BigInt trims it), a primaryType that is not
      // the root (ethers ignores primaryType and signs the root), and a bool
      // given as 1 (below).
      const LAXER_IN_ETHERS = ['uint256 with spaces', 'primaryType that is not the root'];

      it('ethers (EnvKeyAdapter) refuses the same, except where it is laxer', async () => {
        for (const [label, json] of cases) {
          const envSigns = await env.signTypedData(json).then(() => true, () => false);
          expect(envSigns, label).toBe(LAXER_IN_ETHERS.includes(label));
        }
      });

      it('EIP-3009 with a negative amount', async () => {
        const { a, spy } = spied('signTypedData');
        const params = { to: OTHER.address, amountUsdc: -1, network: 'base' };
        expect((await rejection(a.signEIP3009(params))).code).toBe('INVALID_AMOUNT');
        await expect(env.signEIP3009(params)).rejects.toThrow();
        expect(spy).not.toHaveBeenCalled();
      });

      it('a bool given as 1 (ethers signs it as true; this adapter refuses)', async () => {
        const { a, spy } = spied('signTypedData');
        const json = typed({ Order: [{ name: 'b', type: 'bool' }] }, { b: 1 });
        const error = await rejection(a.signTypedData(json));
        expect(error.code).toBe('INVALID_CONFIG');
        expect(spy).not.toHaveBeenCalled();
        const asTrue = typed({ Order: [{ name: 'b', type: 'bool' }] }, { b: true });
        expect((await env.signTypedData(json)).signature).toBe((await env.signTypedData(asTrue)).signature);
      });
    });

    // ------------------------------------------------------------------------
    describe('checked after signing: a signature over other bytes is not returned', () => {
      it('typed data', async () => {
        // The library signs a different document than the one it was given.
        const lying = new OWSWalletAdapter(
          wrapped({ signTypedData: (w, c, json, ...rest) => ows.signTypedData(w, c, json.replace('"5"', '"6"'), ...rest) }),
          { wallet: WALLET, passphrase: PASS, vaultPath: vault }
        );
        const error = await rejection(lying.signTypedData(typed(U256, { amount: '5' })));
        expect(error.code).toBe('PAYMENT_FAILED');
        expect(error.message).toContain('does not recover');
      });

      it('messages', async () => {
        const lying = new OWSWalletAdapter(
          wrapped({ signMessage: (w, c, _m, ...rest) => ows.signMessage(w, c, 'something else', ...rest) }),
          { wallet: WALLET, passphrase: PASS, vaultPath: vault }
        );
        expect((await rejection(lying.signMessage('pay 1 USDC'))).message).toContain('does not recover');
      });

      it('transactions', async () => {
        const lying = new OWSWalletAdapter(
          wrapped({ signTransaction: (w, c, _hex, ...rest) => ows.signTransaction(w, c, 'deadbeef', ...rest) }),
          { wallet: WALLET, passphrase: PASS, vaultPath: vault }
        );
        const unsigned = ethers.Transaction.from(transactionsForCheck).unsignedSerialized;
        expect((await rejection(lying.signTransaction(unsigned))).message).toContain('does not recover');
      });
    });
  }
);

const transactionsForCheck = { type: 2, chainId: 8453, nonce: 1, gasLimit: 21000, maxFeePerGas: 1, maxPriorityFeePerGas: 1 };
