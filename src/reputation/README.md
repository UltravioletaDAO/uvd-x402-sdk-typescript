# `uvd-x402-sdk/reputation`

Write ERC-8004 ratings that the chain records as **authored by your program's rater wallet**, relayed by the
Ultravioleta facilitator (it pays the relay gas), each one anchored by a small USDC payment from the rater to the
rated wallet. One implementation for every program: the same contract, and the same shared vectors, as the Python
SDK's `uvd_x402_sdk.reputation`.

The module never reads a key, from the environment or anywhere else: it signs through a `ReputationSigner` you hand
it. Its logs shorten every long hex value and drop proofs and signatures.

## Fifteen lines into a new program

```ts
import Database from 'better-sqlite3';                       // optional peer dependency: npm i better-sqlite3
import { ethers } from 'ethers';
import { Erc8004Client } from 'uvd-x402-sdk/backend';
import { Governor, SqliteRatingOutbox, describeNetHealth, jsonRpc, messageRef, processRating, signerFromEthers } from 'uvd-x402-sdk/reputation';

const outbox = new SqliteRatingOutbox(new Database('reputation.db'));
const caps = { perViewerPerStream: 3, perViewerPerDay: 3, perViewerLifetime: 15, perStream: 25, perDay: 60, lifetime: 74_000 };
const deps = {
  outbox, client: new Erc8004Client(), rpc: jsonRpc(baseRpcUrl),
  signer: signerFromEthers(new ethers.SigningKey(await yourSecretStore.raterKey())), // a dedicated rater wallet
  governor: new Governor(caps, describeNetHealth(), { store: outbox }),
  buildFeedback: (row) => publishEvidence(row),               // agentId + feedbackUri/feedbackHash, see below
};
await outbox.enqueue({ ref: messageRef('my-app:v1', streamId, messageId), network: 'base', subject: wallet, streamId, value: 90, amount: 1000, viewerId });
setInterval(async () => { for (const r of await outbox.due(Math.floor(Date.now() / 1000), 1)) await processRating(r.ref, deps); }, 5000);
```

`enqueue` only writes a row: whatever produced the moment never waits for the chain. One worker (one rater, one
loop like the last line) does the rest, one row at a time: admit, pay, prove, prepare, check, sign, store, send,
reconcile, confirm. Read the row (`outbox.get(ref)`) to show a moment as pending, anchored or local.

`publishEvidence` is yours, built on `evidenceDocument`:

```ts
import { evidenceDocument } from 'uvd-x402-sdk/reputation';

async function publishEvidence(row) {
  const agentId = await yourAgentIdFor(row.subject);       // e.g. Erc8004Client.getIdentityByOwner
  const doc = evidenceDocument({
    network: row.network, agentId, rater: deps.signer.address, value: row.value,
    subject: { wallet: row.subject, walletBinding: 'self_declared_unverified', type: 'chat_participant' },
    tag1: 'moment:idea', tag2: 'my-app', endpoint: 'https://www.twitch.tv/channel', createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    context: { kind: 'idea' }, commitments: { momentRef: row.ref, viewerId: row.viewerId }, salt: await yourSaltFor(row.viewerId),
    proof: row.proof,
  });
  const uri = await yourStorage.put(doc.bytes);            // serve these exact bytes
  return { agentId, tag1: 'moment:idea', tag2: 'my-app', endpoint: 'https://www.twitch.tv/channel', feedbackUri: uri, feedbackHash: doc.contentHash };
}
```

## The pieces

| Piece | What it does |
|---|---|
| `messageRef(namespace, ...parts)` | `sha256(namespace "|" parts...)`: the row key. The same moment always gives the same ref, so a restart or a second enqueue is a `duplicate`, never a second rating. |
| `validatePreparation(prep, params, rater)` | Refuses to sign anything but the rating asked for: the chain's own delegate and registry (from the module's table, never from the prepare), the v4 `RelayedGiveFeedback` type exactly, `verifyingContract` = the rater, every field equal to what was asked, a deadline within an hour, the digest rebuilt and compared. |
| `signRelayedFeedback`, `buildRelayAuthorization` | The rating and, on a rater's first rating on a chain, the EIP-7702 authorization, whose digest is built here from the module's delegate. Every signature is 65 bytes, low-s (a high-s one aborts) and must recover to the rater. |
| `payAndProve(...)` | The anchor payment: signs the USDC transfer, hands it to `onSigned` to be stored BEFORE broadcasting, and returns a `ProofOfPayment` with the block's timestamp and the facilitator's `paymentHash` recomputed. A retry re-broadcasts the same bytes. Gas has a ceiling, ETH a floor. |
| `RatingOutbox` | The persistent queue and its state machine. `MemoryRatingOutbox`; `SqliteRatingOutbox` (better-sqlite3, two prefixed tables in your own database). |
| `Governor(caps, health)` | Caps (all parameters) and the circuit breaker, persisted in the outbox. |
| `evidenceDocument(...)` | The public evidence, without the chat text, the login or the user id: those only as HMAC commitments under a per-viewer salt. |
| `submitWithReconcile`, `processRating` | Send once, then read the chain. Never prepared twice while a signed rating could land. |
| `walletDirectory(entries)` | login → wallet from a self-declared list, with shared wallets (and logins listed twice) resolving to nobody. |

