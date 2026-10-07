# Mainnet fixtures

`conformance/mainnet/` holds vote staples that the Keeta mainnet confirmed, as captured bytes. They are the input for replaying real history against a node implementation. This document states where they come from, how they were captured, their format and what is in them, so that anyone can check or reproduce the files.

## Conventions

- `[Keeta TS] index.js:N` is line N of `client/index.js` in the published `@keetanetwork/keetanet-client` 0.18.7 package.
- `[Keeta TS 0.18.4] index.js:N` is line N of the same file in the published 0.18.4 package.
- A staple is a `VoteStaple`: the votes of a quorum of representatives together with the blocks they confirm.

## 1. Files

| File | Staples | Blocks | Staple timestamps (UTC) | sha256 |
|---|---|---|---|---|
| `mainnet/head.jsonl.gz` | 2,037 | 4,327 | 2025-09-23T03:43:49.428Z to 2025-09-23T14:34:14.783Z | `c1ad7bbad0ff33217c0744ba4d279aeb913fa2125bb07b2b9f76afcc060a20a4` |
| `mainnet/edge-cases.jsonl.gz` | 90 | 180 | 2025-12-18T03:53:15.912Z to 2026-05-03T07:16:55.308Z | `6cc7e7ddd2d633ebde90f33f399275a6a7268cd13c263452c7ea022b12f58db1` |

The hashes are of the compressed files as committed. Every staple is distinct, within each file and between them. A staple's timestamp is `VoteStaple.timestamp()`, the average of its votes' `validityFrom` moments [Keeta TS] index.js:81061-81087.

## 2. Source

Both files are public chain data. Every staple in them is a confirmed mainnet staple that any representative serves to anyone who asks, and nothing in them is private or was obtained other than through that public interface.

The head file was read from the bootstrap endpoint of one representative, `https://rep1.main.network.api.keeta.com/api/node/bootstrap/votes`. It is the endpoint that Keeta's client calls as `GET /node/bootstrap/votes` to fetch the staples a representative's ledger has confirmed since a moment [Keeta TS] index.js:59139-59183. The network is mainnet, network `0x5382` [Keeta TS] index.js:61293-61298.

The head file holds the first staples of the chain from the epoch, all within 2025-09-23. The files do not record when they were captured: the gzip header of each carries a zero modification time, so a capture is known only to be later than the latest staple it holds.

The edge-case file holds staples from later in the chain, which a node that replays only the head does not reach. They were taken from a full backfill of mainnet by an independent Rust decoder: it first rejected these 90 although mainnet had confirmed them. The rejected inputs were of two kinds:

- sends to a recipient whose public key bytes are not a point on the curve: 33 zero bytes, or `02` followed by 32 zero bytes
- blocks of the all-zero Ed25519 account, signed with an all-zero signature

A replay that decodes and verifies every staple, as Keeta's `Vote.Staple` does, must accept all of them.

## 3. Capture

`utils/capture-mainnet-head` writes a head file. It uses only the Python standard library and makes HTTP GET requests, one page at a time, and nothing else: it never publishes a block or a vote and never sends a peer-to-peer message, so the capturing machine does not announce itself to the network.

1. The first request asks for `start=1970-01-01T00:00:00.000Z`, that is, from before the epoch, with `limit=1000`.
2. Each staple is kept the first time its `$binary` is seen, so the output has no duplicates.
3. The next request starts 5 minutes before the latest `validityFrom` of any vote in the page. The bootstrap endpoint pages by vote moment, so staples at a page boundary can share a moment with ones not yet returned, and a cursor that began exactly at the latest moment would skip them. The overlap makes the next page repeat some staples, and the deduplication in step 2 absorbs the repeats. The client documents the same situation: a `moment` that overlaps the last page, a bloom filter for excluding staples already sent, and an empty page as the end [Keeta TS] index.js:59139-59164. The capture deduplicates on its side and sends no filter.
4. Capture stops when at least 2,000 distinct staples are held. Pages are whole, so the count passes the target: this capture ended at 2,037.
5. The output is gzip with a zero modification time, so its header does not carry the time of the capture.

A page that is empty before the target, or a cursor that does not advance, ends the capture with an error instead of looping or writing a short file.

The file records one capture. A later capture can differ in the order and in the count of its staples, because it stops at the first page that reaches the target and the order within a page is the endpoint's. Its staples are still staples of the same chain.

## 4. Format

Each file is gzip-compressed text with one staple per line, each line ending in a line feed. A line is the base64 (RFC 4648, with padding) of the staple's compressed bytes: the DER encoding of the staple, deflated with zlib [Keeta TS] index.js:81016-81030. This is the `$binary` field of a staple in the bootstrap response. `new lib.Vote.Staple(Buffer.from(line, 'base64'))` parses it, and a staple constructor inflates input that carries a zlib header [Keeta TS] index.js:80968-80990.

## 5. Replay

