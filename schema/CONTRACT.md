# Storage driver contract

`lib.Ledger` from `@keetanetwork/keetanet-client` 0.18.7 keeps all of a node's ledger state in a storage driver that implements `LedgerStorageAPI`. The ledger checks quorum, permissions, balances and vote safety itself, but each of those checks reads through the driver, so a driver that answers one read wrongly can make the ledger sign a conflicting vote, refuse a valid staple or apply one twice.

`LedgerStorageDriverBase` (`src/ledger/storage/base.ts`) implements the members whose logic is shared by every driver. `MemoryLedgerStorage` (`src/ledger/storage/memory/driver.ts`) is the reference driver. `PostgresLedgerStorage` (`src/ledger/storage/postgres/driver.ts`) keeps the ledger in the Postgres schema of section 6, which any other implementation of that schema shares. The shared suite (`src/ledger/storage/drivers.test.ts`, cases in `src/ledger/storage/suite/`) runs one body against every driver, and the vote-decision corpus (`src/conformance/corpus.test.ts`) replays every case on each of them.

## Conventions

- "Must" states a requirement on every driver.
- `[Keeta TS] index.js:N` is line N of `client/index.js` in the published `@keetanetwork/keetanet-client` 0.18.7 package.
- "Tested by" names the suite cases that check a rule, as `file: "case name"`. Files are in `src/ledger/storage/suite/` unless a path is given.
- "Untested" marks a requirement that no case checks. A driver can break it and still pass the suite, so it is not guaranteed by passing.
- "(provisional: confirmed by the live parity checks)" marks a choice the upstream code leaves open. Comparison with a node of the live network can change it.
- A "Postgres" paragraph states how the Postgres driver answers a member: the predicate of its query, the index that serves it, and what another implementation of the schema must reproduce exactly. Table and index names are those of `schema/migrations/`. "The account's ID" is its row in `accounts`, found by public key through `accounts_public_key_key`. "Unexpired at m" is the side-vote predicate `ledger = 'side' AND (permanent OR validity_to >= m - 60 s)` (D4).

## 1. Scope and vocabulary

**Driver, ledger and node.** A driver serves exactly one `Ledger` configuration. The `Ledger` constructor calls `init` once. `Ledger.copy`, which `Node.copy` uses, shares the driver with the copy without calling `init` again [Keeta TS] index.js:70250-70266.

**Main ledger.** The confirmed state: every staple that `adjust` applied, with its blocks, votes, chain positions, and the balances, supplies, weights, representatives, ACLs, account info, certificates, idempotent keys and history that follow from it. Only permanent votes reach the main ledger: `Ledger.add` refuses any other [Keeta TS] index.js:69388-69395.

**Side ledger.** This node's own pending votes, the blocks those votes cover, and the idempotent keys of those blocks. `addPendingVote` is called only with the vote the node has just sealed [Keeta TS] index.js:69310-69316, 69342-69354, so the side ledger never holds another representative's vote. It holds no balances, ACLs, heights or heads.

**Staple and its identity.** A staple is a set of votes on one ordered list of blocks. Its identity is its `blocksHash`: the hash of the concatenated hashes of its blocks, in vote order [Keeta TS] index.js:80126-80143. Different subsets of a quorum produce different vote sets for the same blocks, so a driver keys a staple by `blocksHash` and never by the hash of its serialized form.

**Vote identity.** A vote is identified by `$uid`, built from its issuer and serial [Keeta TS] index.js:80569-80570.

**Temporary and permanent votes.** A temporary vote is valid until five minutes after it is issued [Keeta TS] index.js:70204-70207. A permanent vote is valid for about a thousand years [Keeta TS] index.js:81526-81529 and is flagged `$permanent` [Keeta TS] index.js:80376-80380.

**Live and unexpired.** A stored vote is live at a moment when Keeta's `Vote` class would accept it at that moment. One of this node's side votes is unexpired at moment m unless it is temporary and m - 60 s > `validityTo`. Side reads and gc use only the expiry bound, never the start of validity (D4). A side block counts only while an unexpired side vote covers it, and a side idempotent key counts only while its block counts.

**Transaction moment.** `transaction.moment`, which `Ledger.beginTransaction` sets to the wall clock when an attempt starts [Keeta TS] index.js:70393-70396. Each retry is a new attempt with a new moment. The transaction moment is the "now" of every expiry decision in the transaction, and the confirmation moment of every staple the transaction applies. A driver never substitutes the wall clock or a database clock for it.

**Selector.** `LedgerSelector` is `'main' | 'side' | 'both'`. Members that take one answer from the main ledger, the side ledger, or both (D7). Members that take none read the main ledger only.

**Opening sentinel.** The `previous` of an account's first block is the hash of the account's public key [Keeta TS] index.js:63173-63175. It is never a block itself, but successor lookups accept it.

**Deferred staple.** A confirmed staple that extends a block this node does not have on its main chain. It is stored, waiting on each missing previous block, and applied when the last of them arrives (D13).

**Key spellings.** Hashes are spelled as upstream's `toString()` prints them, in uppercase hex [Keeta TS] index.js:76858-76861. Accounts are spelled as public key strings (`keeta_...`), and an account given as a string is first converted to that form [Keeta TS] index.js:62709-62714. Members that return maps key them this way.

## 2. Lifecycle walkthrough

The walkthrough follows representative R, which runs a node with its private key, and user account U, whose main chain ends at block A. "Base" marks a call that `LedgerStorageDriverBase` or upstream's `LedgerStorageBase` makes into the driver.

### 2.1 Genesis

`Ledger.add(genesis)`. The genesis staple carries one permanent vote by the initial trusted account and opens the network address, the base token and the first users.

1. `beginTransaction({ node, moment, identifier: 'db-add', readOnly: false })`.
2. `delegatedWeight(tx)` returns `0n`, so the quorum is a vote by the initial trusted account [Keeta TS] index.js:69740-69751.
3. `adjust(tx, genesis, effects)`, where `computeEffectOfBlocks` has computed `effects` in memory [Keeta TS] index.js:69404-69407:
   1. Base: the chain-order and shared-previous checks, which make no storage call (D14).
   2. Base, `preAdjust`: `getBlockHeights` for every block, all `null`, then for the previous blocks outside the staple. Opening blocks get height 0, and each later block of the same chain gets its previous block's height plus one [Keeta TS] index.js:67678-67732.
   3. Base, the confirmed-history check: `getHeadBlock(tx, account, 'main')` for each opening block and `getBlockFromPrevious(tx, previous, 'main')` for every other block whose previous lies outside the staple. All are `null` (D14).
   4. Base, settlement statistics: on a ledger with a node and a private key, `getVotes(tx, hash, 'side')` for each block [Keeta TS] index.js:67593-67632.
   5. Base, `computeLedgerEffect`: `listACLsByPrincipal`, `getBalance`, `getAccountRep`, `delegatedWeight` and `getAccountCertificateByHash`, as the effects require [Keeta TS] index.js:67187-67345.
   6. `persistConfirmedStaple(tx, change)` writes the blocks, chain positions, the vote, history, ACLs, account info, supply, balances, delegation and weight (section 4.2).
   7. `removeDeferredStaple(tx, genesis.blocksHash)`, then `listDeferredStaplesWaitingOn(tx, hashes of the genesis blocks)`, which finds nothing.
   8. `adjust` returns `[genesis]`.
4. `Ledger.add` XORs every block hash of every returned staple into `statsPending` under `ledgerChecksum` [Keeta TS] index.js:69413-69417.
5. `commitTransaction(tx)`. Only after the commit succeeds does `Ledger` merge `statsPending` into the node's statistics [Keeta TS] index.js:69001-69006.

### 2.2 Temporary vote

`Ledger.vote([B])`, where block B extends A.

