# Vote-decision cases

`conformance/vote-cases/` holds situations that a Keeta node decides, each with the outcome that `lib.Ledger` from `@keetanetwork/keetanet-client` 0.18.7 produces for it: a temporary vote, a permanent vote, a quote, an added staple, or a specific refusal. A node implementation conforms when it reproduces every case.

The expectations are recorded by running Keeta's own `Ledger`, never written by hand. Each case carries everything needed to run it again: key seeds, node settings, and every block, vote and staple as bytes. This document defines the format and the replay, so that a replay can be written in any language from the JSON alone.

## Conventions

- `[Keeta TS] index.js:N` is line N of `client/index.js` in the published `@keetanetwork/keetanet-client` 0.18.7 package.
- "Must" states a requirement on a replay.
- Case IDs follow a catalog of the decisions that `Ledger.vote`, `Ledger.quote` and `Ledger.add` make, grouped as the files are. The catalog itself is not published; section 10.1 lists its rows and the cases that cover each.
- `CONTRACT.md` means `schema/CONTRACT.md`, the storage driver contract, whose rules are cited as D4, D6 and so on.

## 1. Files

Each group of cases is one file, `conformance/vote-cases/<group>.json`:

| File | Cases | What they decide |
|---|---|---|
| `kind.json` | 21 | which vote a request asks for, the recovery vote, and the checks on other votes and quotes |
| `quorum.json` | 18 | voting weight for permanent votes and for adding staples |
| `clock.json` | 16 | the block window and vote validity |
| `conflicts.json` | 21 | heads, chains and competing blocks |
| `balances.json` | 15 | balances, receives and token supply |
| `permissions.json` | 48 | permissions, ownership, certificates and operation settings |
| `fees.json` | 31 | fees on temporary votes, fee blocks and quotes |
| `network.json` | 23 | network, subnet and idempotent keys |
| `modes.json` | 9 | write modes and nodes without a key |

A file is one JSON object:

```json
{ "format": "slop-node/vote-cases@1", "keetanetClient": "0.18.7", "cases": [ ... ] }
```

- `format` is always `slop-node/vote-cases@1`.
- `keetanetClient` is the exact version whose `Ledger` produced the expectations (section 9).
- `cases` is the list of cases. Case IDs are unique across all files.

`conformance/vote-cases.schema.json` is the JSON Schema (draft 2020-12) of a file. It states the structure. The rules it cannot state are listed with the fields they constrain below: references, node and actor indexes, error codes, and unique IDs.

Every file is written with two-space indentation, a fixed key order and a trailing newline. No field is ever `null` unless this document says so, and no field appears that it does not define. An absent optional field and the field with an empty value are different, and the format never writes one for the other.

## 2. Encodings

| Value | Encoding |
|---|---|
| Block, vote, quote, staple | base64 (RFC 4648, with padding) of its canonical bytes. A staple is carried in its uncompressed form, the form its hash covers [Keeta TS] index.js:81036-81040 |
| Amount, weight, subnet | a decimal string of a non-negative integer, without leading zeros |
| Account | its public key string, `keeta_...`, in the canonical form Keeta prints |
| Block hash | 64 uppercase hex digits, as Keeta prints a hash |
| Moment | ISO-8601 in UTC with milliseconds, `YYYY-MM-DDTHH:MM:SS.sssZ` |
| Seed | 64 lowercase hex digits (32 bytes) |
| Index | a JSON integer, counted from 0 |

## 3. Cases

A case is:

```json
{
  "id": "P9c",
  "title": "a request with a matching quote and no other votes gets a temporary vote",
  "basis": "upstream",
  "network": { "id": "0", "seeds": { "trustedRoot": "5f1d...", "representative": "0b7e...", "user": "c3a8..." }, "representativeWeights": ["400", "300", "300"] },
  "nodes": [ { "representative": 0, "fee": { "type": "flat", "amount": "5" }, "mode": "read-write" } ],
  "steps": [
    { "moment": "2026-01-01T00:00:00.000Z", "actor": 0, "action": { "type": "add", "staple": { "kind": "staple", "bytes": "MIIKazCC..." } }, "expect": { "outcome": "added" } },
    { "moment": "2026-01-01T00:00:00.000Z", "actor": 0, "action": { "type": "quote", "blocks": ["MIHzAgEA..."] }, "expect": { "outcome": "quote", "blocks": ["B8122B5A..."], "fee": { "type": "single", "amount": "5" } } },
    { "moment": "2026-01-01T00:00:00.000Z", "actor": 0, "action": { "type": "vote", "blocks": ["MIHzAgEA..."], "quote": { "fromStep": 1 } }, "expect": { "outcome": "temporary", "blocks": ["B8122B5A..."], "fee": { "type": "single", "amount": "5" } } }
  ]
}
```

- `id`: the catalog ID, or an ID of the corpus's own (section 10).
- `title`: what the case shows, in one sentence.
- `basis`: section 3.1.
- `network`: section 3.2.
- `nodes`: section 3.3. At least one.
- `steps`: section 3.4, run in order.

### 3.1 `basis`

- `"upstream"`: the outcomes follow from `Ledger` and the meaning of the storage interface alone. Any storage that answers each read as the interface means it gives the same outcomes. For this node's expired votes, that meaning bounds when storage stops returning them (section 6.2).
- `"contract"`: an outcome also depends on a choice that `Ledger` leaves to its storage and that `CONTRACT.md` makes. The title names the rule, as in "storage contract D4: ...". Section 5 lists these cases and what each rule decides.

A replay against storage that makes another choice may skip the contract cases, or run them as checks of the named rule.

### 3.2 `network`

```json
{ "id": "0", "seeds": { "trustedRoot": "...", "representative": "...", "user": "..." }, "representativeWeights": ["400", "300", "300"] }
```

- `id` is always `"0"`, the network id every block and node of the case uses.
- `seeds` holds three 32-byte seeds. These are test keys, public by design.
- `representativeWeights` has one positive weight per representative, so its length is the number of representatives.

Section 4.1 derives the keys. Representative i is the delegate of user i, who holds the base-token balance that gives representative i its weight. The weights are established by the genesis staple, which a case that needs them adds in its first step, as bytes. A replay uses only the length of `representativeWeights`; the values record what genesis does.

### 3.3 `nodes`

Each node is one ledger, with its own storage. Nodes share nothing: a node knows only what the case's steps did on it.

```json
{ "representative": 0, "fee": { "type": "free" }, "mode": "read-write", "subnet": "5", "operations": { "setRep": "refuseAll" } }
```

- `representative`: the index of the representative whose key the node holds, so that it votes as that representative. `null` gives a node without a key, which can add staples but never votes or quotes. Two nodes never hold the same representative, so the issuer of a produced vote identifies the node that produced it. Any number of nodes may be `null`. The index is below the number of representatives.
- `fee`: what the node charges for every temporary vote and quote, whatever the blocks.
  - `{"type": "free"}`: nothing.
  - `{"type": "flat", "amount": A, "token"?: T, "payTo"?: P}`: one amount.
  - `{"type": "choices", "choices": [{"amount": A, "token"?: T, "payTo"?: P}, ...]}`: a list of amounts the payer chooses from, in order. The list is never empty.

  An amount without `token` is in the base token, and without `payTo` it is paid to the voting representative. The node's fee computation returns exactly this: nothing, one amount, or the list [Keeta TS] index.js:69707-69710.