## The rules that move money

- **One payment per rating, signed once.** The signed transfer is stored (`paying`) before it is broadcast; a retry
  re-broadcasts the same bytes. A transfer whose nonce another transaction used fails the row for a human.
- **One prepare per signed rating.** Once a row is `submitting`, a failed send, a timeout, a 503 or a 200 without a
  transaction hash are all answered by reading `NewFeedback` from the registry. Within the deadline the same signed
  submission may be re-sent (same nonce: at most one lands). Only after the chain has been read past the deadline
  (plus two minutes) with no matching rating does the row go back to `paid` for a new prepare.
- **Caps are parameters.** `ReputationCaps` has six, and the module has no default for any of them. Counted per
  rated WALLET (two logins sharing a wallet share its caps), over admitted rows:

  | cap | when reached |
  |---|---|
  | `perViewerPerStream`, `perViewerLifetime`, `perStream`, `lifetime` | the row ends `local_only` |
  | `perViewerPerDay`, `perDay` | the row waits for 00:00 UTC |

  `perViewerLifetime` is further held at `campaign_per_rater - 5`, read live from describe.net's `GET /health`
  (`reading_policy.campaign_per_rater`); pass `null` as the health source to run without it, on purpose.
- **The breaker** (persisted, so a restart keeps it): the facilitator's daily write limit opens it until 00:00 UTC;
  another 429 for its `Retry-After` (at least a minute); writes switched off (404/405), a proof refused while proofs
  are enforced, or the rater's ETH below its floor for an hour; two transient failures in a row (502, 503, 504,
  no answer) for an hour. While open, no new row is admitted and no row is prepared or re-sent; reconciling never
  stops. A breaker it cannot read refuses everything.
- **The subject must own the agent.** `ownerOf(agentId)` is checked before the prepare, and before paying when the
  agent is given at enqueue (`agentId`).

## The outbox

```
queued -> paying(signed tx) -> paid(proof) -> submitting(nonce, deadline, signature) -> submitted(tx) -> confirmed
any active state -> failed(reason)      queued | paid -> local_only(reason)
```

Every write is a compare-and-set on the status; the rules live in `applyTransition`, which both adapters call. Two
workers racing on one row: the second loses the compare-and-set and sends nothing. Another store (Mongo, Postgres)
implements `RatingOutbox` and calls `applyTransition` and `forgetRow` the same way.

`outbox.forget(viewerId)` (`!forgetme`): a `queued` row is deleted; a `paid` one ends `local_only` and is never
submitted; a row still settling (`paying`, `submitting`, `submitted`) finishes without the viewer's data; every
kept row loses its `viewerId` and `payload`. What is on-chain stays on-chain: there is no relayed revocation. Destroy
the viewer's salt too, and the commitments in their evidence can no longer be linked to them.

## Vectors

`test/vectors/reputation/*.json` (message refs, prepares with their digests, signatures and authorizations, payment
hashes, canonical JSON, commitments and evidence documents) are derived by `scripts/derive-reputation-vectors.mjs`,
which does not import this module, and hold in Python with eth_account / hashlib / json
(`scripts/xlang/reputation-vectors-check.py`). The same files, with the same sha256, belong in
uvd-x402-sdk-python `tests/vectors/reputation/`.

## Not here

Registering an agent for a subject that has none, anchoring a login to a platform user id, a spend cap in token
units (the count caps times the amount bound it), a Mongo adapter (the Python SDK's), reading reputation (that is
`uvd-describe-sdk`), and revoking a rating (no relayed revocation exists).