The order of the lines is not causal. The head file is in the order the capture received staples, which is in page order and, within a page, not in staple order: in the head file 745 staples are older than the one before them. A replay must therefore sort the staples itself, by `VoteStaple.timestamp()`, oldest first, with equal timestamps ordered by `blocksHash`. No two staples of either file share a timestamp, so the tie-break only makes the order total for other captures. With that order every staple of the head file is added to a ledger without any staple waiting for a previous block.

The network settings of a mainnet ledger are:

| Setting | Value |
|---|---|
| network | `0x5382` |
| initial trusted account | `keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa` [Keeta TS] index.js:61377 |
| base token and network address | derived from the network by `Account.generateBaseAddresses` |

The edge-case staples follow the head chronologically but not directly: the blocks they extend are not in the head file, so a ledger that holds only the head defers almost all of them (section 7).

## 6. Shadow votes

A representative that follows mainnet is also asked to vote on what it follows. Before each staple of the head is added, the replay's representative ledger is asked for a vote on the staple's blocks, `Ledger.vote(staple.blocks)`, with the clock at the staple's timestamp. A vote it gives is a temporary vote over exactly those blocks. Adding the staple next confirms the same blocks, which removes the vote's side-ledger write.

The 0.18.7 ledger refuses 466 of the 2,037 staples, every one with `LEDGER_INVALID_PERMISSIONS`. `mainnet/shadow-vote-exceptions.json` lists each refused staple by blocks hash, with its reason, the error code and the refused requirement: its principal, entity, target when it has one, and its base flags and external offsets. A refusal is assigned a reason from the requirement it names: the refusal message gives the principal, entity, target and flags of the first requirement not met [Keeta TS] index.js:69873-69879, and that requirement is found among those `computeEffectOfBlocks` records for the staple. A refusal that no reason explains, or that more than one explains, is a failure, not an exception.

| Reason | Staples |
|---|---|
| `self-requirement-return` | 465 |
| `same-staple-grant-scope` | 0 |
| `trusted-account-genesis` | 1 |

Two of the reasons are permission fixes between 0.18.4 and 0.18.7. Rewriting either fix in the 0.18.7 bundle back to its 0.18.4 form, and replaying again, removes exactly that reason's staples from the refusals; with both rewritten, only the genesis staple is refused. The staples the fixes explain were therefore voted under 0.18.4's rules, which accept them.

### 6.1 `self-requirement-return`

The permission requirements of an operation are computed as a list, and a requirement whose entity is its own principal, an account acting on itself, needs no check. At such a requirement 0.18.4 returns from the whole list [Keeta TS 0.18.4] index.js:68490-68492, so the requirements after it are never recorded. 0.18.7 skips only that requirement [Keeta TS] index.js:68646-68648.

A `SEND` lists, in order, the sender's `ACCESS` on the token and the recipient's `ACCESS` on the token. When the recipient is a storage account, it then lists the token's `STORAGE_CAN_HOLD` on the storage account and the sender's `STORAGE_DEPOSIT` on it for the token [Keeta TS] index.js:68461-68492. When a token account sends its own token, the first requirement is a self requirement, so 0.18.4 records none of the others. A refusal has this reason when every `SEND` of the staple that lists the refused requirement lists it after a self requirement, and those `SEND`s account for all of its flags.

In the head, 464 of these staples hold a token block that mints and sends to a storage account that had not granted the token `STORAGE_CAN_HOLD`. One holds a token block that sends the token to an account without `ACCESS` on it.

### 6.2 `same-staple-grant-scope`

A requirement is not recorded when an earlier operation of the staple already granted the principal a permission that meets it. 0.18.4 accepts any such grant that holds the flags, whatever its entity, target or method [Keeta TS 0.18.4] index.js:67901-67906. 0.18.7 accepts only an `ADD` or `SET` grant on the requirement's entity, targeted at the requirement's target or at the whole entity [Keeta TS] index.js:68035-68057. A refusal has this reason when a block before the first one that records the refused requirement granted the principal a permission holding all of its flags. No staple of the head has it.

### 6.3 `trusted-account-genesis`

The first staple of the chain opens the network address and the base token, and its only vote is a permanent vote by the initial trusted account, the same vote that upstream's genesis builder seals [Keeta TS] index.js:79675-79688. No representative voted on it. Unlike the builder's, which signs the base-token block with the trusted account itself [Keeta TS] index.js:79621-79632, mainnet's base-token block is signed by another account, and it sets a permission that requires `OWNER` on the base token, which that account does not hold. The exemption for the trusted account's opening blocks covers only requirements whose principal is the trusted account [Keeta TS] index.js:68653-68661. A ledger of either version therefore refuses to vote on it. A refusal has this reason when every vote of the staple is the initial trusted account's, the staple opens both the network address and the base token, and the refused requirement is another account's on one of those two.

### 6.4 Following is unaffected