- `mode`: the ledger's write mode: `read-write`, `no-voting`, `bootstrap-only` or `read-only`.
- `subnet` (optional): the subnet the node runs on. Without it the node has no subnet, and accepts only blocks without one.
- `operations` (optional, never empty when present):
  - `enableTokenAdminModifyBalance`: `true` admits the TOKEN_ADMIN_MODIFY_BALANCE operation, which is otherwise refused with `LEDGER_OPERATION_NOT_SUPPORTED`.
  - `setRep`: a policy that answers every SET_REP operation alike. `"allowAll"` admits it; `"refuseAll"` refuses it with `LEDGER_INVALID_SET_REP` [Keeta TS] index.js:69961-69968. Without `setRep` every delegation is admitted.

Every other ledger setting keeps upstream's default.

### 3.4 `steps`

```json
{ "moment": "2026-01-01T00:00:00.000Z", "actor": 0, "action": { ... }, "expect": { ... } }
```

- `moment`: the time at which the step runs (section 4.3).
- `actor`: the index of the node that acts, below the number of nodes.
- `action`: section 3.5.
- `expect`: section 3.7. Every step has one, so setup steps are checked too.

Steps are numbered from 0 in the order they appear, and a step may reference only earlier steps.

### 3.5 Actions

| `type` | Fields | Upstream call |
|---|---|---|
| `add` | `staple`, a staple reference; `from` (optional string) | `Ledger.add(staple, from)` [Keeta TS] index.js:69361-69420 |
| `vote` | `blocks`, a list of block bytes; `otherVotes` (optional), a list of vote references; `quote` (optional), a vote reference | `Ledger.vote(blocks, otherVotes, quote)` [Keeta TS] index.js:69012-69355 |
| `quote` | `blocks`, a list of block bytes | `Ledger.quote(blocks)` [Keeta TS] index.js:69356-69360 |
| `gc` | none | `Ledger.gc()` |

- `from` is the source `Ledger.add` is given. A `bootstrap-only` node adds a staple only when it is `"bootstrap"`.
- A `vote` without `otherVotes` differs from one with an empty list: the first asks for a temporary vote, the second for a recovery vote with no supporting weight (section 7.1, step 4).
- The list of blocks may be empty.

No committed case has a `gc` step yet; the action is part of the format.

### 3.6 References

A reference always means bytes. It is one of:

- `{"kind": K, "bytes": B}`: literal bytes of kind K. In `otherVotes` and `quote`, K is `"vote"` or `"quote"`. In `add.staple`, K is `"staple"`.
- `{"fromStep": n}`: the bytes step n offers, with the kind that step implies:
  - a step whose expectation is `temporary` or `permanent` offers the vote it produced, of kind `vote`
  - a step whose expectation is `quote` offers the quote it produced, of kind `quote`
  - an `add` step whose staple is literal offers that staple, of kind `staple`, whatever its outcome

  A reference in `otherVotes` or `quote` names a step that offers a vote or a quote. A reference in `add.staple` names an `add` step with a literal staple, so a staple is always at most one reference away from its bytes.

The kind decides how the bytes are parsed: as a vote, a quote or a staple. A vote reference may resolve to a quote: cases offer quotes among the other votes on purpose, to pin how `Ledger` refuses them (P7).

Bytes are parsed at the moment of the step that references them, not of the step that produced them, as a node parses what a client sends it. The same bytes can therefore parse at one step and fail at a later one (C9, F11).

### 3.7 Expectations

`expect.outcome` is one of:

| Outcome | Fields | Meaning |
|---|---|---|
| `added` | none | `Ledger.add` completed |
| `collected` | none | `Ledger.gc` completed |
| `temporary` | `blocks`, `fee` | `Ledger.vote` returned a temporary vote |
| `permanent` | `blocks`, `fee` | `Ledger.vote` returned a permanent vote |
| `quote` | `blocks`, `fee` | `Ledger.quote` returned a quote |
| `rejectedInput` | `error` | an input of the step did not parse, so the action was never performed |
| `refused` | `error` | the action raised an error |

Each action admits only some outcomes:

| Action | Outcomes |
|---|---|
| `add` | `added`, `refused`, `rejectedInput` |
| `vote` | `temporary`, `permanent`, `refused`, `rejectedInput` |
| `quote` | `quote`, `refused`, `rejectedInput` |
| `gc` | `collected`, `refused` |

For a produced vote or quote:

- `blocks`: the hashes of the blocks it covers, in its order.
- `fee`: the fee it carries:
  - `{"type": "none"}`: no fee at all.
  - `{"type": "single", "amount": A, "token"?: T, "payTo"?: P}`: one amount. `token` and `payTo` appear exactly when the vote states them; an amount whose token is omitted differs from one that names the base token.
  - `{"type": "choices", "choices": [...]}`: a list of amounts, in the vote's order.

An `error` is one of:

- `{"type": "coded", "code": C, "accounts"?: [...], "blockhash"?: H, "existingBlockhash"?: H}`: an error with a Keeta error code. The optional fields appear exactly when upstream attaches them to the error:
  - `accounts`, as `keeta_` strings sorted in code-point order, on `LEDGER_NOT_OPENING` and `LEDGER_NOT_SUCCESSOR`, which carry every account whose head the request checked [Keeta TS] index.js:69260-69276
  - `blockhash` and `existingBlockhash`, together, on `LEDGER_IDEMPOTENT_KEY_EXISTS`: the refused block and the block that holds the key

  The code is a valid Keeta error code and never `LEDGER_OTHER` (section 4.7).
- `{"type": "plain", "message": M}`: an error that upstream raises as a plain `Error`, with no code, matched on its exact message.

The plain messages in the corpus are:

- `Can only insert permanent votes`
- `Cannot add blocks to a read-only ledger`
- `Cannot add blocks to a read-only ledger (except for bootstrapping)`
- `Cannot process block for a different network`
- `Cannot process block for a different subnet`
- `Cannot vote on block, no private key loaded`
- `May not issue votes in read-only mode, in <mode> mode`, for `no-voting`, `bootstrap-only` and `read-only`
- `Operation amount cannot be negative: -1`

## 4. Replay

A replay runs each case on its own, from a fresh start, and checks every step.

### 4.1 Keys

Each key is derived from a seed and an index as Keeta's `Account.fromSeed(seed, index)` derives a secp256k1 key: the private key is the 32-byte output of HKDF-Expand (RFC 5869) with SHA3-256, whose pseudorandom key is the 32-byte seed followed by the index as a 4-byte big-endian integer, and whose info is empty [Keeta TS] index.js:61725-61747, 61887-61892, 62607-62614.

- The trusted root is the key of `seeds.trustedRoot` at index 0. Nodes know only its public key.
- Representative i is the key of `seeds.representative` at index i.
- User i is the key of `seeds.user` at index i.

A replay needs the trusted root's public key and the private keys of the representatives that run nodes. Every other key, the users and the further keys some cases use, such as multisig signers and token issuers, appears only inside bytes or as an account string.

