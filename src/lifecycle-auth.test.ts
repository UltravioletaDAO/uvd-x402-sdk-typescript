/**
 * Signed escrow lifecycle orders — the TypeScript half of the byte-parity.
 *
 * The pin is `the vector Python fixed for this twin`: the type string below is
 * TYPED BY HAND from the field order in `lifecycle_auth.rs:73-99`, NOT derived
 * from `LIFECYCLE_ORDER_TYPES`. Derived, the test would only prove the SDK
 * agrees with itself.
 *
 * The five failure modes the facilitator names are exercised through a LOCAL
 * ORACLE that reimplements `lifecycle_auth.rs::pre_evaluate` + `local_role`
 * (the chain-free half of the gate). It is a second implementation on purpose:
 * asserting against `buildLifecycleAuth`'s own output would grade its own
 * homework.
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  buildLifecycleAuth,
  buildLifecycleTypedData,
  wagmiLifecycleSigner,
  LIFECYCLE_DOMAIN_NAME,
  LIFECYCLE_DOMAIN_VERSION,
  LIFECYCLE_MAX_DEADLINE_SECS,
  LIFECYCLE_DEFAULT_DEADLINE_SECS,
  LIFECYCLE_ORDER_TYPES,
  type LifecycleSigner,
  type LifecycleAuth,
  type LifecyclePaymentInfo,
} from './lifecycle-auth';
import vectors from './lifecycle-auth.vectors.json';

// ============================================================================
// The signer under test — a raw ethers wallet behind the injected interface.
// The key is the synthetic 0x11*32 test key from the shared vector; it has
// never held funds.
// ============================================================================

function testSigner(privateKey: string): LifecycleSigner {
  const wallet = new ethers.Wallet(privateKey);
  return {
    getAddress: () => wallet.address,
    async signTypedData(typedData: string) {
      const { domain, types, message } = JSON.parse(typedData) as {
        domain: ethers.TypedDataDomain;
        types: Record<string, Array<{ name: string; type: string }>>;
        message: Record<string, unknown>;
      };
      const clean = { ...types };
      delete clean['EIP712Domain'];
      return { signature: await wallet.signTypedData(domain, clean, message) };
    },
  };
}

const KEY = vectors.privateKey;
const OTHER_KEY = `0x${'22'.repeat(32)}`;
const PI = vectors.paymentInfo as LifecyclePaymentInfo;
const CHAIN_ID = vectors.chainId;

// ============================================================================
// The local oracle — the chain-free half of lifecycle_auth.rs, reimplemented.
// ============================================================================

/** `lifecycle_auth.rs:73-99`, typed by hand. Never derive this. */
const TYPE_STRING =
  'LifecycleOrder(string action,uint256 amount,uint256 deadline,bytes32 nonce,PaymentInfo paymentInfo)' +
  'PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,' +
  'uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,' +
  'uint16 maxFeeBps,address feeReceiver,uint256 salt)';

type Verdict =
  | 'ok'
  | 'bad_signature'
  | 'expired'
  | 'deadline_too_far'
  | 'replayed'
  | 'unauthorized_role';

/**
 * `signing_hash` (`lifecycle_auth.rs:317-340`) rebuilt from the hand-typed
 * type string, so the digest is not the SDK's own.
 */
function oracleDigest(
  action: string,
  amount: bigint,
  deadline: number,
  nonce: string,
  payer: string,
  pi: LifecyclePaymentInfo,
  chainId: number
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const typeHash = ethers.keccak256(ethers.toUtf8Bytes(TYPE_STRING));
  const piTypeHash = ethers.keccak256(
    ethers.toUtf8Bytes(TYPE_STRING.slice(TYPE_STRING.indexOf('PaymentInfo(')))
  );

  const piHash = ethers.keccak256(
    coder.encode(
      [
        'bytes32',
        'address',
        'address',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'address',
        'uint256',
      ],
      [
        piTypeHash,
        ethers.getAddress(pi.operator),
        ethers.getAddress(payer),
        ethers.getAddress(pi.receiver),
        ethers.getAddress(pi.token),
        BigInt(pi.maxAmount),
        BigInt(pi.preApprovalExpiry),
        BigInt(pi.authorizationExpiry),
        BigInt(pi.refundExpiry),
        BigInt(pi.minFeeBps),
        BigInt(pi.maxFeeBps),
        ethers.getAddress(pi.feeReceiver),
        BigInt(pi.salt as string),
      ]
    )
  );

  const structHash = ethers.keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'uint256', 'bytes32', 'bytes32'],
      [
        typeHash,
        ethers.keccak256(ethers.toUtf8Bytes(action)),
        amount,
        BigInt(deadline),
        nonce,
        piHash,
      ]
    )
  );

  // Domain with NO verifyingContract: EIP712Domain(string name,string version,uint256 chainId)
  const domainHash = ethers.keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256'],
      [
        ethers.keccak256(
          ethers.toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId)')
        ),
        ethers.keccak256(ethers.toUtf8Bytes(LIFECYCLE_DOMAIN_NAME)),
        ethers.keccak256(ethers.toUtf8Bytes(LIFECYCLE_DOMAIN_VERSION)),
        BigInt(chainId),
      ]
    )
  );

  return ethers.keccak256(ethers.concat(['0x1901', domainHash, structHash]));
}

