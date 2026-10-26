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

const outbox = new SqliteRatingOutbox(new Database('reputation.db'));      // PRAGMA synchronous = FULL (the default)
const caps = { perViewerPerStream: 3, perViewerPerDay: 3, perViewerLifetime: 15, perStream: 25, perDay: 60, lifetime: 74_000, maxAmountPerRating: 1000, maxValue: 95 };
const deps = {
  outbox, client: new Erc8004Client(), rpc: jsonRpc(baseRpcUrl),
  signer: signerFromEthers(new ethers.SigningKey(await yourSecretStore.raterKey())), // a dedicated rater wallet
  governor: new Governor(caps, describeNetHealth(), { store: outbox }),
  resolveAgent: (row) => yourAgentIdFor(row.subject),        // runs BEFORE paying; null = no agent, never paid
  buildFeedback: (row) => publishEvidence(row),               // feedbackUri/feedbackHash, see below
};
await outbox.enqueue({ ref: messageRef('my-app:v1', streamId, messageId), network: 'base', subject: wallet, streamId, value: 90, amount: 1000, viewerId });
for (;;) { for (const r of await outbox.due(Math.floor(Date.now() / 1000), 1)) await processRating(r.ref, deps); await new Promise((ok) => setTimeout(ok, 5000)); }
```

`enqueue` only writes a row: whatever produced the moment never waits for the chain. One worker (one rater, one
serialized loop like the last line) does the rest, one row at a time: admit, resolve the agent and check its owner,
pay, prove, prepare, check, sign, store, send, reconcile, confirm. Read the row (`outbox.get(ref)`) to show a moment
as pending, anchored or local. Prefer a loop that awaits each tick over a `setInterval` that does not: the module
already refuses to tick one row twice at once in one process, but a second loop is still a second worker.

`publishEvidence` is yours, built on `evidenceDocument`:

```ts
import { evidenceDocument } from 'uvd-x402-sdk/reputation';