The keys that appear in the corpus, derived from the seeds every case uses, are these, so that a replay can check its own derivation:

| Seed | Index | Public key |
|---|---|---|
| `trustedRoot` | 0 | `keeta_aabyvwulmd2q6qtkkd42b4d63a4xcyckeisuknsvywmmbnkypguljzyla42as5q` |
| `representative` | 0 | `keeta_aab4lhb5eqgtqja6gkjzrbtszwiuyjmnprkwh7b3eo2l5sqgrx7ok5ccggh5r3y` |
| `representative` | 1 | `keeta_aabg37x7rwrmkrv6l5ti2aufbto6nou5hmo55qh2uvrcdbu6u3znbm45zdnfhiq` |
| `representative` | 2 | `keeta_aabtj57rlgydtearubg5vuepsvyjdavevgj4um6zjrqcwtq4xlzataheovnyoai` |
| `representative` | 3 | `keeta_aabxu7phqklvbz3kuewr7h3kdd6pru6lutjnjbh5jlkk3aa6z2e4kuttrta4x7a` |
| `user` | 0 | `keeta_aabx4z7qrrsongdomou3l6vcyuaovnfo6s3wlm4v3vub6zu4xhte5ntk6qifixa` |
| `user` | 1 | `keeta_aabbuacc245m6hsc2rzgykk2hneqcuiizsuxqxelfcmywjbsvslgrtmu57mnh7y` |
| `user` | 2 | `keeta_aab6b2mx7yzhlks2shdxsgqd664ikli7t534tqkoj2axvagw6fla6nygo2fxpia` |
| `user` | 3 | `keeta_aabc3csi43biptqlnuiqip6xgetvdjp2l6xnlxemhavxwqm22apdmyitqd3obfi` |
| `user` | 4 | `keeta_aabkuk7xemxs7s46norwa45empi2o2kzhqegsxpcsq2keg2of5hpajoujknttlq` |
| `user` | 5 | `keeta_aabi6bey4j7mbybtosnx4ftko6ij5blwsg4phtxh6uvbfsysivh6mx3swuxmqea` |

The base token and the network address are the identifiers Keeta derives from network id 0 [Keeta TS] index.js:62632-62639.

### 4.2 Nodes

Before the first step, build each node of `nodes` with empty storage, as a ledger:

- on network 0, with the trusted root as its initial trusted account
- holding the representative's private key and voting as that representative, or, with a `null` representative, holding no key
- with the node's fee policy, write mode, subnet and operation settings (section 3.3)

### 4.3 Running a step

For each step, in order:

1. Set the clock to the step's moment. Every reading of the current time during the step returns it: parsing, the ledger transaction's moment, the block window and the validity of the votes issued. Moments need not increase from one step to the next: C10 and EO6 go back in time, and a node's stored state carries over unchanged.
2. Resolve every reference of the action to bytes and a kind (section 3.6).
3. Parse the inputs (section 4.4). If one fails, the outcome is `rejectedInput` and the action is not performed.
4. Perform the action on the actor's node. If it raises an error, the outcome is `refused`.
5. Observe the outcome and compare it with `expect` (sections 4.6 and 4.7).
6. Keep what the step offers to later references (section 3.6): for an `add` with a literal staple, that staple, whatever the outcome; for a produced vote or quote, its bytes.

A failed comparison is reported, and the case goes on to its next step. A broken step (section 4.8) ends the case.

### 4.4 Parsing

Inputs are parsed in a fixed order, and the first failure decides:

- `vote`: each block in order, then each other vote in order, then the quote
- `quote`: each block in order
- `add`: the staple
- `gc`: nothing

Blocks parse as Keeta blocks, votes as `Vote`, quotes as `VoteQuote`, staples as `VoteStaple`, each at the step's moment. A parse failure is `rejectedInput {error}`, where `error` has exactly the shape of a refusal's. The cases record these parse failures:

- `VOTE_EXPIRED`: a vote or quote more than 60 s past its `validityTo` (C7, C9, F11, EO6)
- `VOTE_MOMENT_BEFORE_VALIDITY_FROM`: a vote whose `validityFrom` is more than 60 s ahead (C10, EO6)
- `VOTE_STAPLE_DUPLICATE_VOTE_ISSUER` and `VOTE_STAPLE_PERMANENCE_MISMATCH`: staples built without validation (Q5, Q9)

EO6 pins the order between other votes and the quote. That order belongs to this format, not to `Ledger`, which receives every input already parsed.

### 4.5 Performing the action

Each action is one call into the actor's ledger (section 3.5), and runs as one ledger transaction. A refused action leaves the node's stored state as it was, and a rejected one never reaches the ledger. Apart from `gc`, only a produced vote, which the node keeps, and an added staple change what later steps observe. Pass `otherVotes` only when the action has it, and an empty list as an empty list. A `gc` step observes only that collection completed: what it reports depends on how storage batches its work.

### 4.6 Checking a produced vote or quote

A replay must check a produced vote or quote by what it means, not by its bytes:

1. Parse its bytes at the step's moment as a `Vote`, or as a `VoteQuote` for a quote. Parsing verifies the signature [Keeta TS] index.js:80558-80563.
2. Its issuer must be the actor's representative.
3. Its block hashes, in order, must equal `expect.blocks`.
4. For a vote, `permanent` or `temporary` must match its permanence as the parse decides it (section 6.1).
5. Its fee must equal `expect.fee`.

The serial number, the signature, the validity bounds and the full bytes are never compared. Serials may differ between implementations, and the signature and bytes depend on the serial. Validity is checked indirectly: later steps parse the produced bytes at their own moments.

A vote that fails to parse, or that another key issued, is a broken step: the implementation produced something that is not a vote by the actor.

### 4.7 Checking an error

- A coded error matches when its code, and each field that `expect.error` carries, are equal, and it carries no other field the format defines. The message and any other field of the error are not compared.
- A plain error matches on its exact message.
- A coded expectation never matches a plain error, nor the other way round.

The corpus records the error `Ledger` raises. A storage layer may wrap an error raised inside a ledger transaction: `Ledger` passes every such error through its storage's `evaluateError` [Keeta TS] index.js:70351. The storage drivers of this repository give an error without a code the code `LEDGER_OTHER` and keep the original as its cause. A replay must compare the original, so `LEDGER_OTHER` never appears in the corpus.

### 4.8 Broken steps

A step is broken when it cannot be judged at all:

- a reference names a step that offered no bytes, because that step failed on this implementation
- a produced vote or quote does not parse, or was issued by another key
- parsing or the action fails with an error that is neither coded nor a plain `Error`, such as a failure of the replay itself

A broken step is a replay failure and ends the case, because the steps after it may reference what it should have produced. It is never an outcome: the corpus records only `rejectedInput` and `refused` errors that are coded or plain.

## 5. Contract cases

`Ledger` keeps all state in its storage, and some of its decisions depend on answers the storage interface leaves open. These cases record answers that `CONTRACT.md` fixes:

| Case | File | Rule | What the rule decides |
|---|---|---|---|
| C11-D4 | `clock.json` | D4 | This node's temporary vote keeps counting until 60 s after its `validityTo`, so a competing request is refused at +6 min and given 1 ms later. Storage that dropped the vote at `validityTo` would give a vote at +6 min. |
| T10 | `permissions.json` | D10 | A SET with no flags is stored as an empty row, and the row overrides the token's default permission. Storage that deleted empty rows would let the default ACCESS admit the send. |
| I3 | `network.json` | D6, D12 | The idempotent keys of the blocks this node voted for count on its side ledger, and `vote` reads them through `'both'`. `Ledger` itself never writes a side claim; storage without one refuses the competitor as `LEDGER_SUCCESSOR_VOTE_EXISTS` instead. |
| I3-D12 | `network.json` | D4, D12 | A side claim counts only while an unexpired vote of this node covers its block, so it refuses another block until 60 s after the vote's `validityTo`. |
| I3c-D12 | `network.json` | D12 | When the main ledger and the side ledger both hold a key, `'both'` answers with the main block, so `existingBlockhash` names it. |

C11 itself is an upstream case: it pins only the bounds that every storage must meet (section 6.2), exactly at `validityTo` (still refused) and 60 s and 1 ms after it (given).

## 6. Upstream behavior the cases pin

These are the decisions an implementation is most likely to get wrong. Each is upstream behavior in 0.18.7, and the cases named pin it.

### 6.1 Permanence is decided when a vote is parsed

A vote is permanent exactly when its `validityTo` lies more than `permanentVoteThreshold` after the moment it is parsed at: 100 * 365 days, 3153600000000 ms, not 100 calendar years [Keeta TS] index.js:80376-80380, 80654. `Ledger` reads this flag, never the vote's encoding. A permanent vote is issued valid until 00:00 UTC on 31 January of the year 1001 years on [Keeta TS] index.js:81524-81529, so for the last 36500 days of its validity it parses as temporary.

C7 shows it: a permanent vote of 2026, valid until 3027-01-31T00:00:00.000Z, still parses at 3027-01-31T00:01:00.000Z, within the slop that follows its validity (section 6.2), but parses as temporary. The request that offers it is then a permanent request without the node's own temporary vote, and is refused `LEDGER_NO_PERM_WITHOUT_SELF_TEMP`. One millisecond later the vote is `VOTE_EXPIRED`.

### 6.2 The parse slop and the expiry of this node's own votes

Parsing accepts a vote from 60 s before its `validityFrom` until 60 s after its `validityTo` [Keeta TS] index.js:80370-80374, 80641-80653, 80676-80679. A temporary vote and a quote are valid for 5 minutes from the moment they are issued [Keeta TS] index.js:70207. So:

- a temporary vote referenced at +6 min still parses, and at +6 min +1 ms is `VOTE_EXPIRED` (C7, F11)
- a vote issued 60 s ahead parses, and 60.001 s ahead is `VOTE_MOMENT_BEFORE_VALIDITY_FROM` (C10)
- `Ledger.vote` checks no expiry of the other votes itself, so votes past their `validityTo` but within the slop still support a permanent vote (C8)

The slop is the parser's. The votes this node stored earlier are a different matter: `Ledger.vote` reads them back from storage to find competing votes [Keeta TS] index.js:69281-69305 and checks no expiry on them, so when they stop counting is the storage's rule. Answering as the storage interface means (section 3.1) bounds that rule on both sides: storage must keep returning this node's temporary vote at least until its `validityTo`, and must stop returning it once the moment is more than 60 s past its `validityTo`, when no node parses it any more. C11 pins those two bounds: the vote still counts at `validityTo`, and no longer 60 s and 1 ms after it. Storage that never expires votes fails C11. Between the bounds the edge is the storage's choice: `CONTRACT.md` D4 places it at the latest the bounds allow, so the vote counts while the moment is at most 60 s past `validityTo`, which C11-D4 and I3-D12 pin (section 5).

### 6.3 Fees

Only a permanent request checks fees [Keeta TS] index.js:69151-69212:

- Each other vote's fee is classified. A vote without a fee owes nothing. A fee with an option of amount 0 is optional, and any other fee is required.
- The fee block is the last block of the request, and only when its purpose is FEE [Keeta TS] index.js:69080. A fee block anywhere else is an ordinary block, so a request whose fee block is not last lacks one (F7b).
- With required fees and no fee block: `LEDGER_MISSING_REQUIRED_FEE_BLOCK` (F1).
- With a fee block, its number of operations must equal the number of required fees, or, when some fees are optional, either that number or the number of required and optional fees together: otherwise `LEDGER_REQUIRED_FEE_MISMATCH` (F3, F9c). The optional fees are checked only when the block pays all of them.
- Each issuer that is owed a fee needs some SEND in the fee block that matches one of its options exactly: to `payTo`, or the issuer when there is none; in `token`, or the base token when there is none; of exactly `amount`. Otherwise `LEDGER_FEE_MISSING` (F4, F4b, F5a, F5b, F9d, F9f). The match is not exclusive: one SEND can serve several issuers, and only the operation count limits the block (E3c). The order of the operations does not matter (F5c).
- A request with a fee block validates the ledger outcome again before the permanent vote (F6, R2). Without one it does not (R1).

When every other vote is temporary, they are compared with the request's blocks without the fee block, so a permanent vote covers one block more than the temporary votes it replaces (F2). A recovery request offers permanent votes, which cover the fee block too (V3c).

Temporary requests never check fees. A temporary vote carries the fee of the quote it was given, or else the node's fee, or, when the node charges nothing, an explicit fee of 0 [Keeta TS] index.js:70219-70227 (P9c, F0, F12). A quote carries the node's fee the same way. A recovery vote carries no fee at all (V3b), and neither does a permanent vote. Since permanent votes never carry a fee, the fee check of a recovery request cannot be observed: V3c's recovery request ends in a fee block that pays nothing to the recovering node, and gets a temporary vote.

### 6.4 In-request permission state only satisfies requirements

A permission requirement is first checked against the grants and default permissions that earlier blocks of the same request set. If one satisfies it, the requirement is met; otherwise it is checked against stored state [Keeta TS] index.js:68032-68078. Earlier blocks can therefore grant what a later block needs (PM4, PM4b, S3b, SI3, T1), but they can never take away what stored state grants:

- T3b: a network default permission narrowed earlier in the same request does not refuse a token creation that the stored default admits. T3 shows the same narrowing refusing once it is stored.
- T10b: an ACL row emptied earlier in the same request does not refuse a send that the stored default admits. T10 shows the stored empty row refusing.

A removal never satisfies a requirement, even though it names the flag (PM6).

### 6.5 The token side of TOKEN_ADMIN_MODIFY_BALANCE

When a node enables it, TOKEN_ADMIN_MODIFY_BALANCE moves the amount between the account and the token's own balance [Keeta TS] index.js:68240-68283. An ADD credits the account and debits the token, so it is refused `LEDGER_INVALID_BALANCE` when the token holds none of itself. A SUBTRACT debits the account and credits the token. OP2 records both on a node with the operation enabled, after showing the default node refusing it as unsupported.

### 6.6 Other behavior