/**
 * `pre_evaluate` + `local_role` (`lifecycle_auth.rs:369-436`), chain-free half.
 * `seenNonces` is the facilitator's `ReplayGuard`.
 */
function oracleVerdict(
  auth: LifecycleAuth,
  ctx: {
    action: string;
    amount: bigint;
    payer: string;
    paymentInfo: LifecyclePaymentInfo;
    chainId: number;
    now: number;
    maxDeadlineSecs?: number;
  },
  seenNonces: Set<string> = new Set()
): Verdict {
  const ceiling = ctx.maxDeadlineSecs ?? LIFECYCLE_MAX_DEADLINE_SECS;
  if (auth.deadline < ctx.now) return 'expired';
  if (auth.deadline - ctx.now > ceiling) return 'deadline_too_far';

  const digest = oracleDigest(
    ctx.action,
    ctx.amount,
    auth.deadline,
    auth.nonce,
    ctx.payer,
    ctx.paymentInfo,
    ctx.chainId
  );
  let recovered: string;
  try {
    recovered = ethers.recoverAddress(digest, auth.signature);
  } catch {
    return 'bad_signature';
  }
  if (recovered.toLowerCase() !== auth.signer.toLowerCase()) return 'bad_signature';
  if (seenNonces.has(auth.nonce.toLowerCase())) return 'replayed';

  // local_role: release -> payer only; refundInEscrow -> receiver, or payer
  // once authorizationExpiry has passed. (The operator-owner rule needs a
  // chain read and is out of this oracle's scope.)
  const signer = recovered.toLowerCase();
  if (ctx.action === 'release') {
    if (signer !== ctx.payer.toLowerCase()) return 'unauthorized_role';
  } else {
    const isReceiver = signer === ethers.getAddress(ctx.paymentInfo.receiver).toLowerCase();
    const payerAfterExpiry =
      signer === ctx.payer.toLowerCase() && ctx.now >= Number(ctx.paymentInfo.authorizationExpiry);
    if (!isReceiver && !payerAfterExpiry) return 'unauthorized_role';
  }

  seenNonces.add(auth.nonce.toLowerCase());
  return 'ok';
}

// ============================================================================
// 1 · BYTE PARITY WITH THE PYTHON TWIN
// ============================================================================

describe('byte parity with the Python twin (0.78.0)', () => {
  it('produces the exact signature Python fixed for this vector', async () => {
    const wallet = testSigner(KEY);
    expect(wallet.getAddress()).toBe(vectors.signer);

    const auth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: vectors.deadline - 60,
    });

    expect(auth.signature).toBe(vectors.signature);
    expect(auth.signer).toBe(vectors.signer);
    expect(auth.deadline).toBe(vectors.deadline);
    expect(auth.nonce).toBe(vectors.nonce);
  });

  it('hashes to the digest the facilitator computes', () => {
    const typed = buildLifecycleTypedData({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
    });
    const types = { ...typed.types };
    delete types['EIP712Domain'];
    expect(ethers.TypedDataEncoder.hash(typed.domain, types, typed.message)).toBe(vectors.digest);
  });

  it('the type string is the one typed by hand from lifecycle_auth.rs', () => {
    // encodeType derived from the shipped types must equal the hand-typed
    // string. This is the mutation trap: reorder a PaymentInfo field and this
    // is what turns red, along with every signature ever issued.
    const types = { ...LIFECYCLE_ORDER_TYPES };
    delete types['EIP712Domain'];
    expect(ethers.TypedDataEncoder.from(types).encodeType('LifecycleOrder')).toBe(TYPE_STRING);
  });

  it('the domain carries no verifyingContract', () => {
    const typed = buildLifecycleTypedData({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
    });
    expect(typed.domain).toEqual({
      name: 'x402 escrow lifecycle',
      version: '1',
      chainId: 8453,
    });
    expect('verifyingContract' in typed.domain).toBe(false);
  });

  it('signs salt as the uint256 integer, not as the hex string', () => {
    const typed = buildLifecycleTypedData({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
    });
    const pi = typed.message.paymentInfo as Record<string, unknown>;
    expect(pi.salt).toBe('12345');
  });
});

