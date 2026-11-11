# NEAR ERC-8004

Import the new API from `uvd-x402-sdk/near`. Identity and reputation use separate
contracts, with an Arras verifier for payment-backed feedback. The older Arras
registry API remains available under its existing names. Validation Registry is
not exposed.

| Network | Identity | Reputation | Arras verifier |
| --- | --- | --- | --- |
| `near:mainnet` | `identity-registry.erc-8004.near` | `reputation-registry.erc-8004.near` | `erc8004-verifier.arras-escrow.near` |
| `near:testnet` | `identity-registry.erc-8004.testnet` | `reputation-registry.erc-8004.testnet` | `erc8004-verifier.arras-dev.testnet` |

`NEAR_ERC8004_CONTRACTS` freezes these targets and their `agentRegistry`
identifiers, for example `near:mainnet:identity-registry.erc-8004.near`.
Mainnet verification reads `v1.arras-escrow.near`; testnet reads
`arras-v1b-1101.testnet`. This release's proof helpers accept the listed Arras
verifier for the selected network.

Each verifier reads one escrow, so a payment is rated with the verifier of the
escrow it was paid in. `NEAR_ERC8004_ESCROW_VERIFIERS` has one row per Arras
escrow of `NEAR_ESCROW_CONTRACTS`, and `nearErc8004Verifier(network, escrow)`
returns that row's verifier:

| Network | Escrow | Verifier |
| --- | --- | --- |
| `near:mainnet` | `v1.arras-escrow.near` | `erc8004-verifier.arras-escrow.near` |
| `near:mainnet` | `v2.arras-escrow.near` | none yet (`null`) |
| `near:testnet` | `arras-v1b-1101.testnet` | `erc8004-verifier.arras-dev.testnet` |

Arras v2 has no deployed verifier yet: `nearErc8004Verifier` throws for
`v2.arras-escrow.near`, so the SDK hands out no verifier for v2 payments. A
release fills the v2 row once its verifier account is deployed on mainnet.

The proof helpers accept any verifier of the table for the network: they cannot
see which escrow a proof was paid in, so pick the verifier with
`nearErc8004Verifier(network, escrow)` from the escrow the task was paid in. A
v2 payment sent to the v1 verifier is rejected on chain (the v1 verifier reads
v1 only): a wasted transaction.

`client.getConfig(verifier)` and `client.getVerifierConfig(verifier)` read the
`get_config` of that verifier (default: `NEAR_ERC8004_CONTRACTS[network].verifier`),
refuse any account outside the table before RPC, and require the snapshot's
`escrow` to be the one that verifier rates. A verifier that does not answer
rejects the call, so nothing is quoted against it. `verify_feedback_proof` goes
to the verifier of the escrow its quoted config reads.

## Registration paid by Execution Market

Obtain configuration from the contracts before constructing transactions. The
SDK checks contract identity, version, limits, network bindings, gas floors and
storage ceilings. It does not silently fall back to a fixed deposit.

```ts
import {
  NearErc8004Client, NEAR_ERC8004_CONTRACTS,
  buildNearErc8004Register, buildNearErc8004NftTransfer,
  parseNearErc8004RegisterOutcome,
} from 'uvd-x402-sdk/near';

const network = 'near:mainnet' as const;
const client = new NearErc8004Client({ network });
const config = await client.getConfig();
const options = { network, config, signerId: executionMarketAccount };

const registered = await wallet.signAndSendTransaction(
  buildNearErc8004Register({ ...options, agent_uri: registrationFileUri }),
);
const agentId = parseNearErc8004RegisterOutcome(registered, network);
await wallet.signAndSendTransaction(buildNearErc8004NftTransfer({
  ...options, receiver_id: workerAccount, token_id: agentId,
}));
```

The wallet, accounts and registration file URI are supplied by the application.
Execution Market signs both transactions. After the transfer the worker owns the
NFT and `agentWallet` is empty. Persist the `agentId` after registration so a
failed transfer can be retried without registering another agent. If the worker
registers directly, the worker becomes both owner and agentWallet in one call.

A worker can set its wallet using `buildNearErc8004SetAgentWallet` with its own
`signerId`, the `agent_id`, `new_wallet`, and a canonical decimal `deadline` in
nanoseconds. For example, `(BigInt(Date.now()) * 1_000_000n + 120_000_000_000n).toString()`
sets a deadline two minutes ahead. The accepted window is inclusive from now to
five minutes ahead; offline signing checks it again. If another account is
proposed, that account calls `buildNearErc8004AcceptAgentWallet` before the deadline.
`buildNearErc8004UnsetAgentWallet` clears it. Approval revocation also clears a
pending wallet on-chain.

## Feedback after a released payment

