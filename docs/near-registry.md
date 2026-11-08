# NEAR identity and reputation registry

Import from `uvd-x402-sdk/near`. These helpers target the legacy Arras `registry-v1`
contract ABI. Its mainnet contract, `registry.arras-escrow.near`, has
been [deployed without access keys since 2026-11-04](https://nearblocks.io/address/registry.arras-escrow.near).
The SDK registers it with `v1.arras-escrow.near` as the accepted escrow; testnet
has no registered deployment for this legacy API.

Execution Market switched from this registry to the separate NEAR ERC-8004
identity and reputation contracts on 2026-11-06. Use the [NEAR ERC-8004 integration
guide](near-erc8004.md) for current Execution Market registration and payment-backed
feedback. The legacy helpers below remain available under their existing names;
they do not call or migrate data to the ERC-8004 registries.

```ts
import {
  buildRegistryRegister, buildRegistryUpdate, buildGiveFeedback, buildRevokeFeedback,
  createNearLocalSigner, signRegistryTransaction, getConfig, getSummaryByOperator,
  listFeedback, summarizeFeedback, parseGiveFeedbackOutcome, safeLink, displayText,
} from 'uvd-x402-sdk/near';

const network = 'near:mainnet' as const;
const config = await getConfig({ network });
const registration = buildRegistryRegister({
  network, signerId: 'agent.near', agent_uri: 'https://agent.example/card.json',
  deposit: config.register_deposit,
});
await wallet.signAndSendTransaction(registration);

const feedback = buildGiveFeedback({
  network, signerId: 'payer.near', escrow: 'v1.arras-escrow.near',
  payment_id: paymentId, score: 90, tag1: 'quality', tag2: 'successRate',
  feedback_uri: 'https://agent.example/feedback/1.json',
  deposit: config.feedback_deposit,
});
const execution = await wallet.signAndSendTransaction(feedback);
const result = parseGiveFeedbackOutcome(execution);
if (result.status === 'rejected') console.log(result.code);
```

All four builders return `{signerId, receiverId, actions: [{type: 'FunctionCall',
params: {methodName, args, gas, deposit}}]}` for wallet selector. They are offline.
Use `buildRegistryUpdate` with the same identity fields to replace the URI and
metadata. Missing/null metadata clears it. `buildRevokeFeedback` takes the network,
signer, escrow and payment ID and attaches exactly one yoctoNEAR.

The defaults are 17,510,000,000,000,000,000,000 yoctoNEAR for register/update and
18,640,000,000,000,000,000,000 for feedback. Query `getConfig` for current required
deposits and pass them explicitly. Register and feedback reject amounts below their
defaults. Update accepts any deposit from 1 yoctoNEAR, with REGISTER_DEPOSIT as its
default; the contract checks the actual storage growth charge. Update checks a zero
deposit (E06) before URI (E01) and metadata (E02). Surplus storage deposits are
refunded by the contract. Gas defaults to 30 TGas, or 100 TGas for feedback (60 TGas
minimum). Zero gas for register/update/revoke and gas above 300 TGas raise ordinary
SDK errors; E17 is reserved for feedback below 60 TGas. Gas arguments use integer gas units, deposits use integer yoctoNEAR.

Validation mirrors the contract: URI 512 ASCII bytes with an RFC 3986 scheme and
nonempty content; metadata 1–1024 UTF-8 bytes without ASCII control characters;
tags 1–64 bytes of `[A-Za-z0-9._:/-]`; payment ID 1–64 printable ASCII bytes without
spaces; score an integer 0–100; feedback hash exactly 64 lowercase hex characters
without a prefix. Inputs are never trimmed or normalized. Null/undefined optional
arguments are omitted. Compact JSON follows the contract argument table order.

Local validation throws `RegistryValidationError` with `RegistryErrorCode` and an
`ARRAS_REG_Enn` message. State-dependent errors (already registered, missing identity,
duplicate/pending feedback, actual storage charge, missing/revoked feedback) remain
contract checks. No offline helper claims to establish the current chain state.

For a server-side local signer, reuse `createNearLocalSigner` and provide a recent
base58 block hash and the **next** access-key nonce:

```ts
const signer = createNearLocalSigner(seedFromYourKeyStore);
const signedTx = await signRegistryTransaction(feedback, signer, nextNonce, blockHash);
// signedTx is normal SignedTransaction Borsh in base64 for send_tx's signed_tx_base64.
// The application submits it and waits for the final execution outcome.
```

The key must be **FullAccess**: a FunctionCall access key cannot attach the required
deposit. The caller checks access-key permission; signing performs no network calls.
This signs SHA-256(Transaction), without the NEP-366 delegate prefix. It validates
receiver, method, arguments, gas and deposit again, snapshots the bytes before the
asynchronous signer runs, and verifies the Ed25519 signature returned by the signer.

Views use `{network, registryContract?, rpc?}` as their first argument:

| Helper | Remaining arguments | Result |
|---|---|---|
| `getConfig` | none | `RegistryConfigView` |
| `getAgent` | account ID | `AgentView` or null |
| `listAgents` | `{from_index?, limit?}` | `AgentView[]` |
| `getFeedback` | numeric feedback ID | `FeedbackView` or null |
| `getFeedbackForPayment` | `{escrow, payment_id, rater}` | `FeedbackView` or null |
| `listFeedback` | account ID, `{from_index?, limit?}` | `FeedbackView[]` |
| `getSummary` | account ID | `SummaryView` |
| `getSummaryByOperator` | account ID, operator ID | `SummaryView` |
| `isFeedbackPending` | `{escrow, payment_id, rater}` | boolean |

The injected async `rpc(method, params)` returns the JSON-RPC **result** object,
e.g. `{result: [123, ...]}` for `call_function`, rather than the outer JSON-RPC
envelope. Without injection the helpers use fetch against the selected NEAR RPC.
All nine views return promises, including for invalid inputs: `.catch(...)` handles
validation and transport errors. Every view decodes UTF-8 JSON and checks all required fields; invalid shapes fail.
U64/U128 fields remain exact decimal strings. Pagination indexes/limits are u32;
the contract caps a page to 50 entries. Fetch every page for a complete summary.

`parseGiveFeedbackOutcome` accepts a decoded numeric ID, `{value, logs}`, or a final
NEAR execution outcome. It returns `accepted` with `feedbackId`, `rejected` with
the callback code, or `error` with a recognized contract panic code/message. An
unrecognized failure, null without a valid rejection log, or pending outcome throws.
A successful callback rejection returns the full deposit. A panic fails execution;
a callback that fails unexpectedly has different refund behavior, so do not treat
an unknown failure as a parsed rejection.

`parseRegistryReceiptEvents(execution.receipts_outcome, network)` recognizes the four
NEP-297 `arras-registry` 1.0.0 events only in receipts whose `outcome.executor_id`
belongs to `NEAR_REGISTRY_CONTRACTS[network]` AND whose `outcome.status` is an
object containing a string `SuccessValue` or `SuccessReceiptId`. The function skips
the entire receipt for any `Failure`, `Unknown`, missing or malformed status, even
if it emitted valid event logs before failing. Other emitters are ignored even if
their event JSON names the expected escrow and operator. Testnet currently has no
trusted registry emitter. Malformed receipts/logs are skipped and successful
batches retain their receipt and log order. Supply receipts from a trusted RPC.

`parseRegistryEvents(logs)` parses the same envelopes without receipt context. It is
safe only when the caller has already filtered receipts by `executor_id` for the
selected network and successful execution status. Loose logs cannot establish
execution success or authenticate an emitter; this also applies to
rejection logs passed to `parseGiveFeedbackOutcome`.

## Legacy registry flow and trust

Once an Arras v1 payment with operator `em` releases any amount, its payer may
rate the receiver and its receiver may rate the payer. A later refund/reclaim does
not invalidate an earlier partial release. Submit feedback promptly: after payment compaction (eligible at
`reclaim_after + 7 days`) the registry can no longer resolve that payment. Each
party gets one feedback per escrow/payment and can revoke its own feedback.
Neither party needs an identity registration to give or receive feedback.

Use `getSummaryByOperator(options, accountId, 'em')` and filter detail by both
`escrow === 'v1.arras-escrow.near'` and `operator_id === 'em'`. The global summary
mixes operators and raters and is only a reference. Escrow operators and payment
release authority determine the evidence behind a rating; a paid interaction does
not establish independence between participants. Account recreation also inherits
that account's registry identity and reputation.

`summarizeFeedback(rows, escrow, operatorId)` filters that detail, excludes revoked
rows from scores, and reports active count, distinct active raters, revoked count,
and `released_total` as a decimal string. `average_x100` is
`floor(sum(score) * 100 / count)`; `weighted_average_x100` is
`floor(sum(score * released) * 100 / sum(released))`. All sums use bigint. Empty
active sets have null averages; zero released weight has a null weighted average.
The helper does not paginate, deduplicate, or select a ratee: provide the intended
account's rows once each. Weighting and distinct raters provide useful context;
no single aggregate establishes trust.

Treat registry text as untrusted. `safeLink(uri)` allows only `https:`, `ipfs:` and
`ar:` (case insensitive) and otherwise returns null. `displayText(text)` removes
controls, bidi formatting and zero-width/default-ignorable characters. Render it as
plain text with your UI framework's normal escaping; it is not an HTML sanitizer.
The contract intentionally accepts more URI schemes and metadata characters than
are suitable for direct display.