// ============================================================================
// 2 · THE FIVE VERDICTS, THROUGH THE LOCAL ORACLE
// ============================================================================

describe('the verdicts the facilitator returns', () => {
  const NOW = vectors.deadline - 300;

  it('a valid order signed by the payer -> ok', async () => {
    const wallet = testSigner(KEY);
    const auth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: NOW,
    });

    expect(
      oracleVerdict(auth, {
        action: 'release',
        amount: BigInt(vectors.amount),
        payer: vectors.payer,
        paymentInfo: PI,
        chainId: CHAIN_ID,
        now: NOW,
      })
    ).toBe('ok');
  });

  it('an unauthorized signer -> unauthorized_role', async () => {
    // A real signature by a real key that holds no role in this escrow: the
    // signature verifies, the ROLE does not. This is the verdict production
    // logged on 2026-09-06T01:29:45Z.
    const stranger = testSigner(OTHER_KEY);
    const auth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet: stranger,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: NOW,
    });

    expect(auth.signer).not.toBe(vectors.payer);
    expect(
      oracleVerdict(auth, {
        action: 'release',
        amount: BigInt(vectors.amount),
        payer: vectors.payer,
        paymentInfo: PI,
        chainId: CHAIN_ID,
        now: NOW,
      })
    ).toBe('unauthorized_role');
  });

  it('an expired deadline never gets signed at all', async () => {
    const wallet = testSigner(KEY);
    await expect(
      buildLifecycleAuth({
        action: 'release',
        paymentInfo: PI,
        payer: vectors.payer,
        amount: vectors.amount,
        chainId: CHAIN_ID,
        wallet,
        deadline: NOW - 1,
        now: NOW,
      })
    ).rejects.toThrow(/expired/);
  });

  it('a deadline past the 900 s ceiling never gets signed either', async () => {
    const wallet = testSigner(KEY);
    await expect(
      buildLifecycleAuth({
        action: 'release',
        paymentInfo: PI,
        payer: vectors.payer,
        amount: vectors.amount,
        chainId: CHAIN_ID,
        wallet,
        deadline: NOW + LIFECYCLE_MAX_DEADLINE_SECS + 1,
        now: NOW,
      })
    ).rejects.toThrow(/deadline_too_far/);
  });

  it('an expired order that reaches the facilitator anyway -> expired', () => {
    // The client-side guard is not the only guard: an order signed while
    // fresh and submitted late is what the facilitator actually sees.
    const auth: LifecycleAuth = {
      signer: vectors.signer,
      deadline: NOW - 1,
      nonce: vectors.nonce,
      signature: vectors.signature,
    };
    expect(
      oracleVerdict(auth, {
        action: 'release',
        amount: BigInt(vectors.amount),
        payer: vectors.payer,
        paymentInfo: PI,
        chainId: CHAIN_ID,
        now: NOW,
      })
    ).toBe('expired');
  });

  it('a reused nonce -> replayed', async () => {
    const wallet = testSigner(KEY);
    const ctx = {
      action: 'release',
      amount: BigInt(vectors.amount),
      payer: vectors.payer,
      paymentInfo: PI,
      chainId: CHAIN_ID,
      now: NOW,
    };
    const seen = new Set<string>();

    const first = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: NOW,
    });
    expect(oracleVerdict(first, ctx, seen)).toBe('ok');

    const second = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet,
      deadline: vectors.deadline,
      nonce: vectors.nonce, // the same one, on purpose
      now: NOW,
    });
    expect(second.signature).toBe(first.signature);
    expect(oracleVerdict(second, ctx, seen)).toBe('replayed');
  });

  it('the default nonce is fresh per order, which is what avoids replayed', async () => {
    const wallet = testSigner(KEY);
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const auth = await buildLifecycleAuth({
        action: 'release',
        paymentInfo: PI,
        payer: vectors.payer,
        amount: vectors.amount,
        chainId: CHAIN_ID,
        wallet,
        now: NOW,
      });
      nonces.add(auth.nonce);
    }
    expect(nonces.size).toBe(5);
  });

  it('one changed paymentInfo field -> bad_signature', async () => {
    const wallet = testSigner(KEY);
    const auth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: NOW,
    });

    // The signed order says receiver 0x2222…; the submitted one says 0x3333….
    // Every field is in the type hash, so any single change breaks recovery.
    const tampered: LifecyclePaymentInfo = {
      ...PI,
      receiver: '0x3333333333333333333333333333333333333333',
    };
    expect(
      oracleVerdict(auth, {
        action: 'release',
        amount: BigInt(vectors.amount),
        payer: vectors.payer,
        paymentInfo: tampered,
        chainId: CHAIN_ID,
        now: NOW,
      })
    ).toBe('bad_signature');
  });

  it('the signed amount is the amount SENT, not maxAmount', async () => {
    // The vector's amount happens to equal maxAmount, so it cannot tell the
    // two apart. A partial settle can: this is the normal case of a stream,
    // which emits one order and one nonce per delta. Sign maxAmount there and
    // every partial is a `bad_signature` the caller has no log to diagnose.
    const partial = (BigInt(vectors.amount) / 4n).toString();
    expect(partial).not.toBe(String(PI.maxAmount));

    const wallet = testSigner(KEY);
    const auth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: partial,
      chainId: CHAIN_ID,
      wallet,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: NOW,
    });

    // The oracle recovers with the SUBMITTED amount; it only matches if the
    // signature committed to that same partial.
    expect(
      oracleVerdict(auth, {
        action: 'release',
        amount: BigInt(partial),
        payer: vectors.payer,
        paymentInfo: PI,
        chainId: CHAIN_ID,
        now: NOW,
      })
    ).toBe('ok');
  });

  it('a changed amount -> bad_signature (the partial-settle trap)', async () => {
    // Signing maxAmount and submitting a partial is the normal case of a
    // stream, and it is an order that never verifies. The amount SIGNED is
    // the amount SENT.
    const wallet = testSigner(KEY);
    const auth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: NOW,
    });
    expect(
      oracleVerdict(auth, {
        action: 'release',
        amount: BigInt(vectors.amount) / 2n,
        payer: vectors.payer,
        paymentInfo: PI,
        chainId: CHAIN_ID,
        now: NOW,
      })
    ).toBe('bad_signature');
  });
});