async function publishEvidence(row) {
  const agentId = row.agentId;                             // what resolveAgent found, checked against ownerOf
  const doc = evidenceDocument({
    network: row.network, agentId, rater: deps.signer.address, subject: row.subject, value: row.value,
    tag1: 'moment:idea', tag2: 'my-app', endpoint: 'https://www.twitch.tv/channel',
    createdAt: row.createdAt - (row.createdAt % 3600),       // unix seconds, rounded: an exact second can point at a chat line
    salt: await yourSaltFor(row.viewerId),                   // newSalt() once per viewer, kept locally, destroyed on !forgetme
    private: { moment_ref: row.ref, user_id: row.viewerId }, // published only as HMAC commitments
    proof: row.proof, issuer: { name: 'My App' }, context: { momentType: 'idea' },
  });
  const uri = await yourStorage.put(doc.body);             // serve these exact bytes
  return { agentId, tag1: 'moment:idea', tag2: 'my-app', endpoint: 'https://www.twitch.tv/channel', feedbackUri: uri, feedbackHash: doc.contentHash };
}
```

The document is the Python SDK's `evidence_document`, byte for byte from the same inputs. It refuses
(`ReputationError`, the Python codes) a key at any depth that names chat content or a person (`message`, `author`,
`login`, `chatText`, `author_name`, the Spanish words too: `private_field`), and a `private` value that shows up in a
public string (`private_value_leaked`: eight characters and up anywhere in the tags, the endpoint, `issuer` and
`context`; four to seven as a whole word in `issuer` and `context`). Put the chat text in `private` if you want it
committed to; it is then searched for everywhere else.

## The pieces

| Piece | What it does |
|---|---|
| `messageRef(namespace, ...parts)` | `sha256(namespace "|" parts...)`: the row key. The same moment always gives the same ref, so a restart or a second enqueue is a `duplicate`, never a second rating. |
| `validatePreparation(prep, params, rater)` | Refuses to sign anything but the rating asked for: the chain's own delegate and registry (from the module's table, never from the prepare), the v4 `RelayedGiveFeedback` type exactly, `verifyingContract` = the rater, every field equal to what was asked, a deadline within an hour, the digest rebuilt and compared. |
| `signRelayedFeedback`, `buildRelayAuthorization` | The rating and, on a rater's first rating on a chain, the EIP-7702 authorization, whose digest is built here from the module's delegate. Every signature is 65 bytes, low-s (a high-s one aborts) and must recover to the rater. |
| `payAndProve(...)` | The anchor payment: signs the USDC transfer, hands it to `onSigned` to be stored BEFORE broadcasting, and returns a `ProofOfPayment` with the block's timestamp and the facilitator's `paymentHash` recomputed. A retry re-broadcasts the same bytes. Gas has a ceiling, ETH a floor, and the USDC must cover the payment. |
| `RatingOutbox` | The persistent queue and its state machine. `MemoryRatingOutbox`; `SqliteRatingOutbox` (better-sqlite3, two prefixed tables in your own database). |
| `Governor(caps, health)` | Caps (all parameters) and the circuit breaker, persisted in the outbox. |
| `evidenceDocument(...)` | The public evidence, without the chat text, the login or the user id: those only as HMAC commitments under a per-viewer salt (`newSalt`, `commitment`). |
| `submitWithReconcile`, `processRating` | Send once, then read the chain. Never prepared twice while a signed rating could land. |
| `walletDirectory(entries)` | login → wallet from a self-declared list, with shared wallets (and logins listed twice) resolving to nobody. |

## The rules that move money

- **Nobody is paid who cannot be rated.** Before paying, the row's agent must be known (`agentId` at enqueue, or
  `resolveAgent`; without either the row waits with `agent_unknown`, and a `null` agent ends it `local_only`) and
  `ownerOf(agentId)` must be the rated wallet. The owner is checked again before the prepare.
- **One payment per rating, signed once, one at a time.** The signed transfer is stored (`paying`) before it is
  broadcast; a retry re-broadcasts the same bytes. No second payment starts while one is in flight, nor while a first
  rating's EIP-7702 authorization (signed over the account nonce) has not landed; and a first rating is not prepared
  while a payment is in flight. A transfer whose nonce another transaction took (the node does not know ours, and the
  account nonce moved past it) fails the row for a human only after an hour of looking that way, counted from the
  first time it was seen; a node that serves the nonce before the receipt makes it look so for a while.
- **One prepare per signed rating.** Once a row is `submitting`, a failed send, a timeout, a 503 or a 200 without a
  transaction hash are all answered by reading `NewFeedback` from the registry. Within the deadline the same signed
  submission may be re-sent (same nonce: at most one lands). The logs are not the last word, because a lagging node
  can answer them partially without an error: past the deadline, the delegate's `usedNonce[nonce]` cell is read
  straight from the rater's storage (`eth_getStorageAt`, at a block where the contract refuses the signature; the
  cell is checked against Base mainnet). Storage, not a call to `nonceUsed`, because under EIP-7702 it outlives the
  delegation: a rater whose delegation was revoked still shows its spent nonces. 0: the row goes back to `paid` for a
  new prepare. 1: the rating landed and the logs are read again from the first block; if they still do not show it a
  day after the send (a nonce cancelled by hand, a provider without old logs), the row fails for a human, never to a
  new prepare. Anything else: the row waits, and a day after the send it too fails for a human. The stored feedback is
  never replaced, so what is signed is what is sent and looked for.
- **Caps are parameters.** `ReputationCaps` has eight, and the module has no default for any of them. The six counts
  are per rated WALLET (two logins sharing a wallet share its caps), over admitted rows:

  | cap | when reached |
  |---|---|
  | `perViewerPerStream`, `perViewerLifetime`, `perStream`, `lifetime` | the row ends `local_only` |
  | `perViewerPerDay`, `perDay` | the row waits for 00:00 UTC |
  | `maxAmountPerRating`, `maxValue` (on the row itself) | the row ends `local_only` |

  `perDay * maxAmountPerRating` is the most that leaves the rater wallet in a day, plus gas (`maxFeePerGasWei` and
  `maxGasLimit` bound that per payment). `perViewerLifetime` is further held at `campaign_per_rater - 5`, read live
  from describe.net's `GET /health` (`reading_policy.campaign_per_rater`); pass `null` as the health source to run
  without it, on purpose.
- **The breaker** (persisted, so a restart keeps it): the facilitator's daily write limit opens it until 00:00 UTC;
  another 429 or a 503 (the writer lease) for its `Retry-After` (at least a minute); writes switched off (404/405), a
  proof refused while proofs are enforced, or the rater's ETH or USDC short of a payment for an hour; two transient
  failures in a row (502, 504, no answer) for an hour. While open, no new row is admitted and no row is prepared or
  re-sent; reconciling never stops. A breaker it cannot read refuses everything. It is meant for one worker per rater:
  two workers can each read it, and one write can cover the other's.
- **SQLite must keep its commits.** `SqliteRatingOutbox` refuses a connection below `PRAGMA synchronous = FULL`: with
  WAL and `NORMAL`, the last commits can roll back after a power cut, and a stored payment would be signed again.

## The outbox

```
queued -> paying(signed tx) -> paid(proof) -> submitting(nonce, deadline, signature) -> submitted(tx) -> confirmed
any active state -> failed(reason)      queued | paid -> local_only(reason)
```

Every write is a compare-and-set on the status and on the row's `version` the worker read (every write bumps it): a
row that went `submitted -> paid -> submitted` meanwhile has the same status but is not the same row. The rules live
in `applyTransition`, which both adapters call. Two workers racing on one row: the second loses the compare-and-set and
sends nothing. Another store (Mongo, Postgres) implements `RatingOutbox` and calls `applyTransition` and `forgetRow`
the same way, reading the row and writing it back atomically.

`outbox.forget(viewerId)` (`!forgetme`): a `queued` row is deleted; a `paid` one ends `local_only` and is never
submitted; a row still settling (`paying`, `submitting`, `submitted`) finishes without the viewer's data; every
kept row loses its `viewerId` and `payload`, and keeps only what reconciliation and the caps need: the ref, the rated
wallet, the stream id, the status and the transactions. What is on-chain stays on-chain: there is no relayed
revocation. Destroy the viewer's salt too, and the commitments in their evidence can no longer be linked to them.
Enqueue with `viewerId`, or there is nothing to forget by.

## Vectors

`test/vectors/reputation/*.json` (message refs, prepares with their digests, typed data, signatures and
authorizations, refused prepares with their codes, payment hashes, the anchor transfer, evidence documents and their
refusals) are the Python SDK's files, byte for byte: uvd-x402-sdk-python `tests/vectors/reputation/`, recorded by its
`scripts/reputation_vectors.py`, which checks every value against eth-account, the facilitator's captured
`paymentHash` and the delegate deployed on Base before writing. Both suites pin the same sha256. A change that moves
one of these bytes is recorded there and copied here, never edited by hand on either side.

## Not here

Registering an agent for a subject that has none, anchoring a login to a platform user id, a Mongo adapter (the
Python SDK's), reading reputation (that is `uvd-describe-sdk`), replacing a payment stuck under a base fee above its
ceiling (it stays `paying`, and holds the next payment, until it mines or a human looks), and revoking a rating (no
relayed revocation exists).