- **Quorum.** A permanent vote needs the issuers of the other votes, and an added staple the issuers of its votes, to weigh at least floor(2 * total / 3) + 1, each issuer counted once [Keeta TS] index.js:69740-69759. Q3 and Q3b pin both sides of the rounding. While the total weight is 0, a vote by the trusted root is required instead, alone or among others (Q10, Q11).
- **Weight moves on add only.** A delegation that is voted on but not added changes no weight (Q15, Q16).
- **Adding checks no outcome.** `Ledger.add` checks votes, network, subnet and weight, but no balance or permission: an overspending staple with enough weight is added (Q14).
- **Quotes check less than votes.** A quote checks the blocks and the ledger outcome, but no stored idempotent key, head or competing vote (QT1, QT1b, QT1c). It has no check for an empty list of blocks (V6c).
- **Certificates come from storage.** A certificate an ACL names must already be stored; one stored by an earlier block of the same request is not found (CE3b).
- **The storage base refuses duplicates.** Adding a staple whose block is already stored is refused `LEDGER_BLOCK_ALREADY_EXISTS` by the storage base class that Keeta ships [Keeta TS] index.js:67682-67688 (K7).
- **Permissions are pinned by code.** `LEDGER_INVALID_PERMISSIONS` carries no field that names the failed requirement, so a case matches any refusal with that code. Where the cause matters, a second step of the case shows it, such as the request that succeeds once the missing grant exists (PM5, PM6, S4, SI3, CE4, CE5, T3, T5, R2).

## 7. Evaluation order

When a request fails several checks, the first check decides the outcome. The order cases (EO1 to EO31) each put two failing conditions in one request, so an implementation that checks them in another order reports the other refusal.

### 7.1 `Ledger.vote`

[Keeta TS] index.js:69012-69355, with the issuing of temporary votes at 70171-70230:

1. **Blocks.** An empty list, or a fee block first: `LEDGER_MISSING_BLOCKS`.
2. **Key.** A node without a key: plain `Cannot vote on block, no private key loaded`.
3. **Mode.** Any mode but `read-write`: plain `May not issue votes in read-only mode, in <mode> mode`.
4. **Kind.** Without `otherVotes`, the request is for a temporary vote. With `otherVotes` that include a temporary vote, it is for a permanent vote. With `otherVotes` that are all permanent, the empty list included, it is a recovery request: a temporary vote issued without the block window and without a fee.
5. **Quote.** A quote with a permanent request: `LEDGER_VOTE_WITH_QUOTE`. A quote issued by another key, or on another number of blocks, or on other blocks: `LEDGER_QUOTE_MISMATCH`.
6. **Each other vote, in order.** A quote: `LEDGER_VOTE_WITH_QUOTE`. The same vote twice: `LEDGER_DUPLICATE_VOTE_FOUND`. A second vote of one issuer: `LEDGER_DUPLICATE_VOTE_ISSUER_FOUND`. In a permanent request, this node's own permanent vote: `LEDGER_CANNOT_EXCHANGE_PERM_VOTE`. Other blocks than the request's (section 6.3 for the fee block): `LEDGER_BLOCKS_DIFFER_FROM_VOTED_ON`.
7. **Fees or self.** A permanent request checks fees (section 6.3). A recovery request that includes a vote of this node: `LEDGER_TEMP_VOTE_INCLUDES_SELF`.
8. **Recovery weight.** Other votes that weigh no more than a quarter of the total weight, rounded down: `LEDGER_INSUFFICIENT_VOTING_WEIGHT`.
9. **Own vote.** A permanent request without a vote of this node among the other votes: `LEDGER_NO_PERM_WITHOUT_SELF_TEMP`.
10. **Each block, in order.** A second fee block: `LEDGER_MULTIPLE_FEE_BLOCK`. Another network: `LEDGER_INVALID_NETWORK`. Another subnet: `LEDGER_INVALID_SUBNET`. An idempotent key that an earlier block of the request has for the same account: `LEDGER_IDEMPOTENT_KEY_EXISTS`. A previous that an earlier block used: `LEDGER_PREVIOUS_ALREADY_USED`. A previous that is a block of the request on another account: `LEDGER_INVALID_CHAIN`; one that comes later in the request: `LEDGER_PREVIOUS_NOT_SEEN`. A block whose previous is not in the request has its account's head checked in step 12.
11. **Stored idempotent keys.** A block whose key another block holds, on the main ledger or on this node's side ledger: `LEDGER_IDEMPOTENT_KEY_EXISTS`. The block's own hash is excluded, so a permanent vote can follow the temporary vote that claimed the key (I3b, I6).
12. **Heads, per account in request order.** An account without blocks and a block that is not opening: `LEDGER_NOT_OPENING`. An account with blocks and an opening block: `LEDGER_NOT_EMPTY`. A previous that is not the head: `LEDGER_NOT_SUCCESSOR`.
13. **Competing votes.** A vote of this node on any block with the same previous as a requested block, the block itself included: `LEDGER_SUCCESSOR_VOTE_EXISTS`. A permanent request may replace exactly one such vote when it is this node's temporary vote (K1f).
14. **Issuing.**
    - Temporary and recovery: mode and key again; the ledger outcome (section 7.2); then, for a temporary request only, the block window: a block dated more than 5 minutes before or after the moment is `LEDGER_BLOCK_EXPIRED` [Keeta TS] index.js:70185-70198.
    - Permanent: the ledger outcome only when the request ends in a fee block; then the quorum (section 6.6): `LEDGER_INSUFFICIENT_VOTING_WEIGHT`.

### 7.2 The ledger outcome, `Ledger.quote` and `Ledger.add`

**The ledger outcome** [Keeta TS] index.js:69989-70095:

1. Operations: a negative amount in a block dated before 2025-11-21, plain `Operation amount cannot be negative: <amount>`; a SET_REP the node's policy refuses, `LEDGER_INVALID_SET_REP`; TOKEN_ADMIN_MODIFY_BALANCE on a node that does not enable it, `LEDGER_OPERATION_NOT_SUPPORTED`.
2. Permission requirements: `LEDGER_INVALID_PERMISSIONS`.
3. Owner count: every token or other identifier whose owners changed keeps exactly one owner, or `LEDGER_INVALID_OWNER_COUNT`.
4. The effect of the blocks: a certificate that an ACL names must be stored (`LEDGER_CERTIFICATE_NOT_FOUND`), and a supply must stay within its maximum (`BLOCK_SUPPLY_INVALID`). Both come before any balance is judged. Within one block the supply is judged first, whatever the order of the operations (EO18).
5. Balances: one that falls negative at any point, `LEDGER_INVALID_BALANCE`, before a receive that was not met, `LEDGER_RECEIVE_NOT_MET`. Blocks apply in request order, so a spend before its funding fails (B4), and a receive counts only what earlier blocks sent (B6c).

**`Ledger.quote`** runs step 10, then the issuing of a temporary vote: mode, key, ledger outcome, block window, fee [Keeta TS] index.js:69356-69360, 70171-70230.

**`Ledger.add`** [Keeta TS] index.js:69361-69420: the mode (`read-only` refuses every staple, `bootstrap-only` every one not added from `"bootstrap"`); each block's network and subnet, as plain errors; each vote's `validityFrom`, which must not be before 1970 (`LEDGER_INVALID_DATE`), and its permanence (plain `Can only insert permanent votes`); the quorum; then the storage.

### 7.3 The order cases

Step numbers refer to section 7.1.