// ============================================================================
// 3 · REFUND ROLES
// ============================================================================

describe('refundInEscrow roles', () => {
  const RECEIVER_KEY = `0x${'33'.repeat(32)}`;

  it('the receiver may refund, and the same signature would not release', async () => {
    const receiverWallet = new ethers.Wallet(RECEIVER_KEY);
    const pi: LifecyclePaymentInfo = { ...PI, receiver: receiverWallet.address };
    const now = Number(pi.authorizationExpiry) - 3600;

    const auth = await buildLifecycleAuth({
      action: 'refundInEscrow',
      paymentInfo: pi,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet: testSigner(RECEIVER_KEY),
      deadline: now + 60,
      nonce: vectors.nonce,
      now,
    });

    expect(
      oracleVerdict(auth, {
        action: 'refundInEscrow',
        amount: BigInt(vectors.amount),
        payer: vectors.payer,
        paymentInfo: pi,
        chainId: CHAIN_ID,
        now,
      })
    ).toBe('ok');
  });

  it('the payer may not refund before authorizationExpiry (that is the chargeback)', async () => {
    const now = Number(PI.authorizationExpiry) - 3600;
    const auth = await buildLifecycleAuth({
      action: 'refundInEscrow',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet: testSigner(KEY),
      deadline: now + 60,
      nonce: vectors.nonce,
      now,
    });

    expect(
      oracleVerdict(auth, {
        action: 'refundInEscrow',
        amount: BigInt(vectors.amount),
        payer: vectors.payer,
        paymentInfo: PI,
        chainId: CHAIN_ID,
        now,
      })
    ).toBe('unauthorized_role');
  });

  it('the payer may refund once authorizationExpiry has passed', async () => {
    const now = Number(PI.authorizationExpiry) + 1;
    const auth = await buildLifecycleAuth({
      action: 'refundInEscrow',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet: testSigner(KEY),
      deadline: now + 60,
      nonce: vectors.nonce,
      now,
    });

    expect(
      oracleVerdict(auth, {
        action: 'refundInEscrow',
        amount: BigInt(vectors.amount),
        payer: vectors.payer,
        paymentInfo: PI,
        chainId: CHAIN_ID,
        now,
      })
    ).toBe('ok');
  });

  it('release and refundInEscrow of the same escrow are different orders', async () => {
    const wallet = testSigner(KEY);
    const common = {
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet,
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: vectors.deadline - 300,
    };
    const rel = await buildLifecycleAuth({ ...common, action: 'release' });
    const ref = await buildLifecycleAuth({ ...common, action: 'refundInEscrow' });
    expect(rel.signature).not.toBe(ref.signature);
  });
});