1. `beginTransaction({ identifier: 'db-vote', readOnly: false })`.
2. If B carries an idempotent value: `getIdempotentBlockHash(tx, key, 'both', B.hash)`. A non-null answer refuses the vote with `LEDGER_IDEMPOTENT_KEY_EXISTS` [Keeta TS] index.js:69254-69259.
3. Base: `getHeadBlockHashes(tx, {U})` calls `getHeadBlocks(tx, [U], 'both')`, which must return A. Otherwise the vote is refused with `LEDGER_NOT_SUCCESSOR`, `LEDGER_NOT_OPENING` or `LEDGER_NOT_EMPTY` [Keeta TS] index.js:69260-69276.
4. `getVotesFromMultiplePrevious(tx, [A], 'both', R)` returns `null`, so no successor of A has an unexpired vote by R [Keeta TS] index.js:69281-69306.
5. Outcome validation reads the account state the blocks need: `getAccountInfo`, `listACLsByPrincipal`, `listACLsByEntity`, `getAccountCertificates`, `getAccountCertificateByHash`, `listOwners` and `getBalance` [Keeta TS] index.js:69760-69880, 69982-70095.
6. `getNextSerialNumber(tx)` [Keeta TS] index.js:70202.
7. `addPendingVote(tx, staple of [temporary vote] on [B])`: B gets a side copy, and the vote is indexed by B, by A (B's previous) and by its `blocksHash`. B's idempotent key, if any, is claimed on the side [Keeta TS] index.js:69310-69316.
8. `commitTransaction(tx)`.

`Ledger.quote([B])` performs the same validation and takes a serial, but never calls `addPendingVote` [Keeta TS] index.js:69356-69360, 70202.

### 2.3 Permanent vote

`Ledger.vote([B, FEE], temporaryVotes)`, where a quorum of temporary votes on B is attached and FEE pays the voters.

1. Steps 1 to 3 of 2.2. The idempotent lookup excludes each block's own hash, so B's side claim does not refuse B. The head of U is still A, because side blocks are never heads (D5).
2. `getVotesFromMultiplePrevious(tx, [A, B], 'both', R)`. Under A it returns exactly R's temporary vote, which a permanent vote may replace [Keeta TS] index.js:69288-69301. Under B it returns `null`.
3. Outcome validation, as in 2.2.
4. `delegatedWeight(tx)` and `delegatedWeight(tx, issuers)` check that the attached votes carry quorum [Keeta TS] index.js:69334-69338, 69740-69759.
5. `getNextSerialNumber(tx)`, then `addPendingVote(tx, staple of [permanent vote] on [B, FEE])` [Keeta TS] index.js:69342-69354. FEE gets a side copy. The permanent vote is stored beside the temporary vote, which stays (D6).
6. `commitTransaction(tx)`.

From now on, `getVotesFromMultiplePrevious(tx, [A], 'both', R)` returns two votes, so R refuses every further vote on a successor of A [Keeta TS] index.js:69288-69305.

### 2.4 Publish

`Ledger.add(S)`, where S carries a quorum of permanent votes on [B, FEE].

1. `beginTransaction({ identifier: 'db-add', readOnly: false })`, then `delegatedWeight` twice for the quorum check [Keeta TS] index.js:69398-69401.
2. `adjust(tx, S, effects)`:
   1. Base, `preAdjust`: B and FEE have no height, because side blocks never have one (D5). B gets A's height plus one, and FEE, whose previous is B, gets B's height plus one.
   2. Base, the confirmed-history check: A has no main successor.
   3. Base, settlement statistics: `getVotes(tx, B.hash, 'side')` finds R's temporary vote, and the time since its `validityFrom` is recorded. The increments are held until `adjust` returns [Keeta TS] index.js:67593-67632.
   4. `persistConfirmedStaple(tx, change)` writes the main rows. In the same write it removes the side copies of the staple's votes that are R's own, the side copies of B and FEE, and their side idempotent claims. R's temporary vote on B stays on the side until it expires or gc collects it (D6, D20).
   5. `removeDeferredStaple`, then `listDeferredStaplesWaitingOn(tx, [B, FEE])`.
   6. `adjust` returns `[S]`.
3. Checksum fold and `commitTransaction(tx)`, as in 2.1.

### 2.5 Deferred add

Node N lacks A and receives S.

1. In `adjust(tx, S, effects)`, `preAdjust` finds no height for A and calls the base's `adjustDefer`. That calls `getBlockHeights` for S's previous blocks outside the staple, then `storeDeferredStaple(tx, S, [A])`. `preAdjust` returns an empty result, and `adjust` returns `[]`. Nothing enters the checksum, and the commit persists the deferred staple [Keeta TS] index.js:67717-67729.
2. Later, staple T containing A arrives. `adjust(tx, T, ...)` applies T. Then `listDeferredStaplesWaitingOn(tx, hashes of T's blocks)` finds S, and S runs through the same template in the same transaction, with deferral disabled, inside `runIsolated(tx, unit)`:
   - `preAdjust` now sees A's height, which T wrote earlier in the transaction.
   - S is persisted, and `removeDeferredStaple(tx, S.blocksHash)` runs.
   - The staples waiting on S's blocks are looked up in turn, each in a unit nested in S's.

   `adjust` returns `[T, S]`, and each enters the checksum once.
3. Replay stops when `heapProcessWindowMs` (default 5000 ms) has elapsed since the `adjust` began, and the remaining waiters stay deferred. A waiter whose replay throws is logged, its unit is undone, and it stays deferred. T still commits (D13).

### 2.6 Garbage collection

`Ledger.gc(timeLimitMS)` runs upstream's loop in one read-write transaction (`'db-gc'`). The loop calls `gcBatch` until a batch reports that no work remains, or until `timeLimitMS` (default 280000 ms) has elapsed [Keeta TS] index.js:70517-70521, 67852-67862. Each base batch makes these calls:

1. `collectDeadDeferredStaples(tx, 100)`: removes deferred staples that can never apply, because the `previous` of one of their blocks has a confirmed successor. Each is logged once, as a network integrity alarm.
2. `listReleasedDeferredStaples(tx, 100, retried)`: deferred staples whose awaited blocks are all on the main ledger. A staple that an earlier retry of the batch has made dead is dropped and logged in the same way, through `getBlockFromPrevious(tx, previous, 'main')` and `removeDeferredStaple`. Each other staple is retried through the `adjust` template with deferral disabled, inside `runIsolated(tx, unit)`. The staples it applies, chained replays included, are folded into `ledgerChecksum`. A failed retry is logged, its unit is undone, and it stays deferred; the same gc transaction does not retry it again.
3. `listReleasedDeferredStaples(tx, 1, retried)`: whether a released staple not yet retried in this transaction remains, counting staples released by this batch's retries.
4. `collectObsoleteSideVotes(tx, 100)`: removes side votes that have expired at the transaction moment, or that cover a block whose `previous` has a confirmed successor, together with the side blocks and side idempotent claims that only they held.
5. The batch reports whether any kind of work remains.

After 2.4, gc collects R's temporary vote on B, because B is on the main ledger. It also collects R's votes on a competitor C of B, temporary or permanent, because C's previous A now has the confirmed successor B. A permanent side vote whose staple can still be published stays.

## 3. Transactions and isolation

### 3.1 The transaction object

`beginTransaction` receives `{ node?, moment?, identifier, readOnly? }` and returns the object that every other member receives. That object must expose:

- `node`, as passed
- `moment`, as passed, or the wall clock when absent
- `identifier`
- `readOnly`, which defaults to `true`
- `statsPending`, a fresh instance of upstream's `StatsPending`

This is the shape of upstream's `LedgerStorageTransactionBase` [Keeta TS] index.js:68952-68960. `Ledger` writes the checksum and settlement increments into `statsPending`, and merges it into the node's statistics only after a successful commit [Keeta TS] index.js:69001-69006, 74339-74350. A driver built on the base returns a `LedgerDriverTransaction` (`src/ledger/storage/base.ts`) or a subclass of it.

### 3.2 Attempts, commit and abort

`Ledger.run` opens one driver transaction per attempt and runs the request in it. On success it commits; if the request throws, it aborts. The error from the request, the commit or the abort goes through `evaluateError`. The whole attempt runs again with a new transaction when the evaluated error is upstream's ledger error with `shouldRetry` set and the retry budget allows it. The budget defaults to 5000 ms from the first attempt, and the delay is `retryDelay`, or 20 ms [Keeta TS] index.js:70294-70389.

- **Exactly once.** A transaction is committed or aborted exactly once. `Ledger` never aborts after a failed commit [Keeta TS] index.js:70337-70347, so a driver whose commit fails must release the transaction's resources itself. After commit or abort, every member called with the transaction must reject, including a second commit or abort. Tested by `transactions.ts: "a finished transaction rejects further use"`, after a commit and after an abort.
- **Commit** makes every write of the transaction visible to later transactions at once.
- **Abort** discards every write of the transaction. Tested by `transactions.ts: "abort discards writes but never reuses a serial"`.
- **A commit that fails** never yields a retryable error unless the driver knows that nothing was committed (D17). A retried `add` of a staple that did commit fails with `LEDGER_BLOCK_ALREADY_EXISTS`. A retried `vote` signs a second vote under a new serial. Tested for the Postgres driver by `src/ledger/storage/postgres/driver.test.ts: "a broken connection at commit is not retried"` and `src/ledger/storage/postgres/driver.test.ts: "a serialization failure at commit is retried by Ledger.run"`.
- **Read-only transactions.** `Ledger` passes `readOnly: true` only from `runReadOnly`, which every getter uses [Keeta TS] index.js:70390-70392. `vote`, `quote`, `add` and `gc` run read-write [Keeta TS] index.js:70397-70411, 70517-70521. A read-only transaction never calls `adjust`, `addPendingVote` or `gc`, so a driver may serve it from a read-only snapshot. The memory driver does not distinguish the two.

### 3.3 Isolation

A driver must provide the following.

1. **Serializable outcomes.** Concurrent transactions must produce the state of some serial order. Three upstream sequences read state and then write on the strength of what they read:
   - `vote` reads `getVotesFromMultiplePrevious`, then calls `addPendingVote`. Two concurrent votes on competing successors of one block must not both succeed. Tested by `concurrency.ts: "concurrent competing votes produce exactly one temporary vote"`, and across two processes by `concurrency.ts: "two processes voting on competing blocks sign one vote, and the other is refused after a retry"`.
   - `add` reads heights in `preAdjust`, then persists. Two concurrent adds of one staple must apply it once. Tested by `concurrency.ts: "concurrent adds of one staple apply it once"`, and across two processes by `concurrency.ts: "two processes adding one staple apply it once, and the other finds it applied after a retry"`.
   - One transaction defers S on A while another applies A. Under weaker isolation each misses the other's write, and S waits until a gc retry. Untested.
2. **Read-your-writes.** Every read in a transaction sees that transaction's earlier writes. Replay depends on this, because a replayed staple reads the heights, balances and representatives its trigger has just written. Tested by `transactions.ts: "reads see the transaction's own writes"`, and by every replay case in `deferral.ts`.
3. **Concurrent calls within one transaction.** Upstream issues reads on one transaction concurrently [Keeta TS] index.js:67332-67339, 67638-67646, 69935-69945, and `Promise.all` over `add` within one transaction is legal. A driver must accept overlapping calls on one transaction and lose no write. The base runs overlapping `adjust` calls, and gc batches, on one transaction one after another (item 4). Tested by `transactions.ts: "concurrent calls within one transaction keep every write"`.
4. **Per-staple isolation.** `runIsolated(tx, unit)` (section 4.2) is the isolation boundary of a deferred staple. The base runs each replayed staple, and each staple a gc pass retries, as one unit, together with everything that staple releases in turn, so units nest. If a unit throws at any point, none of its writes may remain while the transaction continues: before the write, in `persistConfirmedStaple`, or after it, in `removeDeferredStaple` or a nested replay. The staple then stays deferred. It is neither returned by `adjust` nor folded into `ledgerChecksum`, and its settlement statistics are not recorded. Its trigger still commits. A database driver implements `runIsolated` with a savepoint, released when the unit succeeds and rolled back when it fails. Without one, a failed statement aborts the whole transaction, or a staple that failed after its write stays half-applied.
   - `persistConfirmedStaple` must still apply a whole change or nothing, because the staple at the top of `adjust` runs in no unit, and the base's default `runIsolated` adds no isolation.
   - Rolling a unit back undoes every write made while it was open. The base therefore runs `adjust` and gc batches one at a time per transaction, so no other `adjust` writes into an open unit.
   - A write made outside a unit must never land inside an open one, because a unit that fails takes the write with it although its caller was told it succeeded. A member that upstream may call on a transaction while `adjust` or gc runs on it must therefore take its turn with `runIsolatedInTurn` (section 4.2) instead of writing at once. `addPendingVote` is the only such member. `runIsolatedInTurn` must not be called from work the base has queued (`adjust`, gc, a replayed staple, `persistConfirmedStaple`), because it would wait for its own turn.

   Tested by:
   - `deferral.ts: "a replayed staple that fails after its write leaves nothing behind and stays deferred"`, where a nested unit fails after its write and only it is undone
   - `gc.ts: "a gc retry that fails after its write leaves nothing behind and stays deferred"`
   - `deferral.ts: "a replayed staple whose idempotent key is taken stays deferred while its trigger applies"`, where the replay fails inside `persistConfirmedStaple`
   - `deferral.ts: "a replayed staple that conflicts stays deferred while its trigger applies"`, where it fails before the write
   - `stats.ts: "a replayed staple that rolls back does not record a settlement time"`, where the unit that rolls back would have earned a settlement time from this node's temporary vote, and earns it once a later retry succeeds
   - `confirmed.ts: "persisting never overwrites a confirmed block or successor"`, which calls the primitive directly
   - `votes.ts: "a pending vote added while a unit that later fails is open survives the unit"`, where a unit opened through the base's test hook fails after `addPendingVote` was issued beside it

The memory driver meets 1 by holding one lock from `beginTransaction` until commit or abort. It grants the lock first come, first served (untested): fairness, not correctness, depends on that order. It meets 2 and 4 with a copy-on-write overlay per transaction, applied on commit and dropped on abort, and with a nested overlay for each staged group of writes and for each isolated unit. While a unit is open, the transaction reads and writes through the unit's overlay, which is applied to the enclosing view when the unit succeeds and dropped when it fails. It meets 3 by keeping every overlay operation synchronous. It records a commit as done only after the overlay has been applied, and a failed commit leaves the transaction finished with a non-retryable error (untested).

The Postgres driver takes no lock of its own, and keeps nothing in the process that correctness depends on, so several processes can serve one representative from one database:
- It meets 1 by running every transaction as `BEGIN ISOLATION LEVEL SERIALIZABLE`, with `READ ONLY` added for a read-only one. Postgres then aborts one of two transactions whose reads and writes no serial order explains, and the driver reports that abort as a retryable conflict (section 3.5).
- It meets 2 because a transaction holds one pooled connection from `beginTransaction` until commit or abort, and runs every statement on it.
- It meets 3 by queueing the statements issued on one transaction and running them on its connection one at a time, in the order they were issued. Overlapping calls therefore interleave whole statements, and each sees the writes of the statements issued before it.
- It meets 4 with savepoints. `runIsolated` opens `SAVEPOINT unit_<depth>`, where depth counts the units open on the transaction, releases it when the unit succeeds, and rolls back to it and releases it when the unit fails. `persistConfirmedStaple` writes inside a savepoint of its own, so a refused or failed staple leaves the transaction usable. `addPendingVote` opens its savepoint through `runIsolatedInTurn`, after the work the base has queued, so a unit's savepoint never holds another caller's write.
- A conflict reported by any statement dooms the attempt, even one inside a unit whose failure the caller handled: what the attempt read may already be stale. Commit then rolls back and reports the conflict.

Tested by `src/ledger/storage/postgres/driver.test.ts: "a failed unit rolls back to its own savepoint and the transaction carries on"`, `src/ledger/storage/postgres/driver.test.ts: "a conflict inside a unit fails the commit even when the unit's failure is handled"` and `src/ledger/storage/postgres/driver.test.ts: "pending votes added concurrently on one transaction open their units one at a time"`, besides every case above, which the shared suite runs on Postgres.

### 3.4 `evaluateError` mapping

- An error that is a KeetaNet error (`lib.Error.isInstance`) is returned unchanged. That covers ledger errors, vote errors, idempotent-key errors and block errors. Callers depend on their codes, and `Ledger.run` then retries exactly the ones that ask for it.
- Any other error becomes a non-retryable `LEDGER_OTHER` with the original message, and the original error as its `cause`. The case below checks both.
- `Ledger.run` retries only instances of upstream's own ledger error class [Keeta TS] index.js:70360-70370. The package does not export that class, so `createLedgerError` (`src/ledger/storage/errors.ts`) builds it through `lib.Error.fromJSON` [Keeta TS] index.js:66340-66396. Codes are restricted to upstream's list [Keeta TS] index.js:66453-66492.

Tested by `transactions.ts: "ledger errors pass through evaluateError and anything else becomes non-retryable"`.

### 3.5 Real concurrency (D14a)

A driver whose transactions run concurrently must detect every conflict between them: a serialization failure, a deadlock, or a uniqueness violation from a concurrent insert of the same block, vote or key. It must roll the attempt back and report the conflict as a retryable `LEDGER_TRANSACTION_ABORTED`. The retried attempt then reads the committed winner and fails with upstream's own error: `LEDGER_SUCCESSOR_VOTE_EXISTS` for a competing vote, and `LEDGER_BLOCK_ALREADY_EXISTS` for a duplicate add.

The single-instance concurrency cases assert only the final outcome, so they accept a driver that reaches it through a retry. The memory driver serializes transactions and never produces this error.

A driver whose store other processes can open declares it to the suite (`sharing` in `src/ledger/storage/suite/types.ts`), and the suite then runs the cross-process cases: two instances on one store, each with its own connections and its own `Ledger` for the same representative, stand for two processes of one node. A barrier holds each first attempt after its reads and before its writes until both attempts have arrived, with both transactions open, so the race happens on every run. Retries pass the barrier at once. The cases count the read-write transactions both instances open and the arrivals at the barrier, and assert lower bounds on both: at least one attempt beyond the two first attempts, so the losing attempt was retried rather than refused at once. They assert no exact count, because Postgres may abort a retried attempt again when the scheduler stalls it, and the outcome is the same. The memory driver keeps its store in one process and does not run them.

Tested by:
- `concurrency.ts: "two processes voting on competing blocks sign one vote, and the other is refused after a retry"`
- `concurrency.ts: "two processes adding one staple apply it once, and the other finds it applied after a retry"`, which pins the loser's error to `LEDGER_BLOCK_ALREADY_EXISTS`
- `concurrency.ts: "two processes applying staples that name one new account both apply"`, where both staples create the same account row
- `concurrency.ts: "serials taken by two processes during overlapping attempts are all distinct and never issued again"`
- `src/ledger/storage/postgres/driver.test.ts: "a serialization failure at commit is reported as retryable"`

**Postgres.** Each failed statement's error is mapped where it is raised. SQLSTATE `40001` (serialization failure) and `40P01` (deadlock) become a retryable `LEDGER_TRANSACTION_ABORTED`, and so does `23505` (unique violation) on the constraints two processes can race to: `staples_pkey`, `blocks_pkey`, `blocks_main_successor`, `votes_main`, `votes_side` and `idempotent_keys_main`. A unique violation on any other constraint is a fault, and retrying would only repeat it. Account interning is absent from the list: its insert skips existing rows, and under `SERIALIZABLE` a row it cannot see yet fails with `40001`. `40001` at `COMMIT` means nothing was committed and is retryable; a connection lost during `COMMIT` leaves the outcome unknown and is not (D17). A connection lost on any statement before `COMMIT` is retryable as well, because Postgres rolls back the open transaction of a session that ends, and `COMMIT` was never sent: the statement fails with SQLSTATE `57P01` or `57P02` (the server ended the session) or a class `08` code (connection exception), or it fails after `pg` has reported the connection lost. Tested by the cases of `src/ledger/storage/postgres/errors.test.ts`, by `src/ledger/storage/postgres/driver.test.ts: "a connection lost before commit is retried by Ledger.run"`, and by `src/ledger/storage/postgres/driver.test.ts: "a broken connection at commit is not retried"`, where the next statement after the loss is `COMMIT`. Under `READ COMMITTED`, by contrast, both competing votes would pass their check and be stored, and an insert that skips an account row another process has just committed could not read that row back in the same statement.

Under real concurrency, commit order and transaction-moment order can differ: a transaction that began earlier can commit later. A staple can therefore appear with a confirmation moment earlier than staples that are already visible. Readers that page by moment across transactions must allow for this. That a driver stores and orders such a staple by its own moment is tested by `confirmed.ts: "catch-up orders by the moment each staple was applied, then by application, even when the clock goes back"`; two transactions committing out of moment order is untested.

### 3.6 Serial numbers

`getNextSerialNumber` must return a non-negative `bigint` that this node has never returned before and never returns again. It must be strictly greater than every earlier serial, and gaps are allowed. The counter lives outside every transaction, so a serial taken by an aborted or retried attempt is never reissued.

Every temporary vote, quote and permanent vote takes a serial [Keeta TS] index.js:70202, 69342. A vote's identity is its issuer and serial, so two different votes under one serial would be provable equivocation.

Tested by:
- `transactions.ts: "abort discards writes but never reuses a serial"`
- `votes.ts: "quote consumes a serial and stores nothing on the side ledger"`
- `votes.ts: "a permanent vote with a fee block joins the temporary vote"`
- `concurrency.ts: "serials taken by two processes during overlapping attempts are all distinct and never issued again"`
- `src/ledger/storage/postgres/driver.test.ts: "serials strictly increase across processes and survive rolled-back attempts"`

Persistence across restarts is required and untested. The memory driver keeps its counter only in memory and restarts it at 1, so it must never back a representative key that has signed votes before: its serials would repeat earlier ones.

**Postgres.** One sequence, `vote_serials` (`bigint`, starting at 1, `CACHE 1`, no cycle), read with `nextval`. Given a transaction, the driver runs `nextval` on that transaction's connection; without one, on a connection of its own. Upstream takes the serial inside the read-write transaction of `vote` or `quote` [Keeta TS] index.js:69342, 70202, which already holds a pooled connection: taking a second one would wait forever once every connection of the pool is held by a transaction doing the same. `nextval` never rolls back, so an aborted attempt's serial is never issued again. Tested by `src/ledger/storage/postgres/driver.test.ts: "votes complete on a pool of one connection, alone and concurrently"`. `CACHE 1` makes every call take the next value of the one shared counter, so the serials of all processes together strictly increase; a larger cache would hand each connection its own block of values, and serials from two processes would no longer follow the order they were taken in.

## 4. Members

### 4.0 Rules common to every member

- Every member except `init`, `destroy`, `beginTransaction`, `evaluateError`, `getNextSerialNumber` and `stats` takes the transaction first. It must reject once that transaction has ended.
- Members without a selector read the main ledger.
- Selector members answer as D7 states. `'main'` reads the main ledger. `'side'` reads the side ledger, counting only unexpired side votes and the side blocks and keys they cover. `'both'` returns the main answer when the main ledger has one, and the side answer otherwise, decided for each requested key.
- Members that return maps return an entry for every requested key, with `null` for an absent one (D7).
- `getVotes` returns `null`, never `[]`, when there is nothing to return. List members return `[]`.
- Amounts, supplies, weights, heights and serials are `bigint`. Stored values are returned as stored, negative ones included (D9).
- Each section's citations name the upstream callers whose use of the answer forces its semantics.

### `init`

```ts
init: (config: LedgerConfig, ledger: Ledger) => void;
```

- **Semantics.** Binds the driver to one ledger. The `Ledger` constructor calls it synchronously and ignores the return value, so asynchronous setup belongs in `beginTransaction` [Keeta TS] index.js:70250-70255. A node constructs its ledger before its own statistics exist [Keeta TS] index.js:71341-71351, so `init` must not read `ledger.node.stats`. The base reads it lazily in `stats`. The base also stores `config` where upstream's base class reads its logger.
- **Selector, ordering.** None.
- **Errors.** A second call throws `storage driver is already initialized`. A member that needs the configuration before `init` rejects with `StorageDriverNotInitializedError`.
- **Tested by** `transactions.ts: "a driver serves exactly one ledger"`.
- Implemented by the base.
- **Postgres.** Opens the pool and starts migrating the database (section 6.3) without waiting. The first transaction waits for the migration; one that fails is reported by that transaction and tried again by the next. An injected pool keeps its owner's settings. A pool opened from a connection string holds at most 10 connections; a checkout fails after waiting 5 s, which is `Ledger.run`'s whole retry budget [Keeta TS] index.js:70294-70389; connections use TCP keepalive; and every session starts with `statement_timeout` at 30 s and `idle_in_transaction_session_timeout` at 10 s. Between the statements of one attempt the process only computes, so a session idle in a transaction that long belongs to a stalled process, and ending it frees the row locks other attempts wait on. A statement may outlast the retry budget: `stats` counts the whole main ledger in one statement, and gc runs its batches for up to its time limit, one batch per statement. Each setting can be overridden. Tested by `src/ledger/storage/postgres/pool.test.ts`.

### `destroy`

```ts
destroy?: () => Promise<void>;
```

- **Semantics.** Optional. Releases what the driver holds, such as connections and timers. No upstream code calls it. Neither the base nor the memory driver implements it, and the suite releases drivers through its own `destroy` hook (`suite/types.ts`).
- **Selector, ordering, errors.** None.
- **Postgres.** Implemented. Ends the pool if the driver opened it from a connection string, and leaves an injected pool to its owner. Members called afterwards reject. Tested by `src/ledger/storage/postgres/driver.test.ts: "destroy ends a pool the driver opened and leaves an injected pool to its owner"` and `src/ledger/storage/postgres/pool.test.ts`.

### `beginTransaction`

```ts
beginTransaction: (transactionBase: LedgerStorageTransactionBaseOptions) => Promise<LedgerStorageTransactionBase>;
```

- **Semantics.** Opens a transaction for one attempt (sections 3.1 and 3.3). It may wait: the memory driver waits here for its lock.
- **Selector, ordering.** None.
- **Errors.** Any error goes through `evaluateError`, like every other error of the attempt.
- **Tested by** every case. Its shape is checked by `stats.ts: "stats reads settlement times and retries from the node"`, where the node's settlement statistics arrive only through `statsPending`.
- **Upstream.** [Keeta TS] index.js:70393-70396.
- **Postgres.** Checks out one pooled connection and runs `BEGIN ISOLATION LEVEL SERIALIZABLE`, followed by `READ ONLY` when `readOnly` is true or absent. The connection is held until commit or abort (section 3.3). A connection lost while `BEGIN` runs is closed and the error reported.

### `commitTransaction`

```ts
commitTransaction: (transaction: any) => Promise<void>;
```

- **Semantics.** Section 3.2.
- **Errors.** Rejects for a transaction that has already ended.
- **Tested by** `transactions.ts: "a finished transaction rejects further use"`.
- **Upstream.** [Keeta TS] index.js:69001-69006, 70337-70347.
- **Postgres.** Waits for every statement issued on the transaction, then runs `COMMIT`. If any statement of the attempt reported a conflict, it rolls back instead and reports that conflict, retryable. Postgres answers `COMMIT` of a transaction that a failed statement aborted with `ROLLBACK`, which the driver reports as an error. A failed `COMMIT` leaves the transaction finished and its connection closed. Tested by `src/ledger/storage/postgres/driver.test.ts: "a serialization failure at commit is reported as retryable"` and `src/ledger/storage/postgres/driver.test.ts: "a broken connection at commit is not retried"`.

### `abortTransaction`

```ts
abortTransaction: (transaction: any) => Promise<void>;
```

- **Semantics.** Section 3.2.
- **Errors.** Rejects for a transaction that has already ended.
- **Tested by** `transactions.ts: "abort discards writes but never reuses a serial"` and `transactions.ts: "a finished transaction rejects further use"`.
- **Upstream.** [Keeta TS] index.js:69007-69011, 70337-70347.
- **Postgres.** Waits for every statement issued on the transaction, then runs `ROLLBACK`. A connection that cannot roll back is closed, which rolls back too, so abort itself never fails.

### `evaluateError`

```ts
evaluateError: (error: any) => Promise<any>;
```

- **Semantics.** Section 3.4, plus the conflict mapping of section 3.5 for drivers with concurrent transactions. Implemented by the base. A driver with database conflicts extends it, mapping its own transient errors and delegating everything else.
- **Tested by** `transactions.ts: "ledger errors pass through evaluateError and anything else becomes non-retryable"`, including the `LEDGER_OTHER` code and the `cause`.
- **Upstream.** [Keeta TS] index.js:70350-70372.
- **Postgres.** Not overridden. Each statement's error is mapped where it is raised (section 3.5), so `evaluateError` receives a ledger error for a conflict and makes anything else `LEDGER_OTHER`.

### `delegatedWeight`

```ts
delegatedWeight: (transaction: any, rep?: Account | InstanceType<typeof Account.Set>) => Promise<bigint>;
```

- **Semantics.**
  - Without `rep`: the sum of every stored weight, which is the network total.
  - With an `Account`: its weight, or `0n` if it has none.
  - With an `Account.Set`: the sum over its distinct members.

  A representative's weight is the sum of the base-token balances of the accounts that delegate to it. It is maintained by adding the weight deltas that `computeLedgerEffect` resolves, so the total always equals the sum of the per-representative weights. The quorum test compares the two [Keeta TS] index.js:69740-69759. Weights are not clamped (D9).
- **Selector.** Main only.
- **Tested by**:
  - `genesis.ts: "genesis state reads back"`
  - `confirmed.ts: "send moves balances and credits the receiver"`
  - `confirmed.ts: "set representative moves weight"`
  - `transactions.ts: "concurrent calls within one transaction keep every write"`
  - the quorum check of every `add` and permanent vote
- **Upstream.** `votingPower` [Keeta TS] index.js:69457-69462; the quorum check [Keeta TS] index.js:69740-69759; `computeLedgerEffect` [Keeta TS] index.js:67202-67208.
- **Postgres.** Without `rep`: `sum(weight)` over `weights`, or 0 when it has no rows. With an account or a set: the same sum over the rows whose representative's public key is listed, through `accounts_public_key_key` and `weights_pkey`. The deltas are added on write (`persistConfirmedStaple`), so a weight is one row per representative.

### `getBalance`

```ts
getBalance: (transaction: any, account: GenericAccount, token: TokenAddress) => Promise<bigint>;
```

- **Semantics.** The stored balance, or `0n` for a pair with no row. A negative stored balance is returned as it is (D9). Upstream's own wrapper refuses to report one [Keeta TS] index.js:69421-69428, but vote validation reads the driver directly and must see the true value [Keeta TS] index.js:67190-67200.
- **Selector.** Main only.
- **Tested by**:
  - `confirmed.ts: "a cross-account funding gap stores a negative balance that heals"`
  - `confirmed.ts: "send moves balances and credits the receiver"`
  - `confirmed.ts: "token creation, supply and token-account balances"`
  - `genesis.ts: "genesis state reads back"`
- **Postgres.** The `balances` row for the holder's and the token's IDs, through `balances_pkey` (`account_id`, `token_id`); no row reads as `0n`.

### `getAllBalances`

```ts
getAllBalances: (transaction: any, account: GenericAccount) => Promise<GetAllBalancesResponse>;
```

- **Semantics.** One `{ token, balance }` entry per token with a non-zero stored balance on the account, or `[]` for an account with none. Zero balances are omitted (provisional: confirmed by the live parity checks). Untested: no case brings a stored balance back to zero.
- **Selector.** Main only.
- **Ordering.** Unspecified.
- **Tested by** `genesis.ts: "genesis state reads back"`, `confirmed.ts: "send moves balances and credits the receiver"` and `confirmed.ts: "token creation, supply and token-account balances"`.
- **Upstream.** [Keeta TS] index.js:69429-69438.
- **Postgres.** The holder's `balances` rows with `balance <> 0`, through the `account_id` prefix of `balances_pkey`.

### `getAccountInfo`

```ts
getAccountInfo: <T extends AccountKeyAlgorithm = AccountKeyAlgorithm>(transaction: any, account: Account<T> | string) => Promise<AccountInfoForType<T>>;
```

- **Semantics.** The stored info, formatted by upstream's `_formatAccountInfoFromRow` [Keeta TS] index.js:67733-67785, which supplies defaults for missing fields:
  - `name`, `description` and `metadata` default to `''`.
  - Identifiers carry `defaultPermission`, which defaults to empty.
  - Tokens carry `supply`, which defaults to `0n`.
  - Multisig identifiers carry `multisigQuorum`, which defaults to `null`.

  The answer is never `null`: an account with no row gets the defaults. The vote cases T1 and T7 (`conformance/vote-cases/`), which `src/conformance/corpus.test.ts` replays on every driver, test it for a token that has no row yet when its creation is voted on. A string is converted to an account first. The supply is the sum of the supply deltas applied. Fields merge as D11 states.
- **Selector.** Main only.
- **Errors.** The formatter throws for an unsupported key type.
- **Tested by**:
  - `genesis.ts: "genesis state reads back"`
  - `confirmed.ts: "token creation, supply and token-account balances"`
  - `confirmed.ts: "set info merges defined keys only"`
- **Upstream.** The wrapper [Keeta TS] index.js:69497-69501; the default-permission and quorum checks [Keeta TS] index.js:69760-69770; `computeLedgerEffect` [Keeta TS] index.js:67222-67231.
- **Postgres.** The account's row in `accounts`, left-joined by ID to `account_info` (`account_info_pkey`) and `supplies` (`supplies_pkey`). A `NULL` column is an absent field, and an account without a row has every field absent. `default_base_permission` and `default_external_permission` are both set or both `NULL`.

### `listOwners`

```ts
listOwners: (transaction: any, identifier: IdentifierAddress, target?: GenericAccount) => Promise<GenericAccount[]>;
```

- **Semantics.** The distinct accounts whose ACL rows on the identifier include `OWNER`. Certificate principals are never owners. With `target`, only rows whose target equals it count. Returns `[]` when there are none.
- Upstream requires exactly one owner to remain. A principal listed twice would be counted twice, and a valid staple refused with `LEDGER_INVALID_OWNER_COUNT` [Keeta TS] index.js:70044-70078. Distinctness is untested: no case stores two `OWNER` rows for one principal.
- **Selector.** Main only.
- **Ordering.** Unspecified.
- **Tested by** `confirmed.ts: "token creation, supply and token-account balances"`, which covers no target, the entity as target, and another target.
- **Postgres.** One statement over the `acls` rows of the identifier's ID (`acls_entity`) with an account principal (`certificate IS NULL`), the given target's ID when there is one, and the `OWNER` bit set in `base_permissions` (section 6.5), returning each principal's public key once. A decoded set that holds `OWNER` also holds `ACCESS`, so the bit alone decides `has(['OWNER'])` [Keeta TS] index.js:74031-74045, 74151-74163. Tested by `src/ledger/storage/postgres/driver.test.ts: "owners are the distinct account principals whose base set holds OWNER, by target when one is given"`, which also covers distinctness.

### `listACLsByPrincipal`

```ts
listACLsByPrincipal: (transaction: any, principal: ACLRow['principal'], entityList?: GenericAccount[]) => Promise<ACLRow[]>;
```

- **Semantics.** The ACL rows of the principal. An account principal matches by public key; a certificate principal matches by certificate hash and holder. With `entityList`, only rows whose entity is in the list are returned, and an empty list gives `[]` (D10). Rows that hold no permission are listed (provisional: confirmed by the live parity checks).
- **Row shape.**
  - `target` is never `null`: an entity-wide row has `target` equal to `entity`.
  - `permissions` is an upstream `Permissions` instance.
  - Rows are unique per principal, entity and target, because `findPermissionMatch` takes the first exact match [Keeta TS] index.js:67109-67132.
- **Selector.** Main only.
- **Ordering.** Unspecified.
- **Tested by**:
  - `confirmed.ts: "modify permissions: add, set, null deletes, entity-wide fallback"`
  - `confirmed.ts: "subtract to empty stores an empty row (entity-wide row does not re-apply)"`
  - `confirmed.ts: "an ACL granted to a certificate this node lacks is rejected"`
  - `confirmed.ts: "a permission set built with a negative external set is stored as the confirmed block carries it"`
  - `genesis.ts: "genesis state reads back"`
  - the three cases in `canaries.ts`
- **Upstream.** The permission check, which passes deduplicated entities [Keeta TS] index.js:69828-69880. `computeLedgerEffect`, which calls it once per principal, possibly with an empty entity list [Keeta TS] index.js:67241-67285.
- **Postgres.** The `acls` rows with the principal's ID and `certificate IS NOT DISTINCT FROM` the certificate hash, which is `NULL` for an account principal, and, with `entityList`, an entity in the list. Served by the `principal_id` prefix of `acls_scope`, unique over (`principal_id`, `certificate`, `entity_id`, `target_id`) with `NULLS NOT DISTINCT`, so an account principal's rows are unique too; `IS NOT DISTINCT FROM` filters the rows that prefix finds. An entity-wide row stores the entity as its target. Permissions are read from the two unbounded integers `base_permissions` and `external_permissions`, which may be negative (D10).

### `listACLsByEntity`

```ts
listACLsByEntity: (transaction: any, entity: GenericAccount, options?: ListACLsByEntityFilters) => Promise<ACLRow[]>;
```

- **Semantics.** Every ACL row on the entity, restricted to `options.principalType` when given. Returns `[]` when there are none. The filter must be honoured: the certificate check throws on a row of the wrong type [Keeta TS] index.js:69771-69779. Rows that hold no permission are listed (provisional: confirmed by the live parity checks).
- **Selector.** Main only.
- **Ordering.** Unspecified.
- **Tested by**:
  - `confirmed.ts: "token creation, supply and token-account balances"`
  - `confirmed.ts: "modify permissions: add, set, null deletes, entity-wide fallback"`
  - `confirmed.ts: "set info merges defined keys only"`
  - `confirmed.ts: "an ACL granted to a certificate this node lacks is rejected"`
  - `confirmed.ts: "subtract to empty stores an empty row (entity-wide row does not re-apply)"`, which lists the empty row
  - `confirmed.ts: "a permission set built with a negative external set is stored as the confirmed block carries it"`
- **Postgres.** The `acls` rows with the entity's ID, through `acls_entity`. The filter is `(certificate IS NOT NULL) = true` for `CERTIFICATE` and `= false` for `ACCOUNT`.

### `adjust`

```ts
adjust: (transaction: any, input: VoteStaple, changes: ComputedEffectOfBlocks) => Promise<VoteStaple[]>;
```

- **Semantics.** Applies a confirmed staple, and every deferred staple that it releases, inside the caller's transaction. `Ledger.add` has already checked the write mode, network, permanence and quorum, and checks nothing else [Keeta TS] index.js:69361-69402. Implemented by the base as a template, run once for the input and once for each replayed waiter:
  1. Refuse a staple that lists a block before its own previous, or whose blocks share a previous (D14).
  2. Run `preAdjust`. It refuses the staple if any block has a main height, and otherwise assigns heights or defers. An empty result returns `[]` [Keeta TS] index.js:67678-67732.
  3. Refuse a staple that would overwrite confirmed history (D14).
  4. Compute the settlement statistics while R's temporary side vote is still readable [Keeta TS] index.js:67593-67632.
  5. Compute the change through upstream's `computeLedgerEffect`, then call `persistConfirmedStaple` and `removeDeferredStaple`.
  6. Replay the staples waiting on the applied blocks, with deferral disabled, within the replay window, each in its own isolated unit (section 3.3, item 4; D13).

  The settlement statistics of every applied staple enter `statsPending` when `adjust` returns, once no unit can still undo the staple. Calls to `adjust` on one transaction run one at a time.
- **Return value.** Each applied staple exactly once: the input first, then replayed staples in the order they applied. `[]` when the input was deferred, or was already deferred. `Ledger.add` folds every returned block into `ledgerChecksum` by XOR, so a staple returned twice would cancel itself out [Keeta TS] index.js:69404-69417.
- **Errors.** All non-retryable:
  - `LEDGER_PREVIOUS_NOT_SEEN` for an out-of-order staple
  - `LEDGER_BLOCK_ALREADY_EXISTS` when any block is already on the main ledger
  - `LEDGER_PREVIOUS_ALREADY_USED` for a fork
  - `LEDGER_IDEMPOTENT_KEY_EXISTS` when another main block holds a key
  - `LEDGER_CERTIFICATE_NOT_FOUND` (D15)
  - `StorageDriverNotInitializedError` before `init`

  Errors of replayed staples are logged, leave none of their writes, and do not fail the call.
- **Tested by** every case of `genesis.ts`, `confirmed.ts` and `deferral.ts`; `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"`; `concurrency.ts: "concurrent adds of one staple apply it once"`; `stats.ts: "a replayed staple that rolls back does not record a settlement time"`.
- **Postgres.** The base's template, over the primitives of section 4.2. The input staple's write runs in the savepoint `persistConfirmedStaple` opens, and each replayed staple in the savepoint of its unit.

### `addPendingVote`

```ts
addPendingVote: (transaction: any, blocksAndVote: VoteStaple) => Promise<void>;
```

- **Semantics.** Stores each vote of the staple on the side ledger with the staple's block list, replacing a stored side vote with the same `$uid`. Upstream passes exactly one vote, which is this node's own. The vote is indexed:
  - by each block it covers
  - by each block's `previous`, including the opening sentinel
  - by its `blocksHash`

  Each block not already on the main ledger gets a side copy, and the block's idempotent key, if any, is claimed on the side. A block already on the main ledger gets neither (untested: voting refuses such a block first). The vote and its indexes land together or not at all. Every driver runs this write with `runIsolatedInTurn` (section 3.3, item 4), so it never lands inside a unit that `adjust` or gc has open on the same transaction.
- No other side vote is removed. A permanent vote is stored beside the temporary vote on the same blocks (D6). The issuer is not checked.
- **Selector.** Writes to the side ledger only.
- **Tested by**:
  - `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`
  - `votes.ts: "a permanent vote with a fee block joins the temporary vote"`
  - `votes.ts: "without a fee block the permanent vote shares its staple with the temporary vote"`
  - `votes.ts: "quote consumes a serial and stores nothing on the side ledger"`
  - `votes.ts: "a pending vote added while a unit that later fails is open survives the unit"`
  - `src/ledger/storage/postgres/driver.test.ts: "pending votes added concurrently on one transaction open their units one at a time"`, for two such votes on one transaction
- Replacement of a stored vote with the same `$uid` is untested.
- **Upstream.** [Keeta TS] index.js:69310-69316, 69342-69354.
- **Postgres.** In one savepoint taken in turn:
  1. Intern the blocks' accounts and the issuer.
  2. Insert each block as a `blocks` row with `ledger = 'side'`, skipping a hash already stored on either ledger (`ON CONFLICT (hash) DO NOTHING`), so a main block keeps its row.
  3. Claim each block's idempotent key with an `idempotent_keys` row with `ledger = 'side'`, only for blocks whose row is a side copy, skipping a claim already stored.
  4. For each vote, delete the side vote with the same `uid` (`votes_side`), insert the vote with `ledger = 'side'`, its validity, its permanence and its bytes, and list its blocks in `vote_blocks` at positions from 0 in vote order.

  The vote is found by block through `vote_blocks_block`, by previous through the covered rows' `previous` (`blocks_previous`), and by `blocksHash` through `votes_side_staple`.

### `getBlock`

```ts
getBlock: (transaction: any, block: BlockHash, from: LedgerSelector) => Promise<Block | null>;
```

- **Semantics.**
  - `'main'`: the confirmed block.
  - `'side'`: the side copy of the block, while at least one unexpired side vote covers it.
  - `'both'`: the main answer, or else the side answer.
  - `null` when absent.

  A block on the main ledger has no side copy: promotion removes it, and `addPendingVote` never creates one. So `'both'` never has two candidates.
- **Tested by**:
  - `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`
  - `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"`
  - `votes.ts: "after expiry a competing vote is allowed"`
  - `confirmed.ts: "map reads return every requested key with null for absent"`
- **Upstream.** The wrapper, which defaults to `'main'` [Keeta TS] index.js:69502-69506; `getBlockFromIdempotent` [Keeta TS] index.js:69717-69724; the staple fallback, which counts a thrown error or a non-block as missing [Keeta TS] index.js:69602-69631.
- **Postgres.** `'main'`: the `blocks` row with the hash and `ledger = 'main'` (`blocks_pkey`). `'side'`: the row with the hash and `ledger = 'side'` for which a `vote_blocks` row (`vote_blocks_block`) names a vote unexpired at the transaction moment.

### `getBlockHeight`

```ts
getBlockHeight: (transaction: any, blockHash: BlockHash, account: GenericAccount) => Promise<bigint | null>;
```

- **Semantics.** The zero-based position of the block on the account's main chain, where the opening block is `0n`. Returns `null` when the hash is unknown, is the opening sentinel, or is on the side ledger only. It also returns `null` when the block is on another account's chain, which is untested.
- Side blocks must have no height. `preAdjust` refuses a staple any of whose blocks has one, so otherwise every staple this node voted on would fail at publish [Keeta TS] index.js:67682-67688.
- **Selector.** Main only (D5).
- **Tested by** `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"` (publish after voting), and through `getAccountsBlockHeightInfo` in `genesis.ts: "genesis state reads back"`.
- **Postgres.** The `chain` row of the hash (`chain_block_hash_key`) whose account is the given account; any other hash has no row.

### `getBlockHeights`

```ts
getBlockHeights: (transaction: any, toFetch: { blockHash: BlockHash; account: GenericAccount; }[]) => Promise<{ [blockHash: string]: bigint | null; }>;
```

- **Semantics.** One entry per distinct block hash, holding `getBlockHeight` of that hash. Implemented by upstream's base class [Keeta TS] index.js:67638-67646. A driver may override it with a batched read that returns the same answer.
- **Tested by** every `add`, through `preAdjust`.
- **Postgres.** Inherited; one `getBlockHeight` read per hash.

### `getAccountsBlockHeightInfo`

```ts
getAccountsBlockHeightInfo: (transaction: any, toFetch: { account: GenericAccount; blockHash?: BlockHash; }[]) => Promise<{ [account: string]: { blockHash: BlockHash; height: bigint | null; } | null; }>;
```

- **Semantics.** One entry per account, keyed by public key. Without a hash, it reads the account's main head: `null` when there is none, otherwise the head's hash and height. With a hash, it returns that hash and `getBlockHeight` of it, which may be `null`. Implemented by upstream's base class [Keeta TS] index.js:67647-67666.
- **Tested by**:
  - `genesis.ts: "genesis state reads back"`
  - `confirmed.ts: "send moves balances and credits the receiver"`
  - `confirmed.ts: "map reads return every requested key with null for absent"`
  - `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`
- **Postgres.** Inherited; reads through `getHeadBlock` and `getBlockHeight`.

### `getVotes`

```ts
getVotes: (transaction: any, block: BlockHash, from: LedgerSelector) => Promise<Vote[] | null>;
```

- **Semantics.**
  - `'main'`: every vote of the confirmed staple that contains the block, or `null` if the block is not on the main ledger.
  - `'side'`: every unexpired side vote that covers the block, from whichever staples hold it, or `null`. A temporary vote on [B] and a permanent vote on [B, FEE] are both returned for B. After publish, R's temporary vote on B is still returned until it expires or gc collects it, although `getBlock(B, 'side')` is then `null`.
  - `'both'`: the main answer, or else the side answer (D7).
- Never `[]`. The staple fallback reads the blocks of the first vote of any non-null answer [Keeta TS] index.js:69576-69580. A main answer always covers one block set.
- **Ordering.** Unspecified.
- **Tested by**:
  - `votes.ts: "getVotes selectors: side returns all live side votes, both prefers main, absent gives null"`
  - `votes.ts: "a permanent vote with a fee block joins the temporary vote"`
  - `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"`
  - `genesis.ts: "genesis state reads back"`
  - `confirmed.ts: "map reads return every requested key with null for absent"`
- **Upstream.** The wrapper [Keeta TS] index.js:69463-69467; the staple fallback [Keeta TS] index.js:69565-69631; settlement statistics with `'side'` [Keeta TS] index.js:67606-67611.
- **Postgres.** `'main'`: the main block's row (`blocks_pkey`), then every `votes` row with `ledger = 'main'` and `blocks_hash` equal to the block's staple (`votes_main`), in row ID order, which is the staple's vote order. `'side'`: the votes unexpired at the transaction moment that a `vote_blocks` row of the block names (`vote_blocks_block`), in row ID order.

### `getVotesFromPrevious`

```ts
getVotesFromPrevious: (transaction: any, block: BlockHash, from: LedgerSelector) => Promise<Vote[] | null>;
```

- **Semantics.** `getVotesFromMultiplePrevious` for one hash, with a missing entry read as `null`. Implemented by upstream's base class, which also forwards an optional `issuer` that the interface typing omits [Keeta TS] index.js:67844-67851. No upstream code calls it.
- Untested.
- **Postgres.** Inherited; reads through `getVotesFromMultiplePrevious`.

### `getVotesFromMultiplePrevious`

```ts
getVotesFromMultiplePrevious: (transaction: any, prevBlocks: BlockHash[], from: LedgerSelector, issuer?: Account) => Promise<{ [hash: string]: Vote[] | null; }>;
```

- **Semantics.** For each requested hash p, keyed by p in uppercase hex:
  - `'main'`: the votes of the confirmed staple that holds p's main successor, restricted to `issuer` when given. `null` when p has no main successor, or when no vote matches.
  - `'side'`: the unexpired side votes covering a block whose `previous` is p, restricted to `issuer`, or `null`.
  - `'both'`: for each p separately, the main answer, or else the side answer.

  p may be an opening sentinel. One vote may appear under several keys when its blocks chain.
- **Why expired votes are excluded.** The answer is the equivocation guard of `vote`. A non-empty answer permits a vote only when it holds exactly one vote, the vote is this node's and temporary, and the request is for a permanent vote [Keeta TS] index.js:69281-69306. An expired vote left in the answer would block the account until gc ran.
- **Why main-wins never changes a vote decision.** Every main vote is permanent [Keeta TS] index.js:69388-69395, and `vote` always passes its own key as `issuer`. A non-null main answer therefore holds only this node's permanent votes, and it refuses the request whatever a side answer would add: a single permanent vote may not be replaced, and two or more votes exceed the limit [Keeta TS] index.js:69288-69305. When the main answer is `null`, `'both'` returns the side answer, which is what a union would return. The proof needs `'main'` to answer `null`, not `[]`, when the successor's staple holds no vote of `issuer`.
- Under `'both'`, the main answer hides this node's unexpired side vote on a competitor of p's main successor from API reads, until gc collects it (provisional: confirmed by the live parity checks).
- **Tested by**:
  - `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`
  - `votes.ts: "a permanent vote with a fee block joins the temporary vote"`
  - `votes.ts: "a competing vote is refused while our temporary vote is live"`
  - `votes.ts: "after expiry a competing vote is allowed"`
  - `confirmed.ts: "map reads return every requested key with null for absent"`
  - `concurrency.ts: "concurrent competing votes produce exactly one temporary vote"`
  - `concurrency.ts: "a vote admitted late still sees a competing vote committed meanwhile"`
  - `confirmed.ts: "successor votes filtered to a representative outside the confirming quorum are null"`, for the `null` premise above

  Untested: `'both'` when main and side both answer for one p.
- **Upstream.** The wrapper [Keeta TS] index.js:69468-69472.
- **Postgres.** `'main'`: for each listed previous, the main successor (`blocks_main_successor`) and the `votes` rows of its staple with `ledger = 'main'` (`votes_main`), restricted to the issuer's public key when given. `'side'`: the votes unexpired at the transaction moment, restricted to the issuer, that a `vote_blocks` row names for a block whose `previous` is listed (`blocks_previous`), each vote once per previous. The covered block may be on either ledger: a vote whose block has since moved to main still guards its previous until gc collects it. Both answers list votes in row ID order and group them by previous in the process.

### `getVoteStaples`

```ts
getVoteStaples: (transaction: any, voteBlockHashes: VoteBlockHash[], from: LedgerSelector) => Promise<VoteBlockHashMap<VoteStaple | null>>;
```

- **Semantics.** A `VoteBlockHashMap` with an entry for every requested `blocksHash`:
  - `'main'`: the confirmed staple, with its blocks in staple order and every stored vote.
  - `'side'`: a staple built from the unexpired side votes with that `blocksHash` and the block list stored with them. If any of those votes is permanent, only the permanent ones are used [Keeta TS] index.js:80795-80827. `null` when none is unexpired.
  - `'both'`: for each key, the main answer, or else the side answer.
- Upstream never passes an empty list or more than 10,000 hashes [Keeta TS] index.js:69521-69531. A missing entry is an internal error to upstream, and a `null` entry is an internal error to history [Keeta TS] index.js:69512-69520, 69540-69548.
- **Tested by**:
  - `confirmed.ts: "map reads return every requested key with null for absent"`
  - `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`
  - `votes.ts: "without a fee block the permanent vote shares its staple with the temporary vote"`
  - `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"`
  - `gc.ts: "gc removes side votes whose blocks were all confirmed under another staple"`

  Untested: `'both'` when the main ledger and an unexpired side vote both hold one `blocksHash`.
- **Postgres.** `'main'`: the staple's blocks by `staple` in `staple_position` order (`blocks_staple_order`), and its main votes by `blocks_hash` in row ID order (`votes_main`). `'side'`: the votes with the `blocksHash` unexpired at the transaction moment (`votes_side_staple`), in row ID order; the permanent ones when there are any, otherwise all of them. The blocks are those that `vote_blocks` lists for the lowest-ID chosen vote, in position order.

### `getHistory`

```ts
getHistory: (transaction: any, account: GenericAccount | null, start: VoteBlockHash | null, limit?: number) => Promise<VoteBlockHash[]>;
```

- **Semantics.** The `blocksHash` of each main staple that touched the account, or of every main staple when `account` is `null`. A staple touches every account in the effects' `touched` set (D18). At most `limit` entries are returned; upstream always passes a number, and the default is 25 [Keeta TS] index.js:69532. Every returned hash must resolve through `getVoteStaples(..., 'main')` [Keeta TS] index.js:69540-69548.
- **Ordering and paging.** Newest first in history order (D8):
  - The key is the ordered pair (staple time, `blocksHash`), descending (provisional: confirmed by the live parity checks). The staple time is `VoteStaple.timestamp()` with no argument, as an integer count of milliseconds since the Unix epoch [Keeta TS] index.js:81070-81096, and `blocksHash` is compared as unsigned bytes.
  - `start` is exclusive.
  - A `start` that is unknown, or not in the listed history, gives `[]`.
- **Selector.** Main only.
- **Tested by**:
  - `confirmed.ts: "history lists the staple for every touched account, newest first, exclusive start, unknown start empty"`
  - `confirmed.ts: "history orders staples by staple time, not by when they were applied"`
  - `confirmed.ts: "history breaks staple-time ties by blocks hash, descending, and pages across a tie"`
  - `confirmed.ts: "history orders by the mean vote time of a staple, not the earliest or any single representative's"`
  - `concurrency.ts: "concurrent adds of one staple apply it once"`
- **Postgres.** The history key is stored with each row: `staple_time` (`timestamptz`, holding the staple time's whole milliseconds exactly) and `blocks_hash` (`bytea`, which compares as unsigned bytes). With an account: its `history` rows, `ORDER BY staple_time DESC, blocks_hash DESC LIMIT limit`, through `history_order` (`account_id`, `staple_time DESC`, `blocks_hash DESC`). With `start`: the start's `staple_time` is first looked up in the same account's history (`history_pkey`), and the page continues below it by row comparison, `(staple_time, blocks_hash) < (start time, start)`, so the index range begins at the start. A start not in that history leaves its time `NULL`, the comparison is never true, and the page is empty. With `account` `null`, the same over `staples` through `staples_history` (`staple_time DESC`, `blocks_hash DESC`), with the start looked up through `staples_pkey`. Another implementation must reproduce the key, the strict comparison and the empty page exactly.

### `getHeadBlocks`

```ts
getHeadBlocks: (transaction: any, accounts: GenericAccount[], from: LedgerSelector) => Promise<{ [account: string]: Block | null; }>;
```

- **Semantics.** For each account, keyed by public key:
  - `'main'` and `'both'`: the highest block of its main chain, or `null` when it has none.
  - `'side'`: `null` for every account (D5).

  A side block is never a head. The permanent vote's head check reads `'both'`, and a side head would refuse every permanent vote [Keeta TS] index.js:67667-67677, 69260-69276.
- **Tested by**:
  - `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`
  - `confirmed.ts: "map reads return every requested key with null for absent"`
  - `src/ledger/storage/suite-meta.test.ts: "the vote lifecycle cases catch heads that count side blocks"`
- **Postgres.** The `heads` row of each account (`heads_pkey`), joined to the head block's `blocks` row. Only `persistConfirmedStaple` writes `heads`, so side blocks never appear.

### `getHeadBlockHashes`

```ts
getHeadBlockHashes: (transaction: any, accounts: InstanceType<typeof Account.Set>) => Promise<{ [account: string]: BlockHash | null; }>;
```

- **Semantics.** The hashes of `getHeadBlocks(..., 'both')`. Implemented by upstream's base class [Keeta TS] index.js:67667-67677. Its only caller is the head check of `vote`.
- **Tested by** every case in `votes.ts`.
- **Postgres.** Inherited; reads through `getHeadBlocks`.

### `getHeadBlock`

```ts
getHeadBlock: (transaction: any, account: GenericAccount, from: LedgerSelector) => Promise<Block | null>;
```

- **Semantics.** `getHeadBlocks` for one account, with a missing entry read as `null`. Implemented by upstream's base class [Keeta TS] index.js:67836-67843.
- **Tested by** `genesis.ts: "genesis state reads back"` and `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`.
- **Postgres.** Inherited; reads through `getHeadBlocks`.

### `getBlockFromPrevious`

```ts
getBlockFromPrevious: (transaction: any, block: BlockHash, from: LedgerSelector) => Promise<Block | null>;
```

- **Semantics.** The block whose `previous` is the given hash. The hash may be an opening sentinel.
  - `'main'`: the unique confirmed successor.
  - `'side'`: of the side blocks whose `previous` matches and which an unexpired side vote covers, the one whose covering vote has the latest `validityFrom`, and of equals the one with the greater hash. When a vote is issued its block is the only such block, because voting refuses a competing successor until this node's vote on another expires. A transaction with a stale moment can still see an expired vote's block beside the block voted on after that vote expired, and the later vote names the current successor. No decision reads the side answer: upstream calls the member only from its public wrappers [Keeta TS] index.js:69482-69486, 70466-70470, and the base calls it only with `'main'`.
  - `'both'`: the main answer, or else the side answer.
  - `null` when absent.

  The upstream wrapper gives `from` no default [Keeta TS] index.js:69473-69477.
- **Tested by**:
  - `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`
  - `votes.ts: "after expiry a competing vote is allowed"`
  - `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"`
  - `confirmed.ts: "send moves balances and credits the receiver"`
  - `confirmed.ts: "fork in confirmed history is rejected with LEDGER_PREVIOUS_ALREADY_USED"`
  - `votes.ts: "a stale moment that sees two pending successors reads the newer one"`

  Untested: `'both'` when a main successor and an unexpired side successor coexist, and the tie between two votes issued in the same millisecond.
- **Postgres.** `'main'`: the row with the previous and `ledger = 'main'`, through `blocks_main_successor`, a unique index on `previous` over main rows only. `'side'`: the side rows with the previous (`blocks_previous`) joined through `vote_blocks` to votes unexpired at the transaction moment, `ORDER BY votes.validity_from DESC, blocks.hash DESC LIMIT 1`.

### `getAccountRep`

```ts
getAccountRep: (transaction: any, account: GenericAccount | string) => Promise<Account | null>;
```

- **Semantics.** The account's stored representative, or `null` when it never set one. A string is converted to an account first. Upstream calls it only for account types that can delegate [Keeta TS] index.js:69488-69496.
- **Selector.** Main only.
- **Tested by** `genesis.ts: "genesis state reads back"`, `confirmed.ts: "set representative moves weight"` and `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`.
- **Upstream.** `computeLedgerEffect` [Keeta TS] index.js:67210-67220.
- **Postgres.** The `delegations` row of the account's ID (`delegations_pkey`), joined to the representative's public key.

### `getVotesAfter`

```ts
getVotesAfter: (transaction: any, moment: Date, startKey?: string, options?: GetVotesAfterOptions) => Promise<PaginatedVotes>;
```

- **Semantics.** The votes of main staples confirmed at or after `moment`, page by page (D8, catch-up order). The confirmation moment is the transaction moment of the transaction that applied the staple. `options.bloomFilter` and `options.timeout` may be ignored.
- **Ordering and paging.**
  - Staples ascend in confirmation order: moment, then the node-local sequence.
  - A page ends only between staples, so a page may exceed `maxVotesPerPage`, and always holds at least one whole staple when any remains. The default page size is 200, the largest upstream requests.
  - `nextKey` is an opaque string that resumes after the page's last staple. It is omitted on the last page, because upstream's loop stops only when it is `undefined` [Keeta TS] index.js:69695-69699.
  - The key is used only within one read transaction.
- **Selector.** Main only.
- **Errors.** A malformed `startKey` throws, which `evaluateError` turns into `LEDGER_OTHER`. Untested.
- **Tested by** `confirmed.ts: "getVotesAfter pages on staple boundaries"`, which also runs upstream's `getVoteStaplesAfter` loop over the pages.
- **Upstream.** [Keeta TS] index.js:69633-69702. The moment comparison is "on or after" [Keeta TS] index.js:69659-69666.
- **Postgres.** `staples` with `moment >= $moment`, `ORDER BY moment, sequence`, through `staples_catch_up` (`moment`, `sequence`); a page after a key continues with `(moment, sequence) > (key)`. `sequence` is an identity column, so it is node-local and never reused. The query fetches `max(maxVotesPerPage, 1) + 1` staples with their main vote counts; the page takes staples until it holds `maxVotesPerPage` votes, and at least one staple, and the key of its last staple is returned only when a fetched staple was left over. Votes are read by `blocks_hash` (`votes_main`) in row ID order. The key is the last staple's moment in milliseconds and its sequence, in decimal, joined by `:` (`src/ledger/storage/paging.ts`).

### `getVoteStaplesFromBlockHash`

```ts
getVoteStaplesFromBlockHash?: (transaction: any, blocks: BlockHash[], from: LedgerSelector) => Promise<VoteStaple[]>;
```

- **Semantics.** Optional, and implemented by no driver here. When present, it replaces upstream's fallback [Keeta TS] index.js:69559-69564, and must return what the fallback returns [Keeta TS] index.js:69565-69631:
  - the distinct, complete main staples containing the given blocks
  - in order of first appearance
  - skipping hashes with no main votes, and staples with a block that is not on the main ledger

  Upstream always passes `'main'`.
- Untested. The fallback, over `getVotes` and `getBlock`, is exercised by `confirmed.ts: "getVotesAfter pages on staple boundaries"`.
- **Postgres.** Not implemented; upstream's fallback runs.

### `cache`

```ts
cache?: (transaction: any) => LedgerRequestCache | undefined;
```

- **Semantics.** Optional, and implemented by no driver here. Upstream stores the returned cache on its atomic interface and never reads it [Keeta TS] index.js:68990-68999. If a driver provides one, it must be scoped to one transaction: a `Vote` is checked for expiry only when constructed, so a cache that outlived its transaction could serve an expired vote.
- Untested.
- **Postgres.** Not implemented.

### `gc`

```ts
gc: (transaction: any, timeLimitMS?: number) => Promise<boolean>;
```

- **Semantics.** Upstream's loop, inherited unchanged. It calls `gcBatch` until a batch reports that no work remains, in which case it returns `false`, or until `timeLimitMS` (default 280000 ms) has elapsed, in which case it returns the last batch's answer [Keeta TS] index.js:67852-67862. The base implements `gcBatch` as D20 states. The whole loop runs in one transaction [Keeta TS] index.js:70517-70521. Correctness never depends on gc having run.
- **Time limit.** A caller should pass a small `timeLimitMS`, a few seconds, and call `gc` again while it returns `true`. With the default, one call can hold one read-write transaction open for up to 280 s. On a driver with real concurrency that transaction conflicts with every vote and add that touches what it collects, and a serialization failure late in it rolls back all of its batches, which `Ledger.run` may not retry once its 5 s budget has passed [Keeta TS] index.js:70294-70389. A small limit keeps each transaction to a few batches, and the work done before a failure committed.
- **Tested by** every case in `gc.ts`.
- **Postgres.** Inherited loop, over the batch primitives of section 4.2.

### `getNextSerialNumber`

```ts
getNextSerialNumber: (transaction?: any) => Promise<bigint>;
```

- **Semantics.** Section 3.6 (D16). The transaction argument is optional. The memory driver ignores it.
- **Tested by** the cases listed in section 3.6.
- **Postgres.** `nextval('vote_serials')`, on the given transaction's connection when there is one (section 3.6).

### `getAccountCertificates`

```ts
getAccountCertificates: (transaction: any, account: GenericAccount) => Promise<CertificateWithIntermediates[]>;
```

- **Semantics.** Every certificate the account holds, whether or not it is currently valid, as `{ certificate, intermediates }` with `intermediates` `null` when none were given. Returns `[]` when there are none. Callers check validity themselves [Keeta TS] index.js:69787-69810.
- **Selector.** Main only.
- **Ordering.** Unspecified.
- **Tested by** `confirmed.ts: "certificates add and remove"`, `confirmed.ts: "an expired certificate is still read back"` and, for stored intermediates, `confirmed.ts: "a certificate is read back with its intermediates"`.
- **Postgres.** The `certificates` rows of the account's ID, through the `account_id` prefix of `certificates_pkey`. The DER bytes and the intermediates bundle are stored as given; the validity period is never checked.

### `getAccountCertificateByHash`

```ts
getAccountCertificateByHash: (transaction: any, account: GenericAccount, hash: CertificateHash) => Promise<CertificateWithIntermediates | null>;
```

- **Semantics.** The certificate with this hash that the account holds, or `null`. A `null` answer during `adjust` makes `computeLedgerEffect` refuse an ACL granted to that certificate with `LEDGER_CERTIFICATE_NOT_FOUND` (D15) [Keeta TS] index.js:67233-67239, 67456-67460.
- **Selector.** Main only.
- **Tested by** `confirmed.ts: "certificates add and remove"`, `confirmed.ts: "an expired certificate is still read back"`, `confirmed.ts: "a certificate is read back with its intermediates"` and `confirmed.ts: "an ACL granted to a certificate this node lacks is rejected"`.
- **Postgres.** The `certificates` row with the account's ID and the hash, through `certificates_pkey` (`account_id`, `hash`).

### `getIdempotentBlockHash`

```ts
getIdempotentBlockHash: (transaction: any, idempotent: IdempotentKey, from: LedgerSelector, excludeBlockHash?: BlockHash) => Promise<BlockHash | null>;
```

- **Semantics.** The hash of a block other than `excludeBlockHash` that holds the key (D12):
  - `'main'`: the main block holding the key. `null` when there is none, or when it is the excluded block.
  - `'side'`: a side block that claims the key, is covered by an unexpired side vote, and is not the excluded block. Otherwise `null`.
  - `'both'`: the main answer, or else the side answer. Each is computed with the exclusion applied.

  `vote` excludes each block's own hash, so a permanent vote can follow the temporary vote that claimed the key on the side [Keeta TS] index.js:69254-69259.
- **Tested by**:
  - `confirmed.ts: "idempotent keys resolve on main"`
  - `votes.ts: "side idempotent keys are visible under both and lose to main"`
  - `gc.ts: "gc removes expired side votes and their unreferenced blocks but keeps permanent ones"`
- **Upstream.** The wrappers, which default to `'both'` [Keeta TS] index.js:69711-69724.
- **Postgres.** A key is stored as the 32 bytes its uppercase hex spells. `'main'`: the `idempotent_keys` row with the key and `ledger = 'main'`, through `idempotent_keys_main`, a unique index on `key` over main rows only, when its block `IS DISTINCT FROM` the excluded one. `'side'`: of the side claims of the key (`idempotent_keys_pkey`) whose block is a side copy that a vote unexpired at the transaction moment covers, other than the excluded block, the lowest block hash.

### `stats`

```ts
stats: () => Promise<LedgerStatistics>;
```

- **Semantics.** Implemented by the base over the driver's `countLedger` (section 4.2). It takes no transaction, and `Ledger.stats` calls it without one and without retries [Keeta TS] index.js:70537-70551. The field definitions are in D19.
- `ledger.node` is read from the ledger passed to `init`. After `Ledger.copy`, which shares the driver, `stats` still reports the original ledger's node. Untested.
- **Tested by** `stats.ts: "stats returns the upstream shape with counts that follow the staples added"`, `stats.ts: "stats reads settlement times and retries from the node"` and `stats.ts: "a replayed staple that rolls back does not record a settlement time"`.
- **Postgres.** The base's, over `countLedger`.

### 4.1 Members inherited from upstream's base class

`LedgerStorageDriverBase` extends upstream's `LedgerStorageBase`. These members come from it unchanged:

- `getBlockHeights`
- `getAccountsBlockHeightInfo`
- `getHeadBlockHashes`
- `getHeadBlock`
- `getVotesFromPrevious`
- `gc`
- `preAdjust`
- `_formatAccountInfoFromRow`

The base implements `init`, `adjust`, `evaluateError` and `stats`, plus upstream's protected `adjustDefer` and `gcBatch`. A driver implements every other member, and the primitives of 4.2. Each is declared `abstract`, so a driver that omits one does not compile.

### 4.2 Driver primitives

`LedgerStorageDriverBase` calls these protected methods. Each except `countLedger` takes the driver's transaction first, and must take part in that transaction like any member.

#### `persistConfirmedStaple`

```ts
protected abstract persistConfirmedStaple(transaction: Transaction, change: ConfirmedStapleChange): Promise<void>;
```

Writes everything that one confirmed staple changes, all of it or none of it (section 3.3, item 4). `change` is computed before any write (`src/ledger/storage/confirmed.ts`), and its fields are written as follows.

- **`staple`, `blockHeights`, `moment`.**
  - Store the staple under its `blocksHash`, with its block order and every vote keyed by `$uid`. Votes are kept per staple: a vote stored once globally could be overwritten by an equivocating representative's vote with the same `$uid`.
  - Stamp the staple with `moment` and a node-local sequence number that is never reused.
  - Store the staple with its history key: its staple time and its `blocksHash` (D8).
  - Store each block with its height, record it as the successor of its `previous` (opening sentinel included), and make it the account's head when its height exceeds the current head's.
  - Refuse a block already on the main ledger with `LEDGER_BLOCK_ALREADY_EXISTS`.
  - Refuse a block whose `previous` already has a successor with the error from `confirmedHistoryConflict`, which logs the conflict as a network integrity alarm.

  `adjust` checks both conditions earlier, but the write must not depend on that check (D14). Tested by `confirmed.ts: "persisting never overwrites a confirmed block or successor"`, which reaches the primitive through the base's key-gated test hook, so every driver in the suite runs it.
- **`ledgerEffect.balances`.** Add each non-zero `change` to the stored balance of the account and token, creating the row at `0n`. Never clamp the result.
- **`ledgerEffect.supplies`.** Add each `change` to the token's stored supply.
- **`ledgerEffect.weights`.** Add each `change` to the representative's stored weight.
- **`delegations`.** Set the account's representative.
- **`ledgerEffect.permissions`.** Each update is already resolved against the stored row. The row is identified by principal, entity and target, where a missing target means the entity itself. A `null` permission deletes the row. Any other permission stores the row with exactly those flags, even when they are empty (D10). An update whose method is not SET is an internal error.
- **`infoUpdates`.** Merge into the stored info. A present field replaces the stored one, and an absent field keeps it (D11). `defaultPermission` is stored as its base and external sets. `multisigQuorum: null` clears the quorum.
- **`certificateUpdates`.** ADD stores the certificate and its intermediates under the holder and hash. SUBTRACT deletes them.
- **`idempotentKeys`.** Store each key with its block hash. Refuse with `LEDGER_IDEMPOTENT_KEY_EXISTS` when a different block holds the key, either on the main ledger or earlier in the same change (D12). Both are tested by `confirmed.ts: "idempotent keys resolve on main"`; a refusal during replay by `deferral.ts: "a replayed staple whose idempotent key is taken stays deferred while its trigger applies"`.
- **`historyAccounts`, `newAccounts`.** Append the staple to the history of every account in `historyAccounts`. Create an account row for every account in either set (D18).
- **Promotion.** In the same write:
  - Remove the side copies of the staple's votes, matched by `$uid`.
  - Remove the side copies of the staple's blocks, and their side idempotent claims.

  Every other side vote stays, including this node's temporary vote on these blocks and its votes on competing blocks (D6).

  No side row may outlive its promotion: a side block that is also on the main ledger, and its side idempotent claims, are leaks even while a side vote still covers them. Tested by `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"`, `votes.ts: "publishing a voted block that holds an idempotent key leaves no orphaned side rows"` and `deferral.ts: "a replayed staple that promotes a voted block and then fails keeps its side rows, and applies when it arrives again"` and `deferral.ts: "a staple released by replay promotes a block this node voted on and leaves no side rows"`, each through `countOrphanedSideRows`. A replayed staple is written by the same primitive as any other, so promotion has no separate replay path.

**Postgres.** In a savepoint of its own, in this order:
1. Refuse a key that `idempotent_keys_main` gives to a different block, or that an earlier block of the change claims.
2. Refuse a block already on main (`blocks_pkey`) or whose previous has a main successor (`blocks_main_successor`), as section D14 states.
3. Intern every account the change names, in public-key order, inserting missing rows and skipping existing ones.
4. Insert the `staples` row: `blocks_hash`, `staple_time` (`VoteStaple.timestamp()`), `moment` (`change.moment`) and the next `sequence`.
5. Insert the blocks as main rows with their staple and position. A side copy is turned into the main row in place (`ON CONFLICT (hash) DO UPDATE ... WHERE ledger = 'side'`); a hash already on main returns no row, and fewer rows than blocks is `LEDGER_BLOCK_ALREADY_EXISTS`. Delete the blocks' side claims, insert their `chain` rows, and raise each account's `heads` row only when the new height is greater.
6. Delete side votes with the staple's `uid`s, then insert the staple's votes with `ledger = 'main'` in staple order.
7. Add each balance, supply and weight delta to its row, creating it at the delta (`ON CONFLICT ... DO UPDATE SET x = x + delta`); never clamp.
8. Upsert delegations; delete or upsert ACL rows by `acls_scope`; merge account info with `COALESCE`, clearing the quorum only when the update carries it as `null`; add or delete certificates; insert the main idempotent keys.
9. Set `first_staple` on accounts that have none, and insert one `history` row per touched account with the staple's time.

The unique indexes back the checks of steps 1 and 2 against another process: `blocks_main_successor` admits one confirmed successor per previous, and `idempotent_keys_main` one main block per key.

#### `runIsolated`

```ts
protected runIsolated<Result>(transaction: Transaction, unit: () => Promise<Result>): Promise<Result>;
```

Runs `unit` so that its writes join the transaction if it succeeds, and none of them remain if it throws, after which the transaction carries on as it was before the unit. Units nest, and the base never runs two at once on one transaction. The base's default calls `unit` and adds no isolation. Every driver whose writes can fail part-way through a unit must override it. The memory driver opens a nested overlay, and a database driver uses a savepoint (section 3.3, item 4). Tested by `deferral.ts: "a replayed staple that fails after its write leaves nothing behind and stays deferred"`, `deferral.ts: "a replayed staple that promotes a voted block and then fails keeps its side rows, and applies when it arrives again"` and `gc.ts: "a gc retry that fails after its write leaves nothing behind and stays deferred"`.

**Postgres.** `SAVEPOINT unit_<depth>`, then `RELEASE SAVEPOINT` on success, or `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT` on failure (section 3.3).

#### `runIsolatedInTurn`

```ts
protected runIsolatedInTurn<Result>(transaction: Transaction, unit: () => Promise<Result>): Promise<Result>;
```

Provided by the base, not implemented by drivers. Runs `unit` as `runIsolated` does, after the work the base has already queued on the transaction (`adjust`, gc, replayed staples). A member that upstream may call on a transaction while `adjust` is running uses it, so units of one transaction never overlap. It must not be called from work the base has queued, which would wait for itself. `addPendingVote` is its only caller. Tested by `votes.ts: "a pending vote added while a unit that later fails is open survives the unit"`, which opens the unit through the base's key-gated test hook, and by `src/ledger/storage/postgres/driver.test.ts: "pending votes added concurrently on one transaction open their units one at a time"`.

**Postgres.** The base's; the driver's savepoints never overlap because of it.

#### `storeDeferredStaple`

```ts
protected abstract storeDeferredStaple(transaction: Transaction, staple: VoteStaple, waitingOn: readonly BlockHash[]): Promise<void>;
```

Stores a staple that waits on the listed missing previous blocks, replacing an earlier entry with the same `blocksHash` and its index, so a staple added again while it waits is stored once. Several staples may wait on one block, because the index is keyed by the pair of awaited block and staple (D13). The base's `adjustDefer` computes `waitingOn` from `getBlockHeights`: it lists the previous blocks outside the staple that have no main height. It refuses an empty list, because no arrival could ever release such a staple. Tested by every case in `deferral.ts`, including `deferral.ts: "a deferred staple added again stays deferred once"`.

**Postgres.** Deletes the staple's `deferred_staples` row, which removes its waits and recorded previous blocks with it, then inserts the staple's bytes with `latest_vote_from`, the latest `validityFrom` among its votes; a `deferred_waits` row (`block_hash`, `blocks_hash`) per awaited block; and a `deferred_blocks` row per distinct previous of its blocks. A stored staple is decoded as of `latest_vote_from`, at which every one of its votes is valid, whatever the wall clock reads.

#### `listDeferredStaplesWaitingOn`

```ts
protected abstract listDeferredStaplesWaitingOn(transaction: Transaction, blockHashes: readonly BlockHash[]): Promise<readonly VoteStaple[]>;
```

Lists the deferred staples waiting on any of the given blocks, each once. Order is unspecified, so when two waiters conflict, which one applies is undefined. Tested by `deferral.ts: "deferred chains replay in order exactly once"` and `deferral.ts: "a replayed staple that conflicts stays deferred while its trigger applies"`.

**Postgres.** The `deferred_staples` rows named by a `deferred_waits` row of any listed block (`deferred_waits_pkey`), each once, in `blocks_hash` order.

#### `removeDeferredStaple`

```ts
protected abstract removeDeferredStaple(transaction: Transaction, blocksHash: StapleKey): Promise<void>;
```

Forgets a deferred staple and its index entries. A staple that is not deferred is not an error. The base calls it after every successful persist, so a staple that arrives again on its own after deferral stops waiting. Tested by `deferral.ts: "a deferred staple applied on its own stops waiting"`.

**Postgres.** Deletes the `deferred_staples` row; its `deferred_waits` and `deferred_blocks` rows go with it (`ON DELETE CASCADE`).

#### `collectDeadDeferredStaples`

```ts
protected abstract collectDeadDeferredStaples(transaction: Transaction, limit: number): Promise<CollectedDeferredStaples>;
```

Removes up to `limit` deferred staples that can never apply, with their index entries, and returns them as `collected`, with `more` reporting whether more such staples remain. A deferred staple can never apply once the `previous` of any of its blocks has a confirmed successor: the block itself is on the main ledger, or it competes with a block that is. This is the rule of D6, and it applies whether or not the staple still waits on a missing block. The base logs each collected staple once (D20). Tested by `gc.ts: "gc drops deferred staples that can never apply and reports each once"`, `gc.ts: "gc reports whether more work remains"` and `gc.ts: "a deferred staple that is not dead survives gc and a partial release, then applies"`, where a staple is kept while this node has only a pending vote on one of its blocks and only one of its two awaited blocks has arrived.

**Postgres.** The deferred staples, in `blocks_hash` order (`deferred_staples_pkey`), with a `deferred_blocks` row (`deferred_blocks_pkey`, by its `blocks_hash` prefix) whose `previous` has a main successor (`blocks_main_successor`), `ORDER BY blocks_hash LIMIT limit + 1`. The first `limit` are deleted and returned, and `more` is whether a further row was found. A staple that also still waits on a missing block is dead all the same.

#### `listReleasedDeferredStaples`

```ts
protected abstract listReleasedDeferredStaples(transaction: Transaction, limit: number, exclude: ReadonlySet<StapleKey>): Promise<readonly VoteStaple[]>;
```

Lists up to `limit` deferred staples, other than those in `exclude`, whose awaited blocks are now all on the main ledger. These are staples that replay missed, because the window elapsed or the replay failed. `limit` and `exclude` let a driver bound the read in storage. Tested by `gc.ts: "gc retries deferred staples whose previous is now on main"`, `gc.ts: "gc counts a deferred chain its retry releases in the checksum"` and `gc.ts: "gc reports whether more work remains"`.

**Postgres.** The deferred staples outside `exclude` that have no `deferred_waits` row whose block lacks a main row, `ORDER BY blocks_hash LIMIT limit`.

#### `collectObsoleteSideVotes`

```ts
protected abstract collectObsoleteSideVotes(transaction: Transaction, limit: number): Promise<boolean>;
```

Removes up to `limit` obsolete side votes, then the side blocks and side idempotent claims that no remaining side vote covers. Reports whether more obsolete votes remain. A side vote is obsolete when either holds (D6):
- it has expired at the transaction moment, judged by the expiry bound alone (D4)
- the `previous` of any block it covers has a confirmed successor: the block itself is on the main ledger, or it competes with a block that is, and either way its staple can never be added. A pending or deferred competitor is not a confirmed successor, and must not make the vote obsolete: the vote still guards its previous, and removing it would let the node sign a third competitor

Main rows, and side blocks still covered by another side vote, are never touched (D20).

Tested by:
- `gc.ts: "gc removes expired side votes and their unreferenced blocks but keeps permanent ones"`
- `gc.ts: "gc removes side votes whose blocks were all confirmed under another staple"`
- `gc.ts: "gc removes side votes whose staple can no longer be published"`
- `gc.ts: "gc removes our votes on a competitor of a confirmed block and frees its idempotent key"`
- `gc.ts: "gc keeps our permanent vote when an expired vote of ours on a competitor remains"`
- `gc.ts: "gc keeps our permanent vote when a deferred staple holds a competitor"`
- `gc.ts: "gc reports whether more work remains"`
- `concurrency.ts: "gc admitted late keeps a vote committed meanwhile"`

No read can observe a side block that no vote covers any more, because side reads require an unexpired vote, so only a count of such rows shows whether it was removed. `countOrphanedSideRows` provides that count, and the first four cases above assert that it is 0 afterwards.

**Postgres.** The side votes that are not unexpired at the transaction moment, or for which a `vote_blocks` row names a block whose `previous` has a main row (`blocks_main_successor`), the covered block itself included, `ORDER BY id LIMIT limit + 1`. The first `limit` are deleted with their `vote_blocks` rows (`ON DELETE CASCADE`). Then, among the blocks they covered, the side claims and the side blocks that no `vote_blocks` row names any more are deleted (`vote_blocks_block`). A vote that has expired but is not yet collected still has its `vote_blocks` rows, so it keeps its blocks until it is collected itself.

#### `countOrphanedSideRows`

```ts
protected abstract countOrphanedSideRows(transaction: Transaction): Promise<number>;
```

Counts the side rows that no side vote accounts for. Only the base's key-gated test hook reads it. A row is counted once for each of these:
- a side block that no side vote covers
- a side block that is also on the main ledger
- a side idempotent claim whose block is not a side block covered by a side vote

A vote that has expired but is not yet collected still covers its blocks, so it is not counted. A healthy store reports 0 after every member, and gc brings it back to 0. Tested by every case that asserts the count: `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"`, `votes.ts: "publishing a voted block that holds an idempotent key leaves no orphaned side rows"`, `deferral.ts: "a replayed staple that promotes a voted block and then fails keeps its side rows, and applies when it arrives again"`, `deferral.ts: "a staple released by replay promotes a block this node voted on and leaves no side rows"`, `gc.ts: "gc removes expired side votes and their unreferenced blocks but keeps permanent ones"`, `gc.ts: "gc removes side votes whose blocks were all confirmed under another staple"`, `gc.ts: "gc removes side votes whose staple can no longer be published"` and `gc.ts: "gc removes our votes on a competitor of a confirmed block and frees its idempotent key"`.

**Postgres.** One count: side `blocks` rows that no `vote_blocks` row names, plus side `idempotent_keys` rows whose block is not a side row named by a `vote_blocks` row. A block is one row on one ledger (`blocks_pkey`), so a side block that is also on the main ledger cannot be stored at all.

#### `countLedger`

```ts
protected abstract countLedger(): Promise<LedgerCountsSnapshot>;
```

Returns the counts `stats` reports, taken from one consistent view of the committed main ledger. Also returns the moment that view describes, and `momentRange`: the number of milliseconds either side of that moment the view may come from. Definitions in D19. Tested by `stats.ts: "stats returns the upstream shape with counts that follow the staples added"`.

**Postgres.** One statement on a pooled connection outside any transaction, so one snapshot of the committed state: main `blocks` rows, the sum of their `operation_count`, and the `weights` rows above zero. The moment is the middle of the statement's round trip, and `momentRange` half its length.

#### `confirmedHistoryConflict`

```ts
protected confirmedHistoryConflict(block: Block, reason: string): Error;
```

Provided by the base, not implemented by drivers. Logs a network integrity alarm and returns the non-retryable `LEDGER_PREVIOUS_ALREADY_USED` error. A driver uses it in its write-time successor check.

**Postgres.** Called from step 2 of `persistConfirmedStaple`.

## 5. Rules

Each rule keeps its identifier, which comments in the source cite.

### D4. Vote liveness and expiry

A stored vote is live at moment m exactly when Keeta's `Vote` class would construct it at m:
- It is not live if m + 60 s < `validityFrom`.
- Otherwise, a permanent vote is live.
- A temporary vote is live while m - 60 s <= `validityTo`.

This node's own side votes are judged by the expiry bound alone: side reads and gc drop a side vote only when it is temporary and m - 60 s > `validityTo`, and never because m + 60 s < `validityFrom`.

m is the transaction moment. `isVoteLive` (`src/ledger/storage/expiry.ts`, internal and not exported from the package) implements the first predicate and exists only for parity checks against the `Vote` class; it must never filter side reads or gc. `isVoteUnexpired` implements the second, and every side read filter and gc use it.

**Reason.**
- The `Vote` constructor rejects a vote outside the first predicate's bounds with `VOTE_MOMENT_BEFORE_VALIDITY_FROM` or `VOTE_EXPIRED` [Keeta TS] index.js:80370-80374, 80676-80679, and upstream's own staple builder drops expired votes [Keeta TS] index.js:80795-80799.
- `Ledger` fixes the transaction moment before the driver admits the transaction [Keeta TS] index.js:70393-70396. A transaction that waited behind a long one, such as a gc pass, carries a moment from before the wait, and a competing vote committed during the wait has a later `validityFrom`. Dropping that vote as issued in the future would let the waiting `vote` sign a competitor, which is equivocation; a gc pass would likewise delete a vote that still guards its previous. A stale moment can only delay expiry, so the expiry bound alone is always safe.
- Judging at the transaction moment makes every read in one transaction agree, and lets correctness not depend on gc. It also makes a transaction opened with an earlier moment see the side votes that had not expired then, if they are still stored. The gc cases read stored rows this way.

**Tested by**:
- `transactions.ts: "expiry boundary matches the Vote class"`
- `transactions.ts: "issued-in-the-future boundary matches the Vote class"`, for `isVoteLive`
- `votes.ts: "after expiry a competing vote is allowed"`: refused at `validityTo` + 60 s, allowed 1 ms later
- `concurrency.ts: "a vote admitted late still sees a competing vote committed meanwhile"`
- `concurrency.ts: "side reads admitted late see a vote committed meanwhile"`, covering `getVotes`, `getBlock`, `getBlockFromPrevious` and `getIdempotentBlockHash` under `'side'`
- `concurrency.ts: "gc admitted late keeps a vote committed meanwhile"`
- the `gc.ts` cases, which read through a transaction opened at the vote's moment

The three "admitted late" cases hold the request's transaction in `beginTransaction` until the competing vote has committed. `Ledger` has already fixed the attempt's moment by then, so the held attempt carries a moment from before the wait, as one queued behind a lock or waiting for a connection does, on any driver.

**Postgres.** The bound m - 60 s is computed in the process from the transaction moment and passed to every side query as a parameter, and the predicate is `permanent OR validity_to >= bound`. The query never reads `validity_from` for liveness.

### D5. Heads and heights are main-only

Heights and heads count main-ledger blocks only, under every selector. `getHeadBlocks(..., 'side')` returns `null` for every account.

**Reason.** The permanent vote on B arrives after the temporary vote has put B on the side ledger, and its head check reads `'both'`. A side head would refuse it with `LEDGER_NOT_SUCCESSOR`, or with `LEDGER_NOT_EMPTY` for an opening block [Keeta TS] index.js:69260-69276. A side height would make `preAdjust` refuse the publish with `LEDGER_BLOCK_ALREADY_EXISTS` [Keeta TS] index.js:67682-67688.

**Tested by** `votes.ts: "a temporary vote is stored on the side ledger and is not a head"`, and by `src/ledger/storage/suite-meta.test.ts: "the vote lifecycle cases catch heads that count side blocks"`, which runs the vote cases against a driver whose `'both'` heads count side blocks and requires them to fail.

### D6. The side ledger holds only this node's pending votes

- The side ledger holds this node's own pending votes, the blocks they cover, and those blocks' idempotent keys.
- A permanent vote is stored beside this node's temporary vote on the same blocks. The temporary vote stays until it expires or gc collects it.
- When a staple is applied, the side copies of its votes, its blocks and their keys are removed in the same write. Side entries for competing blocks are left in place.
- gc collects every side vote that can never be published, with the side blocks and idempotent claims only it held: a vote is collected once the `previous` of any block it covers has a confirmed successor. That successor is either the block itself, now on the main ledger, or a competitor that won. Only a confirmed successor counts: a competitor that is merely pending on the side ledger, or held in a deferred staple, leaves the vote in place, because the vote still guards its previous.

**Reason.**
- The temporary vote is what the settlement statistic measures from at publish [Keeta TS] index.js:67593-67632.
- Once a permanent vote exists, keeping or deleting the temporary vote gives the same vote decisions: one remaining permanent vote, or two votes, both refuse further successors [Keeta TS] index.js:69288-69305.
- A row that moves to the main ledger exists once, so `'both'` never sees two copies.
- `preAdjust` refuses a staple any of whose blocks is already on the main ledger [Keeta TS] index.js:67682-67688, and `adjust` refuses one whose block competes with a confirmed successor (D14), so such a vote can never be published. A permanent vote never expires: kept on a dead competitor, it would hold its blocks' idempotent keys forever, and this node would refuse every later block carrying one of those keys with `LEDGER_IDEMPOTENT_KEY_EXISTS` [Keeta TS] index.js:69254-69259. Such a vote arises with honest representatives: this node votes permanently, the client abandons the staple, and the network later confirms a competitor.

**Tested by**:
- `votes.ts: "a permanent vote with a fee block joins the temporary vote"`
- `votes.ts: "without a fee block the permanent vote shares its staple with the temporary vote"`
- `votes.ts: "publishing promotes the staple and deletes side copies of promoted rows"`
- `votes.ts: "side idempotent keys are visible under both and lose to main"`, where a competing entry is left in place by publish
- `gc.ts: "gc removes side votes whose blocks were all confirmed under another staple"`
- `gc.ts: "gc removes side votes whose staple can no longer be published"`
- `gc.ts: "gc removes our votes on a competitor of a confirmed block and frees its idempotent key"`
- `gc.ts: "gc keeps our permanent vote when an expired vote of ours on a competitor remains"`
- `gc.ts: "gc keeps our permanent vote when a deferred staple holds a competitor"`
- `gc.ts: "a deferred staple that is not dead survives gc and a partial release, then applies"`, where this node's pending vote on a block of a deferred staple does not make the staple dead

### D7. Map completeness and the `'both'` selector

- Members that return maps return an entry for every requested key, with `null` for an absent one.
- `getVotes` returns `null`, never `[]`.
- Under `'both'`, every selector member returns the main answer when the main ledger has one, and the side answer otherwise. `getVotesFromMultiplePrevious` and `getVoteStaples` decide this per requested key.
- `getVotes(..., 'side')` returns every unexpired side vote on the block.

**Reason.**
- Upstream callers index results directly, and treat a missing entry as a crash [Keeta TS] index.js:69263-69273, 69284-69285, 69512-69520. The staple fallback reads the first vote of any non-null `getVotes` answer [Keeta TS] index.js:69576-69580.
- Returning one ledger's answer keeps a `getVotes` answer from mixing the main staple's votes with side votes on other block sets.
- What has been confirmed reads as confirmed, and main-wins never changes a vote decision (see `getVotesFromMultiplePrevious`).

The main answer hides this node's unexpired side votes on a competitor from API reads until gc collects them (provisional: confirmed by the live parity checks).

**Tested by**:
- `confirmed.ts: "map reads return every requested key with null for absent"`
- `votes.ts: "getVotes selectors: side returns all live side votes, both prefers main, absent gives null"`
- `votes.ts: "side idempotent keys are visible under both and lose to main"`
- `confirmed.ts: "successor votes filtered to a representative outside the confirming quorum are null"`

For `getVoteStaples`, `getVotesFromMultiplePrevious` and `getBlockFromPrevious`, `'both'` with both ledgers answering is untested.

### D8. Ordering and paging

Main staples have two order keys. History is ordered by the staple itself; the catch-up feed is ordered by when this node applied each staple.

#### History order

The history key of a main staple is the ordered pair (staple time, `blocksHash`) (provisional: confirmed by the live parity checks):
1. its staple time: `VoteStaple.timestamp()` called with no `preferRep`, which is the earliest `validityFrom` of its votes plus the mean offset of every vote's `validityFrom` from it, floored to a whole millisecond [Keeta TS] index.js:81070-81096. It is an integer count of milliseconds since the Unix epoch, the value of the JavaScript `Date` that `timestamp` returns;
2. its `blocksHash`, compared as a sequence of unsigned bytes, which orders the same as comparing its equal-length uppercase hex.

- `getHistory` descends by the whole key. `start` is exclusive. A `start` that is unknown, or not in the listed history, gives `[]`.
- The key is computed once, when the staple is stored, and kept with it. A staple applied late, for example after deferral, sorts by its staple time.

**Reason.**
- Without `preferRep`, the staple time depends only on the staple's votes, so every node lists the same history in the same order, however late it applied each staple. With `preferRep`, `timestamp` returns that representative's own vote time instead [Keeta TS] index.js:81070-81096, which would make the order depend on the node asking.
- `blocksHash` identifies a main staple, so the pair is a total order: a page boundary falls between two definite staples, even inside a tie on staple time.
- The pair fits one ordered value: a fixed-width big-endian staple time followed by the `blocksHash` bytes compares in the same order. Upstream's unused `LedgerStorageBase._generateNoisyTimestamp` builds keys of this time-major shape [Keeta TS] index.js:67815.
- The client passes the previous page's `nextKey` as the next start [Keeta TS] index.js:58986-58990, and its fallback passes the last returned staple's ID [Keeta TS] index.js:58992-58994. Paging by the last returned staple works without duplicates only if `start` is exclusive.

**Tested by**:
- `confirmed.ts: "history lists the staple for every touched account, newest first, exclusive start, unknown start empty"`
- `confirmed.ts: "history orders staples by staple time, not by when they were applied"`
- `confirmed.ts: "history breaks staple-time ties by blocks hash, descending, and pages across a tie"`
- `confirmed.ts: "history orders by the mean vote time of a staple, not the earliest or any single representative's"`, where the votes of one staple carry different times

#### Catch-up order

The catch-up key of a main staple is the moment this node applied it, which is the transaction moment, followed by a node-local sequence number that breaks ties and is never reused.

- `getVotesAfter` ascends by this key and includes staples whose moment is at or after the requested moment. Pages break only between staples. `nextKey` is omitted on the last page. (provisional: confirmed by the live parity checks)

**Reason.**
- Upstream's caller stops paging only when `nextKey` is `undefined`, and removes duplicates only within one page. A staple split across pages would be returned twice [Keeta TS] index.js:69633-69702.
- The moment a staple entered this node orders a catch-up feed by what this node can serve.

**Tested by** `confirmed.ts: "getVotesAfter pages on staple boundaries"`, and `confirmed.ts: "catch-up orders by the moment each staple was applied, then by application, even when the clock goes back"`, where a staple is applied with a moment earlier than one already stored.

### D9. Balances and weights are stored values

- Balances and weights are returned as stored, without clamping, negative values included.
- `getAllBalances` omits zero balances (provisional: confirmed by the live parity checks). Untested.
- `getAccountInfo` never returns `null`. Only the vote cases T1 and T7 test it for an account with no stored info (see `getAccountInfo`).

**Reason.**
- A confirmed staple can spend funds whose incoming staple this node has not yet applied, because deferral covers only the account's own chain [Keeta TS] index.js:67717-67729. The stored balance is negative until the funding arrives.
- Vote validation reads the driver directly and must see the true value [Keeta TS] index.js:67190-67200.

Negative weights are untested.

**Tested by** `confirmed.ts: "a cross-account funding gap stores a negative balance that heals"`.

### D10. ACLs

- Permission updates are applied exactly as upstream's `computeLedgerEffect` resolves them: a `null` permission deletes the row, and a SET with no flags stores an empty row. Deleting an emptied row for an exact target would let the entity-wide row match again through `findPermissionMatch`'s fallback, which would change effective permissions [Keeta TS] index.js:67109-67132, 67467-67486.
- `listACLsByEntity` and `listACLsByPrincipal` list empty rows (provisional: confirmed by the live parity checks).
- `listOwners` honours `target`.
- `listACLsByPrincipal` with an empty entity list returns `[]`, which `computeLedgerEffect` passes when every update of a principal is a SET or a delete [Keeta TS] index.js:67266-67285.

**Tested by**:
- `confirmed.ts: "modify permissions: add, set, null deletes, entity-wide fallback"`
- `confirmed.ts: "subtract to empty stores an empty row (entity-wide row does not re-apply)"`
- `confirmed.ts: "token creation, supply and token-account balances"`
- the three permission canaries in `canaries.ts`, which require upstream's permission check to refuse three known bypasses when every ACL and account-info read comes from the driver

### D11. Account info merges defined fields

A field that an info effect carries replaces the stored field. A field it lacks, or carries as `undefined`, keeps the stored value.

**Reason.** Upstream builds info effects whose fields may be present but `undefined`, for example when a multisig identifier is created [Keeta TS] index.js:68140-68145, 68309.

Only partly testable through blocks. SET_INFO on an identifier must carry `defaultPermission` [Keeta TS] index.js:65426-65428, and no block can be built for a multisig account [Keeta TS] index.js:63818-63823. Multisig creation is therefore the only effect with present-but-undefined fields. A SET_INFO that leaves a field undefined is untested.

**Tested by** `confirmed.ts: "set info merges defined keys only"`.

### D12. Idempotent keys

- Keys are upstream's `IdempotentKey`, spelled in uppercase hex [Keeta TS] index.js:68920-68951.
- The main ledger holds a key for at most one block. A second main block with the same key is refused with `LEDGER_IDEMPOTENT_KEY_EXISTS`, whether it arrives in a later staple or in the same one.
- A side claim counts only while its block has an unexpired side vote, so a claim whose votes expired is ignored, and may remain stored until gc.
- A main claim and a side claim of one key can coexist, and `'both'` returns the main one. A storage schema with one row per key and ledger must therefore let a new side claim replace one whose votes have expired.

**Reason.** Voting refuses a block whose key another block holds on either ledger [Keeta TS] index.js:69254-69259. A competing block can still be confirmed by the network, and then holds the key on the main ledger while this node's expired claim lingers.

**Tested by** `confirmed.ts: "idempotent keys resolve on main"`, `votes.ts: "side idempotent keys are visible under both and lose to main"` and `gc.ts: "gc removes our votes on a competitor of a confirmed block and frees its idempotent key"`.

### D13. Deferral

- A deferred staple is indexed by each missing previous block, so one block can release several waiters.
- Replay runs inside the transaction that supplied the missing block, with deferral disabled. A waiter that still lacks another previous block stays deferred.
- A replayed staple that fails stays deferred, none of its writes remain, and the failure is logged. The staple that released it still applies, and its transaction commits. Each replayed staple runs in an isolated unit of its own (section 3.3, item 4).
- Replay stops once `heapProcessWindowMs` (default 5000 ms) has elapsed since the `adjust` began, measured on the wall clock. A window of 0 replays nothing, which the deferral and gc cases use to leave waiters deferred. Whether a waiter reached exactly at the window's end still replays cannot be checked against upstream's own drivers, which the package does not include; that boundary is provisional and untested.
- gc retries deferred staples whose awaited blocks are all on the main ledger. A retry that fails is not retried again in the same gc transaction, and stays deferred. Deferred staples never expire, because they are confirmed. gc drops only a deferred staple that can never apply, by the rule of D6, and logs it once (D20).
- `adjust` returns each applied staple exactly once.
- A staple applied on its own after it was deferred stops waiting.

**Reason.**
- `preAdjust` defers on a missing previous block of the account's own chain [Keeta TS] index.js:67717-67729.
- `heapProcessWindowMs` bounds the replay done within one transaction.
- `Ledger.add` folds every returned block into the checksum by XOR [Keeta TS] index.js:69413-69417.
- A deferred staple carries a quorum and can be applied whenever its chain is complete.

**Tested by**:
- `deferral.ts: "deferred staple applies exactly once when its previous arrives"`
- `deferral.ts: "deferred chains replay in order exactly once"`
- `deferral.ts: "a replayed staple that conflicts stays deferred while its trigger applies"`
- `deferral.ts: "a deferred staple applied on its own stops waiting"`
- `deferral.ts: "a deferred staple added again stays deferred once"`
- `deferral.ts: "a replayed staple whose idempotent key is taken stays deferred while its trigger applies"`
- `deferral.ts: "a replayed staple that fails after its write leaves nothing behind and stays deferred"`
- `gc.ts: "gc retries deferred staples whose previous is now on main"`
- `gc.ts: "a gc retry that fails after its write leaves nothing behind and stays deferred"`
- `gc.ts: "gc drops deferred staples that can never apply and reports each once"`
- `gc.ts: "gc reports whether more work remains"`
- `gc.ts: "a deferred staple that is not dead survives gc and a partial release, then applies"`
- `stats.ts: "a replayed staple that rolls back does not record a settlement time"`

### D14. Conflicting confirmed history

`adjust` throws a non-retryable `LEDGER_PREVIOUS_ALREADY_USED`, and logs a network integrity alarm, in three cases:
- a confirmed block's `previous` already has a different confirmed successor
- an opening block arrives for an account that already has a chain
- two blocks of one staple share a `previous`

Nothing is overwritten. `persistConfirmedStaple` refuses the same conditions at write time. The third case needs no stored state, so it is checked before `preAdjust`, and a staple whose two blocks share a missing previous is refused rather than deferred.

A staple that lists a block before its own previous is refused with a non-retryable `LEDGER_PREVIOUS_NOT_SEEN`, also before `preAdjust`, and is never deferred.

**Reason.**
- `preAdjust` assigns heights but does not detect forks [Keeta TS] index.js:67678-67732, so applying such a staple would silently replace confirmed history. Two quorums confirming a fork is a network integrity failure.
- `preAdjust` defers an out-of-order staple on a block that the staple itself carries, so no arrival would ever release it. Upstream's vote validation uses the same code for the same ordering fault [Keeta TS] index.js:70150-70160.
- A deferred staple that can only fail would be retried, and fail, on every replay and every gc pass.

**Tested by**:
- `confirmed.ts: "fork in confirmed history is rejected with LEDGER_PREVIOUS_ALREADY_USED"`
- `deferral.ts: "a staple listing a block before its previous is refused, not deferred"`
- `deferral.ts: "an out-of-order staple that also misses a previous is refused, not deferred"`
- `deferral.ts: "two blocks sharing a missing previous are refused, not deferred"`
- `confirmed.ts: "persisting never overwrites a confirmed block or successor"`, for the write-time check

### D14a. Race conflicts under real concurrency

Section 3.5, which lists the cases that test it.

### D15. ACLs naming a certificate this node lacks

A confirmed staple that grants an ACL to a certificate this node does not hold is refused with `LEDGER_CERTIFICATE_NOT_FOUND`, as `computeLedgerEffect` decides, and nothing of it is applied. Once the certificate is held, the same staple applies. (provisional: confirmed by the live parity checks)

**Reason.** `computeLedgerEffect` performs this check whatever its options [Keeta TS] index.js:67456-67460. Deferral covers only the account's own chain, so the staple is not deferred: replay or gc retries it only if it was already deferred for another reason.

**Tested by** `confirmed.ts: "an ACL granted to a certificate this node lacks is rejected"` and `gc.ts: "gc counts a deferred chain its retry releases in the checksum"`.

### D16. Serial numbers

Section 3.6.

**Reason.** A vote's identity is its issuer and serial, and `Ledger.run` reruns a failed attempt from the start with a new serial [Keeta TS] index.js:70294-70389, 70202.

**Tested by** the cases listed in section 3.6.

### D17. Transaction isolation and error evaluation

Sections 3.2 to 3.4, which also describe how the memory driver meets them.

**Tested by** every case in `transactions.ts` and `concurrency.ts`.

### D18. Accounts and history fan-out

- Every account in a staple's `touched` and `possibleNewAccounts` sets gets an account row.
- The staple is appended to the history of every touched account.

**Reason.** `touched` holds the signers, the accounts with effects, and the entities and targets of permission requirements [Keeta TS] index.js:68662-68665, 68704-68709. That is the set of accounts a staple involves.

No member reads account rows, so their creation is untested.

**Tested by** `confirmed.ts: "history lists the staple for every touched account, newest first, exclusive start, unknown start empty"`, which also checks that a delegation does not touch the representative it names.

### D19. Statistics

`stats()` returns upstream's `LedgerStatistics` shape. (provisional: confirmed by the live parity checks)

| Field | Definition |
|---|---|
| `moment` | ISO time of the view that `countLedger` describes |
| `momentRange` | milliseconds either side of `moment` that the view may come from; 0 for the memory driver, which reads committed state without yielding; half the round trip of the counting statement for the Postgres driver |
| `blockCount` | blocks on the main ledger; side and deferred blocks excluded |
| `transactionCount` | operations in the blocks on the main ledger |
| `representativeCount` | accounts whose stored weight is above zero |
| `db.retries` | the node's `ledger`/`dbRetries` statistic, which `Ledger.run` increments after a successful run [Keeta TS] index.js:70379; -1 without a node |
| `settlementTimes` | the node's `ledger`/`settlementTime` timing data [Keeta TS] index.js:74451-74472; `lib.Stats.placeholderTimingData()` without a node [Keeta TS] index.js:74388-74396 |

**Reason.** The upstream bundle does not define these fields, and no upstream code reads them.

**Tested by** `stats.ts: "stats returns the upstream shape with counts that follow the staples added"`, `stats.ts: "stats reads settlement times and retries from the node"` and `stats.ts: "a replayed staple that rolls back does not record a settlement time"`.

### D20. Garbage collection

`gc` follows upstream's loop, and each batch of the base does three things, at most 100 items of each kind:
1. It drops the deferred staples that can never apply, through `collectDeadDeferredStaples` (section 4.2), and logs each once as a network integrity alarm. A deferred staple can never apply once the `previous` of any of its blocks has a confirmed successor, the rule of D6.
2. It retries the released deferred staples (D13), each in an isolated unit (section 3.3, item 4). A released staple that an earlier retry in the batch has made dead is dropped and logged once instead. It folds every staple it applies, chained replays included, into `ledgerChecksum`, as `Ledger.add` does for what `adjust` returns.
3. It collects obsolete side votes through `collectObsoleteSideVotes` (section 4.2).

A batch reports whether work remains. A deferred retry that failed in this transaction does not count as remaining work. Scheduling gc is left to the application running the node; nothing in the upstream package calls `Ledger.gc`.

**Reason.**
- Upstream's loop checks its time budget only between batches, so batches stay small [Keeta TS] index.js:67852-67862.
- A staple applied by gc would otherwise never enter the node's checksum, which `Ledger.add` maintains only for the staples it receives [Keeta TS] index.js:69413-69417.
- A side vote that can never be published only holds idempotent keys and storage (D6).
- A deferred staple that can never apply would fail, and raise the integrity alarm, on every replay and every gc pass. It carries a quorum, so the conflict is reported, once, when it is dropped.
- Reporting a failing retry as remaining work would keep the loop, and its transaction, running until the time budget ran out.

**Tested by** every case in `gc.ts`, and by `concurrency.ts: "gc admitted late keeps a vote committed meanwhile"`.

## 6. The Postgres schema

The Postgres driver keeps the ledger, and the Postgres key-value store the node's statistics and peer-to-peer state, in the schema that the files in `schema/migrations/` create. Any other implementation that opens the same database, in any language, applies the same files, under the same rules, and reads and writes the tables as the "Postgres" paragraphs of section 4 and section 6.4 state.

### 6.1 Layout

- **Main and side.** A row that can exist on both ledgers carries `ledger` (`'main'` or `'side'`): `blocks`, `votes` and `idempotent_keys`. A block is one row, so it is never on both ledgers: promotion turns a side row into the main row in place. Main votes are unique per staple and `uid` (`votes_main`); side votes per `uid` (`votes_side`). A side vote lists its blocks in `vote_blocks`, which outlives the side copies of those blocks.
- **Accounts.** Every account the ledger names is interned once in `accounts`, with its public key spelled as upstream prints it and its key type, and other tables refer to it by its `bigint` ID. IDs are local to one database.
- **Types.** Hashes are `hash32`, a `bytea` of exactly 32 bytes. Balances, supplies and weights are `amount`, an integer-valued `numeric` without bounds or a sign check (D9). Permission sets are two `permission_bits` columns, base and external: integer-valued `numeric`, since the flag offsets exceed 63 bits and a decoded set may be negative.
- **Staples.** `staples` holds each main staple under its `blocksHash`, with its history key (`staple_time`) and its catch-up key (`moment`, `sequence`). `sequence` is an identity column, local to the database.
- **Deferral.** `deferred_staples` holds a deferred staple's bytes; `deferred_waits` the blocks it waits on; `deferred_blocks` the previous of each of its blocks, for the check that it can never apply.
- **Serials.** The sequence `vote_serials` (section 3.6).

### 6.2 Moments and the database clock

- Every moment the schema stores comes from the caller: the transaction moment, a vote's validity, a staple's time, or, for `schema_version.applied_at`, the clock of the process that migrates. Each is stored as `timestamptz`, which holds a JavaScript millisecond time exactly and reaches far beyond the year 3027 that a permanent vote's validity reaches.
- No statement reads the database clock: not `now()`, `CURRENT_TIMESTAMP`, `CURRENT_TIME`, `CURRENT_DATE`, `LOCALTIMESTAMP`, `LOCALTIME`, `clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()`, `timeofday()` or `age()`, nor the inputs `'now'`, `'today'`, `'tomorrow'` and `'yesterday'` in any quoting. The database's clock is not the node's, and a moment taken from it would make one transaction's expiry decisions disagree with the moment `Ledger` fixed for the attempt.
- **Whole milliseconds.** Every `timestamptz` column the migrations create has the domain `timestamptz_ms`, which refuses a moment that is not a whole number of milliseconds: `CHECK (VALUE = date_trunc('milliseconds', VALUE))`. Every moment the node writes is a JavaScript `Date`, which is whole milliseconds; another implementation must truncate, or refuse, a finer moment before writing it. The rule protects the keys built from moments: the catch-up page key carries the moment in milliseconds (`src/ledger/storage/paging.ts`), so a stored moment with a fraction would compare after the key of its own page, and the next page would return the same staple again, forever. `schema_version.applied_at`, which no key reads, is a plain `timestamptz`. Tested by `src/ledger/storage/postgres/schema.test.ts`.
- Moments need not increase. A transaction that began earlier can commit later (section 3.5), and the node's clock can step back. Order keys therefore break ties with the node-local `sequence`, never with "the latest moment".

Tested by `src/ledger/storage/sql-clock.test.ts: "no SQL uses the database clock"`, which scans every file in `schema/migrations/`, `src/ledger/storage/postgres/` and `src/kv/` and refuses escape strings there, since they can spell any of these, and `src/ledger/storage/sql-clock.test.ts: "the scan recognizes every form of the database clock"`. The vote case C7 (`conformance/vote-cases/clock.json`), replayed on Postgres, stores a permanent vote valid until 3027.

### 6.3 Migrations

- **Files.** Each migration is a plain SQL file, `schema/migrations/NNNN_<name>.sql`, numbered from `0001` without gaps; `<name>` is lowercase letters, digits and single underscores. A file is applied as its exact bytes, which must be valid UTF-8. Once a file has been applied anywhere it is never edited: a change is a new file.
- **Shipping.** The migration files are part of the package: `schema/migrations/` is shipped beside `dist/`, and the built runner reads it there, at `../../../../schema/migrations/` from its own module. It is the one copy every implementation applies. Tested by `src/index.test.ts: "migrates a fresh database from the migrations at the package root"`, which imports the built package.
- **Record.** The table `schema_version (version integer PRIMARY KEY, sha256 bytea NOT NULL, applied_at timestamptz NOT NULL)` holds one row per applied file: its number, the SHA-256 of its bytes, and when it was applied, by the migrating process's clock.
- **Timeout.** The migrating session runs with `statement_timeout` set to 0 until it releases the lock, then resets it: waiting for another process's migration, or a migration itself, may take longer than any statement of the ledger. Tested by `src/ledger/storage/postgres/migrations.test.ts: "a migration runs without the session's statement timeout, which the session gets back afterwards"`.
- **Lock.** Every process that migrates takes the session advisory lock `pg_advisory_lock(7738703085231170663)`, which is `0x6b656574616c6467`, the ASCII bytes `keetaldg` read as a big-endian `bigint`, before it creates or reads `schema_version`, and releases it when done, whether it succeeded or refused. An implementation in another language must use the same key and the same table, so that processes of both start safely together.
- **Procedure.** Under the lock: create `schema_version` if it does not exist; read its rows in version order; refuse if the recorded versions are not 1, 2, 3 and so on without a gap, if the newest of them is newer than the newest file this build has, or if a recorded SHA-256 differs from its file's; then apply each file the database lacks, in order, each in a transaction of its own that also inserts its `schema_version` row. A file that fails leaves nothing of itself and stops the migration. Several processes starting at once apply each file exactly once.

Tested by the cases of `src/ledger/storage/postgres/migrations.test.ts`, among them `"concurrent starts migrate exactly once"`, `"a database at an unknown version is refused"`, `"an edited migration is refused"`, `"a database without the record of an earlier version is refused"` and `"a failing migration leaves nothing of itself behind"`, and by `src/ledger/storage/postgres/driver.test.ts: "the first use migrates an empty database"`.

### 6.4 Key-value store

Upstream's statistics and peer-to-peer layers keep their state in a key-value store, `KVStorageProviderAPI` [Keeta TS] index.js:72514, 72832-72835, 74356-74361, 74473-74496. `schema/migrations/0002_kv.sql` holds it in the same database as the ledger, and `src/kv/postgres.ts` implements the interface over it. Upstream's memory store [Keeta TS] index.js:66871-66969 is the reference for its behavior.

- **Named arenas.** `kv_entries`, keyed by (`arena`, `key`), holds each value as the caller's JSON text (`json`, which keeps the text as given) and `expires_at`: the caller's clock at the write plus the ttl, or `NULL` without one. A write without a ttl clears the expiry. Keys compare as bytes (`COLLATE "C"`), and `list` and `getAll` return them in that order.
- **Expiry.** An entry whose `expires_at` is before the caller's moment is absent from `get`, `getAll` and `list`; an exclusive create replaces it, and `incr` counts it from zero and drops its expiry. An entry is still present at the moment of its expiry itself. Upstream's memory store forgets an expired entry only when `get` reads it, so until then its `list` names the key and an exclusive create of the key is refused. A write with a ttl, after writing its own entry, deletes at most two expired entries of its arena (`kv_entries_expiry`), skipping rows another transaction has locked, so expired rows never pile up and no process has to sweep them. The write is the only statement of the transaction that can wait for a lock, and it runs first, so the transaction never holds a lock while it waits and cannot take part in a deadlock. Tested by `src/kv/postgres.test.ts: "a write with an expiry waiting for a key holds no lock another transaction waits for"`.
- **Counters.** `incr` is one upsert that adds in `float8`, as JavaScript numbers add, and returns the total as a `bigint`. It refuses a live value that is not a JSON number, and a total that is not an integer is stored but cannot be returned, as upstream's memory store does [Keeta TS] index.js:66931-66950.
- **The null arena.** `kv_buffers` holds the XOR accumulators, keyed by names that begin with `@buffer:`, as `bytea`, without expiry. `get(null, key)` returns the bytes in uppercase hex. `xor` refuses any other key and is one upsert whose update is `kv_xor(stored, change)`: the XOR of the two byte strings aligned at their last byte, as long as the longer [Keeta TS] index.js:66831-66836, 66951-66968.
- **Refusals.** An exclusive create of a key with a live entry fails with `KV_KEY_ALREADY_EXISTS`, where upstream's memory store raises a plain error. A ttl that names no moment a JavaScript `Date` can hold is refused with `KV_TTL_NOT_SUPPORTED`, and a number JSON cannot hold (`NaN` or an infinity), as a value or as an increment, with a `TypeError`, both before anything is written; upstream's memory store stores them as given. An exclusive create of `null` only checks: an expired entry is already absent, and a delete in a later statement could remove an entry another process created after the check. Tested by `src/kv/postgres.test.ts: "an exclusive create of null never removes an entry created after its check"`.
- **Isolation.** Every operation is one transaction, `BEGIN ISOLATION LEVEL READ COMMITTED`, whatever the database's default. Each write is decided by the row lock its upsert takes: concurrent increments, folds and exclusive creates of one key wait for each other, and each reads the committed result of the one before, so increments from any number of processes sum exactly and one exclusive create wins. Under `SERIALIZABLE`, one of two such writes would abort instead, for a retry that reaches the same result.

Tested by `src/kv/providers.test.ts`, which runs the cases of `src/kv/suite/` against upstream's memory store and the Postgres store, among them `src/kv/suite/counters.ts: "increments from two processes on one store sum exactly"` and `src/kv/suite/entries.ts: "of exclusive creates of one key by two processes, exactly one succeeds"`, and by `src/kv/postgres.test.ts: "concurrent increments sum exactly even where the database defaults to SERIALIZABLE"` and the other cases of that file.
