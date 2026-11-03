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

The delegate targets native USDC with one `ft_transfer_call` to the escrow's `receiver_id`. Deposit is one yocto; gas defaults to 100 TGas and must be 38..100 TGas. `buildEscrowAuthorizationDelegate` and `validateEscrowAuthorizationDelegate` expose those checks. The SDK signs only for the Arras deployments listed in `NEAR_ESCROW_CONTRACTS` and refuses any other `escrowContract` before calling the signer, for the authorization and for every lifecycle call: a signed delegate can be relayed by anyone, so a server must not be able to point it at its own account. The mainnet row stays empty until the mainnet Arras contract is deployed and added in a release, so mainnet escrow signing is refused today. Select the operator from trusted configuration checked against `/supported`; on 2026-11-02, [the facilitator](https://facilitator.ultravioletadao.xyz/supported) advertised escrow only for testnet.

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

For live cross-language byte conformance, build this package, install the Python SDK's `near` extra from the H-7 checkout, set `UVD_X402_PY_ROOT` to that checkout and `UVD_PYTHON` to its interpreter, then run `node scripts/xlang/near-escrow-conformance.mjs`. It compares the actual TypeScript bundle with the Python implementation: frozen fixture hash, all three messages/preimages/IDs, 21 signed authorization/lifecycle delegates, the `NEAR_ESCROW_CONTRACTS` registry and five cases each runtime must refuse before signing (unregistered and cross-network contracts, and the nonce ceiling). Until the registry has a mainnet row, every vector signs on testnet with the registered contract and testnet USDC. A missing Python implementation, a Python SDK without the registry, or a mismatching artifact fails the command. This is a separate opt-in check until both paired SDK PRs are merged; the existing CI cross-language job continues to cover ERC-8128/EVM.

On Windows, changing `PATH` to select Node 20 may still leave `npm.ps1` using the Node executable beside that launcher. Invoke the npm CLI with the selected Node executable explicitly when reproducing CI (`& $node20 $npmCli run test:run`, where `$npmCli` points to npm's `bin/npm-cli.js`), and use the same runtime for installation and the pre-push checks. The native OWS library has no Windows binary; its dedicated Linux CI load check remains required.