// ============================================================================
// 4 · THE GUARDS THAT REFUSE TO SIGN
// ============================================================================

describe('what never reaches a signature', () => {
  const NOW = vectors.deadline - 300;
  const wallet = testSigner(KEY);

  it('refuses an unknown action', async () => {
    await expect(
      buildLifecycleAuth({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        action: 'charge' as any,
        paymentInfo: PI,
        payer: vectors.payer,
        amount: vectors.amount,
        chainId: CHAIN_ID,
        wallet,
        now: NOW,
      })
    ).rejects.toThrow(/unknown lifecycle action/);
  });

  it('refuses an incomplete paymentInfo instead of defaulting a field', async () => {
    const incomplete = { ...PI } as Partial<LifecyclePaymentInfo>;
    delete incomplete.feeReceiver;
    await expect(
      buildLifecycleAuth({
        action: 'release',
        paymentInfo: incomplete as LifecyclePaymentInfo,
        payer: vectors.payer,
        amount: vectors.amount,
        chainId: CHAIN_ID,
        wallet,
        now: NOW,
      })
    ).rejects.toThrow(/feeReceiver/);
  });

  it('refuses a nonce that is not 32 bytes', async () => {
    await expect(
      buildLifecycleAuth({
        action: 'release',
        paymentInfo: PI,
        payer: vectors.payer,
        amount: vectors.amount,
        chainId: CHAIN_ID,
        wallet,
        nonce: '0xdeadbeef',
        now: NOW,
      })
    ).rejects.toThrow(/32 bytes/);
  });

  it('the default deadline leaves headroom under the ceiling', async () => {
    const auth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet,
      now: NOW,
    });
    expect(auth.deadline - NOW).toBe(LIFECYCLE_DEFAULT_DEADLINE_SECS);
    expect(auth.deadline - NOW).toBeLessThan(LIFECYCLE_MAX_DEADLINE_SECS);
  });
});

// ============================================================================
// 5 · THE BROWSER PATH (the payer signs, the marketplace transports)
// ============================================================================

describe('the payer signs in the browser', () => {
  it('wagmiLifecycleSigner produces the same bytes as the server-side path', async () => {
    const wallet = new ethers.Wallet(KEY);
    // A stand-in for wagmi's walletClient: same call shape as viem's.
    const walletClient = {
      account: { address: wallet.address },
      async signTypedData(args: {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        primaryType: string;
        message: Record<string, unknown>;
      }) {
        const types = { ...args.types };
        delete types['EIP712Domain'];
        return wallet.signTypedData(
          args.domain as ethers.TypedDataDomain,
          types,
          args.message
        );
      },
    };

    const auth = await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet: wagmiLifecycleSigner(walletClient),
      deadline: vectors.deadline,
      nonce: vectors.nonce,
      now: vectors.deadline - 60,
    });

    expect(auth.signature).toBe(vectors.signature);
    expect(auth.signer).toBe(vectors.signer);
  });

  it('the wallet client receives a primaryType and no verifyingContract', async () => {
    const wallet = new ethers.Wallet(KEY);
    let seen: { domain: Record<string, unknown>; primaryType: string } | undefined;
    const walletClient = {
      account: { address: wallet.address },
      async signTypedData(args: {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        primaryType: string;
        message: Record<string, unknown>;
      }) {
        seen = { domain: args.domain, primaryType: args.primaryType };
        const types = { ...args.types };
        delete types['EIP712Domain'];
        return wallet.signTypedData(
          args.domain as ethers.TypedDataDomain,
          types,
          args.message
        );
      },
    };

    await buildLifecycleAuth({
      action: 'release',
      paymentInfo: PI,
      payer: vectors.payer,
      amount: vectors.amount,
      chainId: CHAIN_ID,
      wallet: wagmiLifecycleSigner(walletClient),
      now: vectors.deadline - 300,
    });

    expect(seen?.primaryType).toBe('LifecycleOrder');
    expect(seen?.domain).not.toHaveProperty('verifyingContract');
  });

  it('refuses a disconnected wallet client instead of signing as nobody', () => {
    expect(() =>
      wagmiLifecycleSigner({
        account: null,
        async signTypedData() {
          return '0x';
        },
      })
    ).toThrow(/needs an account/);
  });
});