The payer rates the worker's agent; the worker can rate the payer's agent using
its own signature. Supply the actual released payment's ID as `proof`.

```ts
import {
  buildNearErc8004GiveFeedbackWithProof, nearErc8004Verifier,
  parseNearErc8004GiveFeedbackOutcome,
} from 'uvd-x402-sdk/near';

// The verifier of the escrow the payment was made in: throws for v2 until its verifier is registered.
const verifier = nearErc8004Verifier(network, paymentEscrowContract);
const tx = buildNearErc8004GiveFeedbackWithProof({
  network, config: await client.getConfig(), signerId: payerAccount,
  agent_id: workerAgentId, value: '90', value_decimals: 0,
  tag1: 'starred', verifier, proof: releasedPaymentId,
});
const finalOutcome = await payerWallet.signAndSendTransaction(tx);
const result = parseNearErc8004GiveFeedbackOutcome(finalOutcome, network);
if (result.status === 'accepted') {
  console.log(result.feedbackIndex);
} else if (result.status === 'rejected') {
  console.log(result.code); // NearErc8004RejectionCode
} else {
  console.log(result.code, result.message); // transaction failure
}
```

A successful transaction can still return a callback rejection. The parser
requires a final result, validates the transaction target and method, and binds
accepted indexes to matching authenticated events. Rejection logs are accepted
only from successful reputation receipts. `VerifierFailed` means the verifier
failed; its receipt in `finalOutcome` contains the underlying reason. Do not
retry a proof without checking `get_proof_feedback` / `is_proof_pending` first.
A proof can be used once per verifier, payment and client. The payment must still
be available to the verifier; compacted payments cannot supply a proof.

The counterparty must be the rated agent's owner or agentWallet. The verifier
supplies the counterparty role, payment context and released amount as `weight`.
`buildNearErc8004GiveFeedback` creates ordinary feedback without a payment proof;
that feedback does not enter the verified summary. Revocations use
`buildNearErc8004RevokeFeedback`; responses use `buildNearErc8004AppendResponse`.

## Display verified reputation

```ts
const summary = await client.getVerifiedSummary({
  agent_id: workerAgentId, verifier, context: 'em',
});
// count, summary_value and weight_sum remain exact decimal strings.
const refs = await client.listVerifiedFeedback({
  agent_id: workerAgentId, verifier, from_index: 0, limit: 50,
});
const detail = await Promise.all(refs.map(async ref => ({
  feedback: await client.readFeedback(ref),
  proof: await client.readFeedbackProof(ref),
})));
```

The summary excludes revoked feedback. The detail list includes revoked entries,
so read `is_revoked`. `summary_value_decimals` scales the signed summary value;
the summary is an arithmetic average, while `weight_sum` separately totals the
proof weights. Arras weights are atomic released token units (USDC has six
decimals). The `context: 'em'` filter is an exact match. Ordinary `getSummary`
requires a nonempty list of trusted client accounts.

## API and wire types

All builders return one wallet-selector `FunctionCall` descriptor with decimal
string `gas` and `deposit`. Prefix each name below with `buildNearErc8004`:

| Group | Builders |
| --- | --- |
| Identity | `Register`, `SetAgentUri`, `SetMetadata`, `SetAgentWallet`, `AcceptAgentWallet`, `UnsetAgentWallet` |
| NFT | `NftTransfer`, `NftTransferCall`, `NftApprove`, `NftRevoke`, `NftRevokeAll` |
| Reputation | `GiveFeedback`, `GiveFeedbackWithProof`, `RevokeFeedback`, `AppendResponse` |
| Proof precheck | `VerifyFeedbackProof` |

`VerifyFeedbackProof` constructs an asynchronous contract call with zero deposit;
it consumes gas and is not a JSON-RPC view. The SDK does not submit transactions.
`buildNearErc8004Transaction(method, options, args)` is the typed generic builder.
`signNearErc8004Transaction(descriptor, signer, { network, config, nonce, blockHash })`
creates a normal signed NEAR transaction in base64. It revalidates the complete
call before touching the signer and verifies the returned Ed25519 signature.
The caller supplies a FullAccess key, next access-key nonce and recent block hash.
The existing `NearLocalSigner` interface can be reused.

`NearErc8004Client` offers `getConfig`, individual config getters, `getVersion`,
`getAgent`, `getAgentUri`, `getMetadata`, `getAgentWallet`, `getPendingAgentWallet`,
`readFeedback`, `readFeedbackProof`, `getSummary`, `getVerifiedSummary` and
`listVerifiedFeedback`. Its typed `view(method, args)` covers the complete view
interface:

- Identity: `nft_token`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner`,
  `nft_total_supply`, `nft_metadata`, `nft_is_approved`, `token_uri`, `get_metadata`,
  `get_agent_wallet`, `get_pending_agent_wallet`, `is_authorized_or_owner`, `check_agent`.
- Reputation: `get_summary`, `read_feedback`, `read_all_feedback`, `get_response_count`,
  `get_clients`, `get_last_index`, `get_identity_registry`, `read_feedback_proof`,
  `get_proof_feedback`, `is_proof_pending`, `list_verified_feedback`, `get_verified_summary`.
- Config/version aliases: `identity_config`, `reputation_config`, `verifier_config`,
  `identity_version`, `reputation_version` route to their contracts' actual methods.

An injected `rpc(method, params, signal?)` returns the JSON-RPC result object
(the `call_function` object containing a byte-array `result`), not its envelope.
Reads time out after 15 seconds by default (`timeoutMs` accepts 1..60000). Decoded
view payloads are limited to 1 MiB and lists to 100 entries; paginated calls
supply a default limit of 100. `read_all_feedback` has no contract pagination and
rejects an oversized response: use paginated refs and individual reads instead.

IDs, deadlines, feedback values and amounts are canonical decimal strings: no
leading zeroes, plus signs, whitespace or negative zero. Values are bounded to
±10^38 and decimals to 0..18. Summaries support signed values up to 56 digits;
weights sum in 256 bits. Hashes are exactly 64 lowercase hex characters without
`0x`, or omitted/null. NFT approval IDs and reputation page offsets are JSON
numbers in the deployed ABI; the SDK restricts them to safe integers. NFT page
offsets are decimal U128 strings.

Callback messages are capped at 16 KiB by the SDK.

URIs need a scheme and RFC 3986 characters. Builders preserve valid bytes and
reject malformed input; `normalizeNearErc8004Uri` explicitly encodes spaces and
Unicode when desired. It does not turn a bare CID into a URI. Empty optional
URIs are allowed; a response URI must be nonempty. Tags allow up to 64 UTF-8
bytes without Unicode control characters. Metadata values use canonical base64,
up to 1024 decoded bytes; writes reserve `agentWallet` for the dedicated methods.

## Budgets and indexing

Quotes for register and feedback, storage byte cost, deadline window and
available gas floors come from validated config. `NEAR_ERC8004_DEPOSIT_CAPS`
limits quotes and attached deposits to recorded worst-case amounts plus 5%.
Variable storage operations estimate a conservative budget from the configured
byte cost and data size; an explicit deposit can be used within the SDK ceiling.
The contract measures storage and refunds excess. One-yocto operations enforce
exactly one yocto. Defaults are 30 TGas for ordinary calls, 50 for transfer-call,
60 for feedback and 150 for feedback with proof, raised if a validated config
minimum requires more. The protocol maximum is 300 TGas.

`parseNearErc8004Events(finalOutcome, network)` checks final success and filters
receipt status, executor, event standard/version and data shape. It recognizes
`registered`, `metadata_set`, `uri_updated`, `agent_wallet_pending`, `nft_mint`,
`nft_transfer`, `new_feedback`, `feedback_revoked` and `response_appended`.
`parseNearErc8004ReceiptEvents(receipts, network)` is available to indexers that
already established final transaction success. It preserves receipt/log order.
Transaction parsers require `final_execution_status === "FINAL"` whenever that
field is present; older results without the field retain the existing status
and receipt checks.
Feedback outcome parsing requires any `args.verifier` to be a verifier of
`NEAR_ERC8004_ESCROW_VERIFIERS[network]`, including failed or rejected outcomes.

An indexer counts a `new_feedback` event as verified only when `proof.verifier`
is a verifier of `NEAR_ERC8004_ESCROW_VERIFIERS[network]` and `proof.context` equals the
expected context (`"em"` for Execution Market). A non-null proof alone is not
sufficient; the event parser preserves other verifiers and contexts for callers
to apply their own indexing policy.
A pending wallet is superseded by later wallet metadata, transfers or pending
wallet events, and expires at its deadline.

## Offline fixtures

`src/providers/near/vectors/near-erc8004.json` records 20 public views and six
historical transaction outcomes across both networks. Each view retains exact
compact argument JSON and UTF-8 hex. Transaction results retain receipts, logs
and execution statuses. Tests use these bytes without network access.

Regenerate explicitly with `node scripts/record-near-erc8004-vectors.mjs --record`.
The recorder makes only view and historical status requests, at least 1.1 seconds
apart. Compare with the companion SDK using
`node scripts/record-near-erc8004-vectors.mjs --compare <python-fixture>`; comparison
is offline and requires identical bytes. Run guard mutations from a clean tree
with `node scripts/mutate-near-erc8004.mjs` (120-second timeout per mutation).