`Ledger.add` checks the voting weight of a staple's votes, computes its effects and applies them [Keeta TS] index.js:69361-69408. It does not check permission requirements: only a vote does [Keeta TS] index.js:70171-70179, 69989-70022. Both fixes change only which requirements are recorded, so a 0.18.7 node follows mainnet as before: every staple of the head is added, with and without the shadow votes, and both replays reach the same state.

## 7. Edge cases

After the head, the same replay adds the 90 staples of `mainnet/edge-cases.jsonl.gz` to the same ledger, in the same order and with the clock frozen at each staple's timestamp, and then runs gc until nothing more applies. Everything the earlier sections compare, the state dump and the shadow votes included, is read before the first edge case is added.

`mainnet/edge-cases.outcomes.json` gives each staple's outcome by blocks hash:

- `applied`: the staple is on the main ledger.
- `deferred`: the ledger holds the staple until the blocks in `waitingOn` are on the main ledger. These are the previous blocks of its blocks that are not on the main ledger, leaving out opening blocks and blocks whose previous is in the same staple [Keeta TS] index.js:67678-67732.
- `refused`: `Ledger.add` threw, with the error code and message.

| Outcome | Staples |
|---|---|
| `applied` | 1 |
| `deferred` | 89 |
| `refused` | 0 |

No staple is refused. `Ledger.add` checks a staple's voting weight before it defers anything [Keeta TS] index.js:69397-69405, and every edge case passes that check. Each one decodes and verifies, including the sends to recipients that are not points on the curve and the blocks of the all-zero account.

Of the deferred staples, 13 wait only on blocks that are in neither file, from the history between the head and the edge cases. The other 76 wait only on blocks of other edge-case staples, which are themselves deferred.

The applied staple opens an account and extends it in the same staple, so it waits on nothing. The account has no earlier history in either file, so the staple's sends leave its balances negative. `Ledger.add` applies a confirmed staple's balance changes without a range check, which only a vote makes [Keeta TS] index.js:67382, 70079-70089, and reading that account's balances then fails [Keeta TS] index.js:69422-69436.

## 8. A second implementation

`mainnet/head.rust-mirror.jsonl` is a second, independent implementation's state for the same staples, restricted to the record kinds it models. The implementation is written in Rust, separately from Keeta's client: it decodes and verifies the staples, computes their effects and keeps its state with its own code and its own storage. It applies the 2,037 staples of the head file, oldest first by the earliest `validityFrom` of each staple's votes, and every one applies. Its own quorum and balance checks dispute none of them.

The file is a dump in format `slop-node/state-dump@1` (`STATE-DUMP.md`) with every kind but `idempotent`, which the implementation does not store; the head carries no idempotent value. The implementation does not compute the `touched` sets of section 5 of `STATE-DUMP.md`, so it is given the dumped account set, the `account` keys of `mainnet/head.state.jsonl`, and reads every value from its own state. It also checks the set from its side: no account outside it holds any state of its own there, each being only a representative that an account of the set delegates to.

Its model differs from the format in two places, and the values are converted. It counts an account's opening block as height 1, so a head's height is its own minus one. It keeps a representative for every account, so an account whose key type cannot delegate is written with none, as `STATE-DUMP.md` section 3.1 requires; no account of the set needed it.

The file equals `mainnet/head.state.jsonl` without its `idempotent` records, byte for byte. `make test` checks that equality and the file's validity under the schema from the committed files; it does not build or run the second implementation.

`make conformance` does not regenerate the file. When `mainnet/head.state.jsonl` changes on purpose, a line where the two files then differ is an open disagreement between the two implementations, and it stays one until that implementation's maintainers regenerate and commit their dump. The file is never edited or deleted to make the check pass.

## 9. What the replay shows

The replay shows three things about the head file:

- **Following.** Every staple applies and none stays deferred. A ledger on the in-memory driver and one on the Postgres driver end in byte-identical state, and that state, the ledger checksum included, equals `mainnet/head.state.jsonl`.
- **Voting.** The 0.18.7 ledger votes for every staple except 466, and each of those has one named reason (section 6). The 465 of `self-requirement-return` are refused because of the change between 0.18.4 and 0.18.7 that section 6.1 cites; the genesis staple is refused by a ledger of either version, because no representative voted on it (section 6.3).
- **A second implementation.** The independent implementation of section 8 reaches the same state for every record kind except `idempotent`, which it does not store.

It does not show:

- **Agreement with a live node.** No state of the replay was compared with what a mainnet representative serves.
- **Agreement with the network's checksum.** The checksum was not checked against the network, and it cannot be: it is the XOR over the blocks of the head file, a prefix of the chain, while a representative serves the checksum of its own ledger, which holds the whole chain (`STATE-DUMP.md` section 3.5).
- **Anything after the head,** except the 90 edge cases of section 7. Their outcomes are pinned, but 89 of them are deferred, so the state they reach on a ledger that holds the history between is not compared.