| Case | File | Conditions | Recorded | Pins |
|---|---|---|---|---|
| EO1 | `quorum.json` | recovery request with only this node's own permanent vote, weighing exactly a quarter | `LEDGER_TEMP_VOTE_INCLUDES_SELF` | step 7 before step 8 |
| EO2 | `quorum.json` | permanent request at 60% weight, on a block already added | `LEDGER_NOT_SUCCESSOR` | step 12 before the quorum |
| EO3 | `clock.json` | a block 6 minutes old: a bare request, then a permanent request with only other nodes' temporary votes | `LEDGER_BLOCK_EXPIRED`, then `LEDGER_NO_PERM_WITHOUT_SELF_TEMP` | step 9 is checked, and the block window never is, on the permanent path |
| EO4 | `clock.json` | a stale block that overspends | `LEDGER_INVALID_BALANCE` | the ledger outcome before the block window |
| EO5 | `clock.json` | a stale block whose sibling holds this node's permanent vote | `LEDGER_SUCCESSOR_VOTE_EXISTS` | step 13 before step 14 |
| EO6 | `clock.json` | an expired quote; then the same quote with another vote issued too far ahead | `rejectedInput` `VOTE_EXPIRED`, then `VOTE_MOMENT_BEFORE_VALIDITY_FROM` | the format's parse order: other votes before the quote (section 4.4) |
| EO7 | `conflicts.json` | an empty list of other votes and no blocks | `LEDGER_MISSING_BLOCKS` | step 1 before step 8 |
| EO8 | `conflicts.json` | an empty list of other votes, on a block already added | `LEDGER_INSUFFICIENT_VOTING_WEIGHT` | step 8 before step 12 |
| EO9 | `conflicts.json` | two blocks sharing a previous that is not the head | `LEDGER_PREVIOUS_ALREADY_USED` | step 10 before step 12 |
| EO10 | `conflicts.json` | an overspending competitor of a block this node voted for | `LEDGER_SUCCESSOR_VOTE_EXISTS` | step 13 before the ledger outcome |
| EO11 | `conflicts.json` | a block after a stale previous and an unopened account's block, then in reverse | `LEDGER_NOT_SUCCESSOR`, then `LEDGER_NOT_OPENING`, both naming both accounts | heads are checked in request order |
| EO12 | `permissions.json` | an unsupported operation, then a negative amount, each signed by a key without rights | `LEDGER_OPERATION_NOT_SUPPORTED`, then plain `Operation amount cannot be negative: -1` | operations before permissions |
| EO13 | `permissions.json` | a second owner, added by a key without rights | `LEDGER_INVALID_PERMISSIONS` | permissions before the owner count |
| EO14 | `permissions.json` | an overspend, then a second owner | `LEDGER_INVALID_OWNER_COUNT` | the owner count before balances, though the overspend comes first |
| EO15 | `permissions.json` | an overspend and an ACL for a certificate nobody holds | `LEDGER_CERTIFICATE_NOT_FOUND` | certificates before balances |
| EO16 | `balances.json` | an overspend and a mint past the maximum supply | `BLOCK_SUPPLY_INVALID` | the supply before balances |
| EO17 | `balances.json` | a receive that is not met and an overspend, on one account | `LEDGER_INVALID_BALANCE` | a negative balance before an unmet receive |
| EO18 | `permissions.json` | one token block: an ACL for a certificate nobody holds, then a mint past the maximum supply | `BLOCK_SUPPLY_INVALID` | within a block, the supply before the certificate |
| EO19 | `fees.json` | permanent request without this node's temporary vote and without the fee block its votes require | `LEDGER_MISSING_REQUIRED_FEE_BLOCK` | step 7 before step 9 |
| EO20 | `fees.json` | a fee one short, paid by an account that cannot afford its send and the fees | `LEDGER_FEE_MISSING` | the fee check before the ledger outcome |
| EO21 | `network.json` | a second fee block, on another network | `LEDGER_MULTIPLE_FEE_BLOCK` | within a block, the fee block before the network |
| EO22 | `network.json` | another network and another subnet | `LEDGER_INVALID_NETWORK` | network before subnet |
| EO23 | `network.json` | a key repeated in the request, on a block with a subnet | `LEDGER_INVALID_SUBNET` | subnet before the repeated key |
| EO24 | `network.json` | a key repeated in the request, on a block reusing a previous | `LEDGER_IDEMPOTENT_KEY_EXISTS` | the repeated key before the reused previous |
| EO25 | `network.json` | a block with a stored key, then a block of another network | `LEDGER_INVALID_NETWORK` | every block passes step 10 before step 11 |
| EO26 | `network.json` | a block with a stored key that is not the successor | `LEDGER_IDEMPOTENT_KEY_EXISTS` | step 11 before step 12 |
| EO27 | `modes.json` | a `no-voting` node: no blocks, then a fee block first | `LEDGER_MISSING_BLOCKS`, twice | step 1 before step 3 |
| EO28 | `modes.json` | a `no-voting` node without a key: a vote, then a quote | plain key error, then plain mode error | a vote checks the key first, a quote the mode |
| EO29 | `modes.json` | a `no-voting` node: a quote of a block of another network, then of a valid block | `LEDGER_INVALID_NETWORK`, then plain mode error | a quote checks the blocks before the mode |
| EO30 | `modes.json` | a staple of another network, added from `"bootstrap"` on a `read-only` and on a `bootstrap-only` node | plain mode error, then plain network error | `add` checks the mode before the network |
| EO31 | `network.json` | a successor of a published block, carrying its idempotent key, while this node voted for a competing successor | `LEDGER_IDEMPOTENT_KEY_EXISTS`, naming the published block | step 11 before step 13, with no side claim involved |

Other cases also pin an order: P1 pins step 9 before the quorum, K1e step 12 before step 13, Q13 the date before the weight in `Ledger.add`, and B8 the ledger outcome before the block window.

## 8. Generation

The cases are generated, never edited. `src/conformance/scenarios/<group>.ts` describe each situation, and `make conformance` records the outcomes into the committed files:

- Each step's action is first encoded into its case form. The encoded data is then run through the same replay code that checks the corpus, and whatever it produces becomes the expectation. A case can only record what its own data reproduces.
- The clock is frozen at each step's moment, the keys come from the fixed seeds, and every case starts at 2026-01-01T00:00:00.000Z, so generation is deterministic.
- `make test` checks that the committed files equal a fresh generation, that two generations are identical, that each file is valid under the schema and decodes and encodes back to the same bytes, and that every case replays on every storage driver of this repository.

The ledger is Keeta's, but the storage under it during generation is this repository's reference driver, `MemoryLedgerStorage`, which implements `CONTRACT.md`. Every decision `Ledger` makes reads state through that storage. This is what `basis` records: an `upstream` case was checked to hold for any storage that answers as the storage interface means, and a `contract` case depends on a rule of `CONTRACT.md`, named in its title (section 5).

## 9. Upstream version

The corpus pins `@keetanetwork/keetanet-client` 0.18.7, the version in `package.json`, and every file's `keetanetClient` field names it. When the dependency changes, `make test` fails until `make conformance` regenerates the corpus, and the changed decisions show up as a reviewable diff of the files.

## 10. Catalog coverage

