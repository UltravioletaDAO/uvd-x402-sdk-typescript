# Arras escrow on NEAR

Import from `uvd-x402-sdk/near`. The helpers sign offline and do not send transactions or read environment keys. `createNearLocalSigner` accepts a 32-byte Ed25519 seed or a NEAR `ed25519:` base58 secret (64 bytes: seed plus public key). It signs the [NEP-366 digest](https://github.com/near/NEPs/blob/master/neps/nep-0366.md) directly, without a NEP-413 message envelope.

`buildEscrowMsg(params)` returns canonical JSON. `computePaymentId({...params, token, payer, amount})` returns `base58(sha256(borsh(preimage)))`; `paymentIdPreimage` exposes the bytes. Params use Rust names: `operator_id`, `receiver`, `release_deadline`, `reclaim_after`, `fee_bps_max`, `terms_hash`, `salt`. Deadlines are nanoseconds; amounts are atomic units. Use decimal strings or bigint for large integers; unsafe numbers are refused. Integer strings cannot contain whitespace, signs, scientific notation or leading zeroes. Hex must be lowercase, exactly 32 bytes for terms and 16 for salt, without `0x`. IDs can have 32..44 base58 characters.

```js
import { createNearLocalSigner, buildEscrowMsg, computePaymentId,
  signEscrowAuthorization, release, withdrawFor, NEAR_ESCROW_CONTRACTS } from 'uvd-x402-sdk/near';

const msg = {
  operator_id: 'em', receiver: 'worker-demo.testnet',
  release_deadline: '1793577600000000000', reclaim_after: '1793664000000000000',
  fee_bps_max: 1300, terms_hash: '00'.repeat(32), salt: '00'.repeat(16),
}; // Vector dates: use future dates and a fresh random salt for an actual payment.
const context = {
  network: 'near:testnet', senderId: 'payer-demo.testnet',
  escrowContract: NEAR_ESCROW_CONTRACTS['near:testnet'][0],
  signer: createNearLocalSigner(localSecret), // your application's local key storage
  nonce: nextAccessKeyNonce, maxBlockHeight: shortLivedHeight,
};
const token = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const paymentId = computePaymentId({ ...msg, token, payer: context.senderId, amount: '1000000' });
const paymentPayload = await signEscrowAuthorization({ ...context, token, amount: '1000000', msg });
const paymentRequirements = {
  scheme: 'escrow', network: context.network, amount: '1000000', asset: token,
  payTo: msg.receiver, maxTimeoutSeconds: 60,
  extra: { nearEscrow: { contract: context.escrowContract, operatorId: msg.operator_id,
    msg: buildEscrowMsg(msg), paymentId } },
};
const body = { x402Version: 2, paymentPayload, paymentRequirements };
// POST to your facilitator's /verify, then /settle when ready to fund escrow.
```

The returned envelope has `x402Version: 2`, `scheme: 'escrow'`, the exact `near:mainnet` or `near:testnet` network and `payload.signedDelegateAction` (base64 Borsh). The current facilitator accepts it in `paymentPayload` together with `paymentRequirements` above. For a canonical x402 v2 `PAYMENT-SIGNATURE` to a resource server, wrap its inner payload in `{x402Version: 2, accepted: paymentRequirements, payload: paymentPayload.payload}` and base64-encode the JSON (include `resource` if required by that server).

The delegate targets native USDC with one `ft_transfer_call` to the escrow's `receiver_id`. Deposit is one yocto; gas defaults to 100 TGas and must be 38..100 TGas. `buildEscrowAuthorizationDelegate` and `validateEscrowAuthorizationDelegate` expose those checks. The SDK signs only for the Arras deployments listed in `NEAR_ESCROW_CONTRACTS` and refuses any other `escrowContract` before calling the signer, for the authorization and for every lifecycle call: a signed delegate can be relayed by anyone, so a server must not be able to point it at its own account. Mainnet registers only `v1.arras-escrow.near`; testnet registers only `arras-v1b-1101.testnet`.

As of 2026-11-08, [the production facilitator's `/supported`](https://facilitator.ultravioletadao.xyz/supported) advertises `scheme: 'escrow'` for `near` (v1) and `near:mainnet` (v2), with `extra.nearEscrow.contracts: ['v1.arras-escrow.near']` and `operatorIds: ['em']`. Testnet advertises `arras-v1b-1101.testnet` with the same operator. Here v1/v2 are x402 wire versions; both relay Arras v1. Select the operator from trusted configuration checked against `/supported`.

Arras v2 (`v2.arras-escrow.near`) is [deployed on mainnet since 2026-11-08](https://github.com/UltravioletaDAO/arras#readme), but the SDK does not register or use it yet. Execution Market still uses Arras v1, and the facilitator does not advertise Arras v2.

Supply the exact signing key's next nonce and a recent block height with short expiry. The SDK refuses `nonce >= maxBlockHeight * 10^6`, which NEAR always rejects (`DelegateActionNonceTooLarge`); checking expiry against the current height is left to the facilitator, which has RPC. The SDK does not allocate nonces; concurrent calls require unique increasing nonces. No helper contacts RPC. Register escrow/recipients in USDC and pay Arras NEP-145 storage or arrange operator sponsorship first. Authorization requires a full-access key for the one-yocto transfer. Require the facilitator's confirmed escrow result and expected `arras` event/payment ID: a successful transaction alone does not prove funds were locked. Release credits claimable balances; withdrawal is separate.

| Helper | Signed Rust method and args | Gas (TGas) |
|---|---|---|
| `release(context, paymentId, amount?)` | `release({payment_id, amount})`; omitted amount becomes `null`, releasing all live funds | 3..30 |
| `refund(context, paymentId)` | `refund({payment_id})` | 3..30 |
| `reclaim(context, paymentId)` | `reclaim({payment_id})` | 3..30 |
| `withdraw(context)` | `withdraw({})` | 29..50 |
| `withdrawFor(context, account)` | `withdraw_for({account})` | 29..50 |

Lifecycle delegates target the escrow with one call and zero deposit. `signEscrowLifecycle` accepts only these five method names and closed argument sets. Use a capturer's restricted function-call key for release/refund and withdrawal on behalf of recipients; use the payer's key for reclaim. On-chain roles still apply. The current facilitator relays refunds only from capturers although the contract allows the receiver directly. Lifecycle requests use `paymentRequirements.extra.nearEscrow.action` equal to the method, the escrow `contract`, and amount `"0"` or no amount. Each signed call needs a fresh nonce:

```js
const released = await release(capturerContext, paymentId);
// After confirmed release, with a fresh nonce for each withdrawal:
const payout = await withdrawFor(nextCapturerContext, msg.receiver);
// Also withdrawFor another fresh context, feeRecipient, to pay the fee leg.
```

`AuthorizeFromBudget` is only an interface with `authorizeFromBudget(request: unknown): Promise<NearEscrowPayment>`. No budget signing format is implemented until Arras v2 supplies frozen vectors and the facilitator enables it. That adapter must use a function-call key limited to that method/contract and zero deposit.

After building, run `node examples/near-escrow-agent.mjs` for deterministic offline requests with a deliberately public test seed. It submits nothing. No development key was available in this Windows worktree, so live testnet transactions were not run. To exercise testnet, supply development payer/capturer keys locally and fresh nonce/height/deadlines/salt, then verify/settle authorize → release → worker and fee withdrawals, and a second authorize → refund → payer withdrawal. Check `get_payment`, `get_claimable`, USDC balances and `arras` events after each transaction. Arras' `scripts/testnet.sh` documents setup.

For live cross-language byte conformance, build this package, install the Python SDK's `near` extra from the H-7 checkout, set `UVD_X402_PY_ROOT` to that checkout and `UVD_PYTHON` to its interpreter, then run `node scripts/xlang/near-escrow-conformance.mjs`. It compares the actual TypeScript bundle with the Python implementation: frozen fixture hash, all three messages/preimages/IDs, 21 signed authorization/lifecycle delegates, the `NEAR_ESCROW_CONTRACTS` registry and five cases each runtime must refuse before signing (unregistered and cross-network contracts, and the nonce ceiling). This runner signs every vector on testnet with the registered contract and testnet USDC; the unit suite also verifies mainnet v1 authorization and release signatures independently with OpenSSL. A missing Python implementation, a Python SDK without the registry, or a mismatching artifact fails the command. This is a separate opt-in check until both paired SDK PRs are merged; the existing CI cross-language job continues to cover ERC-8128/EVM.

On Windows, changing `PATH` to select Node 20 may still leave `npm.ps1` using the Node executable beside that launcher. Invoke the npm CLI with the selected Node executable explicitly when reproducing CI (`& $node20 $npmCli run test:run`, where `$npmCli` points to npm's `bin/npm-cli.js`), and use the same runtime for installation and the pre-push checks. The native OWS library has no Windows binary; its dedicated Linux CI load check remains required.

## Exact NEAR and NEP-413 (2.109.0)

`signExactNearDelegate({network, signer, senderId, token, payTo, amount, nonce, maxBlockHeight, gas?})` is the offline local-key exact signer. It reuses the escrow Borsh serializer and NEP-366 signing routine, returning the same x402 v2 envelope with `scheme: 'exact'`. It signs one `ft_transfer`, with `receiver_id` and decimal-string `amount`, no memo, one yocto, and positive gas at most 30 TGas (default 30). Only network-native USDC is accepted. `intents.near` is refused. Supply a FullAccess key, a fresh nonce and a short-lived height. The caller must check that the payee is the intended account and, for KK, has no contract code; an offline signer cannot inspect `code_hash` or key permissions. The existing browser `NEARProvider.signPayment` remains available; local agents should use this raw-digest helper.

```js
import { signExactNearDelegate, signNep413 } from 'uvd-x402-sdk/near';
const exact = await signExactNearDelegate({
  network: context.network, signer: context.signer, senderId: context.senderId,
  token, payTo: msg.receiver, amount: '10000', nonce: nextAccessKeyNonce,
  maxBlockHeight: shortLivedHeight,
});
const proof = await signNep413({
  signer: context.signer, accountId: context.senderId,
  message: serverChallenge, nonce: challengeNonce32Bytes, recipient: 'execution.market',
  // callbackUrl: optionalExactCallback,
});
```

`signNep413` follows [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md): SHA-256 of little-endian `2^31+413` plus Borsh message string, fixed 32-byte nonce, recipient string and `Option<String>` callback URL. An omitted callback differs from an empty callback. The output is `{accountId, publicKey: 'ed25519:<base58>', signature: '<base64>'}`. `nep413Preimage` exposes the exact prefixed bytes. Unicode scalar values are encoded as UTF-8; malformed UTF-16 is rejected. Recipients equal to `intents.near` (including case/trailing-dot equivalents) are refused before signing. The helper signs offline with the supplied key: use a FullAccess key and have the verifier bind that public key to the account on the intended network, check its permissions, and validate the server challenge, nonce, recipient and callback. A signature alone does not establish that the key belongs to the account. No callback is navigated and no message is sent.

## Payer-funded storage registration

`buildArrasStorageDeposit({network, payerId, escrowContract, accountId?, deposit?})` and `buildUsdcStorageDeposit({network, payerId, accountId?, deposit?})` return unsigned normal transactions in wallet-selector shape: `{signerId, receiverId, actions: [{type: 'FunctionCall', params: {methodName, args, gas, deposit}}]}`. Gas and deposit are decimal strings in atomic units. The payer signs and submits these transactions with a FullAccess key and pays their deposits and gas. They are not NEP-366 delegates and must not be sent to the facilitator as payment payloads.

The Arras contract must be explicitly supplied and listed in `NEAR_ESCROW_CONTRACTS` for the selected network, just as for escrow signing. The builder refuses unregistered and cross-network targets before returning a transaction; it never guesses an account parent. The USDC target comes from the selected network. `accountId` defaults to the payer and may register another recipient. The default Arras deposit is 0.05 NEAR (`50000000000000000000000` yocto), measured to cover about five payments, with `registration_only: false` so the surplus remains usable for payment storage. USDC defaults to 0.00125 NEAR (`1250000000000000000000` yocto), with `registration_only: true` so surplus is refunded. Gas is 30 TGas for each. Query the target's `storage_balance_bounds` and `storage_balance_of` before live use and pass a suitable `deposit` in yoctoNEAR; defaults are planning amounts, not a guarantee of capacity or the current contract minimum. Fund Arras before authorizing. Register the worker and fee recipient in USDC before withdrawal.

## Receipt event parsing

```js
import { parseArrasEvents } from 'uvd-x402-sdk/near';
const logs = outcome.receipts_outcome
  .filter(r => r.outcome.executor_id === trustedEscrowContract && 'SuccessValue' in r.outcome.status)
  .flatMap(r => r.outcome.logs);
for (const event of parseArrasEvents(logs)) {
  if (event.event === 'withdrawn') {
    for (const leg of event.data) {
      if (!leg.ok) { /* retry registration/withdrawal; funds returned to claimable */ }
    }
  }
}
```

`parseArrasEvents(logs)` returns a discriminated union of NEP-297 envelopes `{standard: 'arras', version: '1.0.0', event, data: [...]}`. Batches are preserved. All eleven v1 events from `escrow-core/src/events.rs` are supported: `authorized`, `released`, `refunded`, `reclaimed`, `withdrawn`, `compacted`, `operator_registered`, `operator_updated`, `caps_set`, `paused`, `unpaused`. Amounts and nanosecond timestamps stay exact decimal strings; `fee_bps` is a number and `ok`/`paused` are booleans. Operator updates may omit fields that did not change. Foreign logs, unknown standards/versions/event names and malformed batches are skipped without throwing; a single invalid data item rejects its entire batch. Extra data fields are retained for forward-compatible readers. Check the receipt's executor and success separately: any contract can emit a string that looks like an Arras event, so parsing alone proves no payment.

`src/providers/near/vectors/near-kk.json` freezes the official NEP-413 example inputs with independently generated preimage/digest/signature bytes, Unicode and callback variants, exact delegates for both networks, and constructed Rust event envelopes. After building, run `node scripts/xlang/near-kk-conformance.mjs` with `UVD_X402_PY_ROOT` and `UVD_PYTHON` pointing to the H-7 checkout/interpreter. It compares the actual implementations' preimages, signatures, delegates, storage transactions and parsed events, with no RPC calls.