Every row of the catalog is a case, an exclusion, or both:

- A row that combines situations, such as C1/C3, has one case per ID.
- A row that the public API can reach only in part is split: a case with the row's ID carries the reachable part, and the other part is excluded (B8, T6, I5). F8 is excluded whole.
- An exclusion is a block that Keeta's block builder and block parser refuse alike. A node only ever parses what a client sends, so such a block reaches a node only as bytes encoded and signed by hand, and is rejected before any ledger decision.
- The IDs T9, S1 and MS5 are not used: the catalog mentions them without defining a situation.

`src/conformance/catalog.ts` lists the catalog's IDs and the corpus's own, and a test checks this section's claims against the committed files: every catalog ID is a case or an exclusion; every case is a catalog ID or a declared extra; an excluded row has no case, and an excluded part shares its ID with the case that carries the rest. Another test holds this document's tables to the committed files: the case counts of section 1, the statement of section 3.5 that no case has a `gc` step, the plain messages of section 3.7, the keys of section 4.1, derived again from the seeds, the contract cases of section 5, and the case IDs and files of sections 7.3, 10.1 and 10.2.

### 10.1 Catalog rows

#### Kind selection and the recovery vote

| Row | Cases | File | Notes |
|---|---|---|---|
| V1 | V1 | `kind.json` | |
| V2 | V2 | `kind.json` | |
| V3 | V3 | `kind.json` | The refused bare request is a step of the case. |
| V3b | V3b | `kind.json` | |
| V3c | V3c | `kind.json` | |
| V4 | V4 | `kind.json` | |
| V4b | V4b | `kind.json` | |
| V5 | V5 | `kind.json` | |
| V6 | V6 | `kind.json` | |
| V6b | V6b | `kind.json` | |
| V6c | V6c | `kind.json` | |
| P1 | P1 | `kind.json` | |
| P2 | P2 | `kind.json` | |
| P3 | P3 | `kind.json` | |
| P4 | P4 | `kind.json` | |
| P5 | P5 | `kind.json` | |
| P6 | P6 | `kind.json` | |
| P7 | P7 | `kind.json` | |
| P8 | P8 | `kind.json` | |
| P9 | P9 | `kind.json` | The three mismatches are steps of one case. |
| P9c | P9c | `kind.json` | |

#### Quorum

| Row | Cases | File | Notes |
|---|---|---|---|
| Q1 | Q1 | `quorum.json` | |
| Q2 | Q2 | `quorum.json` | |
| Q3 | Q3 | `quorum.json` | |
| Q3b | Q3b | `quorum.json` | Weights 21/1/10, so one network shows both sides of the rounding: 21 is refused, 22 given. |
| Q5 | Q5 | `quorum.json` | The staple is built without validation, so the node rejects it when it parses the bytes (`rejectedInput`). |
| Q6 | Q6 | `quorum.json` | |
| Q7 | Q7 | `quorum.json` | |
| Q8 | Q8 | `quorum.json` | |
| Q9 | Q9 | `quorum.json` | As Q5. |
| Q10 | Q10 | `quorum.json` | A last step shows that the trusted root's vote among others also suffices. |
| Q11 | Q11 | `quorum.json` | |
| Q12 | Q12 | `quorum.json` | |
| Q13 | Q13 | `quorum.json` | Also pins the epoch boundary, and that the date is checked before the weight. |
| Q14 | Q14 | `quorum.json` | A later balance read is not a step; votes on the block and on the account's next block are refused `LEDGER_INVALID_BALANCE` instead. |
| Q15/Q16 | Q15, Q16 | `quorum.json` | One case each. |

#### Clock window

| Row | Cases | File | Notes |
|---|---|---|---|
| C1/C3 | C1, C3 | `clock.json` | One case each. |
| C2/C4 | C2, C4 | `clock.json` | One case each. |
| C5 | C5 | `clock.json` | References parse only within the slop, so the temporary votes are from +4 min and the permanent request at +9 min, not an hour later. |
| C6 | C6 | `clock.json` | Pinned at the boundary: exactly 5 min is quoted, 1 ms more refused. |
| C7 | C7 | `clock.json` | Each validity edge is shown by parsing the vote there; see section 6.1. |
| C8 | C8 | `clock.json` | Adapted: a 7-minute-old vote cannot be passed as bytes. At +6 min, other votes past their validity but within the slop give a permanent vote, which shows that `Ledger.vote` checks no expiry itself. |
| C9 | C9 | `clock.json` | |
| C10 | C10 | `clock.json` | Pinned at the boundary: +60 s parses, +60.001 s does not. |
| C11 | C11 | `clock.json` | Pins only the bounds that every storage must meet (section 6.2); C11-D4 pins the contract's edge between them. |
| CE5 | CE5 | `permissions.json` | Kept with the other certificate cases. A holder whose certificate is still valid is admitted at the same moment. |

#### Conflicts

| Row | Cases | File | Notes |
|---|---|---|---|
| K1 | K1 | `conflicts.json` | |
| K1b | K1b | `conflicts.json` | |
| K1c | K1c | `conflicts.json` | |
| K1d | K1d | `conflicts.json` | |
| K1f | K1f | `conflicts.json` | |
| K2 | K2 | `conflicts.json` | |
| K3 | K3 | `conflicts.json` | |
| K1e/K8 | K1e, K8 | `conflicts.json` | K1e votes on a competitor of the added block, K8 on the added block itself. |
| K4 | K4 | `conflicts.json` | |
| K5 | K5 | `conflicts.json` | `LEDGER_NOT_EMPTY` carries no accounts. |
| K5b | K5b | `conflicts.json` | |
| K6 | K6 | `conflicts.json` | |
| K6b | K6b | `conflicts.json` | |
| K6c | K6c | `conflicts.json` | |
| K7 | K7 | `conflicts.json` | Raised by the storage base class that Keeta ships, before any driver write [Keeta TS] index.js:67682-67688. |

#### Balances and supply

| Row | Cases | File | Notes |
|---|---|---|---|
| B1/B2 | B1, B2 | `balances.json` | One case each. |
| B3 | B3 | `balances.json` | |
| B4 | B4 | `balances.json` | |
| B5 | B5 | `balances.json` | |
| B6 | B6 | `balances.json` | |
| B6b | B6b | `balances.json` | |
| B7 | B7 | `balances.json` | |
| B8 | B8 | `balances.json` | Split. Case: a negative amount in a block dated before 2025-11-21, refused by the ledger's operation check. Excluded: the construction half; such a block dated later fails `BLOCK_AMOUNT_BELOW_ZERO` in the builder and the parser alike [Keeta TS] index.js:67139-67148. |
| T5 | T5 | `balances.json` | |
| T6/T7 | T6, T7 | `balances.json` | Split. T6 is the supply growing past the maximum across blocks. Excluded: one operation above the maximum, which the builder and the parser refuse with `BLOCK_SUPPLY_INVALID` [Keeta TS] index.js:67133-67138. |

#### Permissions

| Row | Cases | File | Notes |
|---|---|---|---|
| PM1 | PM1 | `permissions.json` | |
| PM2 | PM2 | `permissions.json` | |
| PM3 | PM3 | `permissions.json` | |
| PM4 | PM4 | `permissions.json` | |
| PM5 | PM5 | `permissions.json` | |
| PM6 | PM6 | `permissions.json` | The victim's own block removes the signer's SEND_ON_BEHALF, then the signer signs the victim's send. The removal matches the requirement in everything but its method, so only the rule that a SUBTRACT never satisfies a requirement decides the case. |
| S4 | S4 | `permissions.json` | Also refused with only STORAGE_CAN_HOLD granted. |
| S2/S3/S3b | S2, S3, S3b | `permissions.json` | One case each. |
| T1 | T1 | `permissions.json` | Reads the info of a token that has no stored row yet. |
| T2/T3/T4 | T2, T3, T4 | `permissions.json` | One case each. |
| T8/T10 | T8, T10 | `permissions.json` | T10 is a contract case (D10). |
| SI3 | SI3 | `permissions.json` | |
| MS1-MS4 | MS1, MS2, MS3, MS4 | `permissions.json` | One case each. |
| O1-O4 | O1, O2, O3, O4 | `permissions.json` | O3 adds UPDATE_INFO: ADMIN may only be SET, and the builder refuses an ADD of it with `BLOCK_NO_DELEGATE_ADMIN` [Keeta TS] index.js:65551-65553. An update whose flags lack OWNER counts as removing the owner [Keeta TS] index.js:70050-70053. |
| CE3 | CE3 | `permissions.json` | |
| CE4 | CE4 | `permissions.json` | Both outcomes are steps of one case. |
| OP1/OP2 | OP1, OP2 | `permissions.json` | With the operation enabled, an owner-signed ADD is still refused, `LEDGER_INVALID_BALANCE`, because it debits the token (section 6.5); a SUBTRACT gets a temporary vote. |
| OP3/OP4 | OP3, OP4 | `permissions.json` | OP3 uses the constant `setRep` policies of section 3.3. |
| TR1/TR2 | TR1, TR2 | `permissions.json` | One case each. |
| R1/R2 | R1, R2 | `permissions.json` | R2 also shows a node that never saw the change giving a permanent vote. |

#### Fees

| Row | Cases | File | Notes |
|---|---|---|---|
| F0 | F0 | `fees.json` | |
| F1 | F1 | `fees.json` | |
| F2 | F2 | `fees.json` | |
| F3 | F3 | `fees.json` | |
| F4/F4b | F4, F4b | `fees.json` | One case each. |
| F5a/F5b | F5a, F5b | `fees.json` | One case each. |
| F5c | F5c | `fees.json` | |
| F6 | F6 | `fees.json` | |
| F7 | F7 | `fees.json` | Both outcomes are steps of one case. |
| F8 | excluded | - | Excluded: a fee block with an operation other than SEND fails `BLOCK_INVALID_PURPOSE_VALIDATION` in the builder and the parser alike [Keeta TS] index.js:63993-63996. |
| F9/F9b | F9, F9b | `fees.json` | The row's third and fourth outcomes are F9c and F9d. |
| F10 | F10 | `fees.json` | The mixed payment is F10b. |
| E3 | E3 | `fees.json` | The payment to the voters is E3b. |
| F11/F12 | F11, F12 | `fees.json` | F12's quote is literal bytes signed by the same key on a ledger charging 9, while the node charges 5. |
| F13 | F13 | `fees.json` | |
| QT1 | QT1 | `fees.json` | The stale block. The block with a stored key is QT1b. |

#### Network, subnet and idempotent keys

| Row | Cases | File | Notes |
|---|---|---|---|
| N1/N6 | N1, N6 | `network.json` | One case each. |
| N2 | N2 | `network.json` | |
| N3/N5 | N3, N5 | `network.json` | One case each. |
| N4 | N4 | `network.json` | |
| I1 | I1 | `network.json` | |
| I2 | I2 | `network.json` | |
| I3 | I3 | `network.json` | A contract case (D6, D12). |
| I3b | I3b | `network.json` | |
| I4 | I4 | `network.json` | |
| I5 | I5 | `network.json` | Split. Case: a key of exactly 36 bytes. Excluded: a 37-byte key, which the builder and the parser refuse with `BLOCK_INVALID_IDEMPOTENT_LENGTH` [Keeta TS] index.js:63362-63367, 64046-64051. |
| I6 | I6 | `network.json` | |

### 10.2 Extras

Cases with IDs of the corpus's own. The catalog numbers neither its evaluation order nor its write-mode rows, so the order cases are EO1 to EO31 (section 7.3) and the write-mode cases W1 to W5:

| Case | File | Shows |
|---|---|---|
| W1 | `modes.json` | a `read-write` node adds, votes and quotes |
| W2 | `modes.json` | a `no-voting` node adds, and refuses to vote or quote |
| W3 | `modes.json` | a `bootstrap-only` node adds only from `"bootstrap"`, and refuses to vote or quote |
| W4 | `modes.json` | a `read-only` node adds nothing, even from `"bootstrap"`, and refuses to vote or quote |
| W5 | `modes.json` | a node without a key adds, and refuses to vote or quote |

The other extras extend a catalog row:

| Case | File | Row | Shows |
|---|---|---|---|
| C11-D4 | `clock.json` | C11 | contract D4: the edge of this node's vote expiry (section 5) |
| B6c | `balances.json` | B6 | a receive counts only what earlier blocks of the request sent |
| PM2b | `permissions.json` | PM2 | SEND_ON_BEHALF granted without a target covers a send of the base token |
| PM4b | `permissions.json` | PM4 | the same grant, earlier in the same request |
| S2b | `permissions.json` | S2 | STORAGE_CAN_HOLD alone does not admit a deposit |
| S2c | `permissions.json` | S2 | STORAGE_DEPOSIT alone does not admit a deposit |
| T3b | `permissions.json` | T3 | a network default narrowed earlier in the request refuses nothing (section 6.4) |
| T10b | `permissions.json` | T10 | an ACL row emptied earlier in the request refuses nothing (section 6.4) |
| CE3b | `permissions.json` | CE3 | a certificate stored earlier in the same request is not found |
| F7b | `fees.json` | F7 | a fee block that is not the last block is an ordinary block |
| F9c | `fees.json` | F9/F9b | optional fees paid to only some representatives are refused |
| F9d | `fees.json` | F9/F9b | optional fees in an amount no option names are refused |
| F9e | `fees.json` | F9 | with one free node, paying only the required fees is enough |
| F9f | `fees.json` | F9 | a payment to the free node must match its zero fee |
| F10b | `fees.json` | F10 | fees in two tokens, paid in either token per representative |
| E3b | `fees.json` | E3 | fees with a payee, paid to the voters instead, are refused |
| E3c | `fees.json` | E3 | one SEND to the payee serves every vote (section 6.3) |
| QT1b | `fees.json` | QT1 | a quote on a block whose idempotent key a published block holds |
| QT1c | `fees.json` | QT1 | a quote on a competitor of a block this node voted for |
| N2b | `network.json` | N2 | a node on a subnet refuses to add blocks without one |
| I3-D12 | `network.json` | I3 | contract D4 and D12: the edge of a side claim's expiry (section 5) |
| I3c-D12 | `network.json` | I3 | contract D12: the main claim is reported over the side claim (section 5) |
