# Surviving mutants

Every mutant that survives `make mutation` is listed here, and `make mutation`
fails while one is not. An entry names exactly one mutant: where its replaced
code starts and ends, its mutator, and its replacement as a JSON string, as
Stryker reports them:

`- <file>:<line>:<column>-<line>:<column> <mutator> <replacement> <equivalent|harmless>: <reason>`

An equivalent mutant behaves as the original does for every input the code can
receive, so no test can kill it. A mutant that only skips or adds a statement
which changes and answers nothing, such as one an early return for an empty
list saves, is equivalent: no answer and no stored row differs. A harmless
mutant changes behavior that no caller can observe through the module's
contract: the storage contract for the storage modules, and for the
bootstrap modules which staples the node ends up holding, queuing or
staging, as each section says. Equivalent mutants leave the module's score
after triage; harmless ones count against it.

Two kinds of mutant need no entry:

* Stryker makes no mutant of the Postgres driver's SQL (`mutation/ignorers.js`):
  the text of each statement, and the name it is prepared under. The driver
  suite and the conformance corpus run every statement against Postgres, and a
  renamed statement is still the only one of its name. Leaving the
  StringLiteral mutator out of the module instead would also spare the error
  codes, constraint names and messages its TypeScript must get right.
* A mutant of code that runs as its module loads, reported as surviving a run
  in which no test completed, is left out of the score, as Stryker leaves out
  a run that failed. Under such a mutant every test file can fail to load, and
  Stryker 10.0.0's vitest runner reports that as a survivor. `make mutation`
  lists each one. Any other survivor of an empty run still needs an entry:
  the runner selected none of the tests that cover it.

## storage

- src/ledger/storage/base.ts:36:99-41:3 BlockStatement "{}" equivalent: upstream folds only the ledger checksum into a transaction's statistics [Keeta TS] index.js:70451, and the override drops that key either way.
- src/ledger/storage/base.ts:37:7-37:34 ConditionalExpression "true" equivalent: dropping every key drops only the ledger checksum, the one key upstream ever folds in [Keeta TS] index.js:70451.
- src/ledger/storage/base.ts:40:3-40:26 CallExpression ";" equivalent: only a key other than the ledger checksum reaches super.xor, and upstream folds no other key [Keeta TS] index.js:70451.
- src/ledger/storage/base.ts:58:7-58:33 ConditionalExpression "true" equivalent: assigning the absent node assigns undefined, which every reader sees as no node.
- src/ledger/storage/base.ts:220:4-221:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled both driver states is unreachable.
- src/ledger/storage/base.ts:306:7-306:27 ConditionalExpression "false" equivalent: without the early return, getVoteStaples of no hashes answers an empty map, which maps to the same empty list.
- src/ledger/storage/base.ts:306:29-308:4 BlockStatement "{}" equivalent: without the early return, getVoteStaples of no hashes answers an empty map, which maps to the same empty list.
- src/ledger/storage/base.ts:312:8-312:47 ConditionalExpression "false" equivalent: listMainStaplesHolding names only staples whose blocks are stored, and a staple and its blocks are written in one persist, so the whole check is never true.
- src/ledger/storage/base.ts:312:8-312:28 ConditionalExpression "false" equivalent: getVoteStaples answers every hash it is asked for, so the staple is never undefined.
- src/ledger/storage/base.ts:312:8-312:47 LogicalOperator "staple === undefined && staple === null" equivalent: the staple holding a stored main block is always stored, so neither half of the check is ever true.
- src/ledger/storage/base.ts:312:32-312:47 ConditionalExpression "false" equivalent: the staple holding a stored main block is never answered as null.
- src/ledger/storage/base.ts:312:49-314:5 BlockStatement "{}" equivalent: the integrity error is unreachable while a staple and its blocks are written in one persist.
- src/ledger/storage/base.ts:313:21-313:122 StringLiteral "``" equivalent: the message of the unreachable integrity error.
- src/ledger/storage/base.ts:365:7-365:27 ConditionalExpression "false" equivalent: preAdjust defers a staple only for a previous it lacks [Keeta TS] index.js:68753-68764, so waitingOn is never empty here.
- src/ledger/storage/base.ts:365:29-367:4 BlockStatement "{}" equivalent: the error for a deferral that waits on nothing is unreachable, as preAdjust defers only for a missing previous.
- src/ledger/storage/base.ts:366:20-366:119 StringLiteral "``" equivalent: the message of the unreachable error for a deferral that waits on nothing.
- src/ledger/storage/base.ts:414:105-416:3 BlockStatement "{}" equivalent: both drivers override runIsolated, so the default body never runs.
- src/ledger/storage/base.ts:769:13-769:17 BooleanLiteral "false" equivalent: the retry that meets a failure the transaction is to run again for has just marked the transaction doomed, and #gcBatch answers that more remain for a doomed transaction whatever the retry answers.
- src/ledger/storage/base.ts:814:7-814:23 ConditionalExpression "false" equivalent: with no failure due, the second listing takes nothing, so the staples answered are the fresh ones all the same; only a read is added.
- src/ledger/storage/base.ts:814:25-816:4 BlockStatement "{}" equivalent: with no failure due, the second listing takes nothing, so the staples answered are the fresh ones all the same; only a read is added.
- src/ledger/storage/base.ts:818:80-820:4 BlockStatement "{}" equivalent: a failure is due only when the fresh staples fall short of the limit, so they are every released staple that never failed and was not retried, and the second listing has room for them and every due staple together; listing the fresh ones again leaves out no due one.
- src/ledger/storage/base.ts:855:8-855:26 ConditionalExpression "false" equivalent: the driver's write refuses the same fork with the same code and message (the memory driver's #writeStaple, the Postgres driver's write).
- src/ledger/storage/base.ts:855:28-857:5 BlockStatement "{}" equivalent: the driver's write refuses the same fork with the same code and message (the memory driver's #writeStaple, the Postgres driver's write).
- src/ledger/storage/base.ts:933:3-934:37 ConditionalExpression "default:" equivalent: the default of a switch that has handled both ways a staple is applied is unreachable.
- src/ledger/storage/confirmed.ts:72:6-72:29 ConditionalExpression "true" equivalent: copying an undefined name gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:75:6-75:36 ConditionalExpression "true" equivalent: copying an undefined description gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:78:6-78:33 ConditionalExpression "true" equivalent: copying an undefined metadata gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:81:6-81:42 ConditionalExpression "true" equivalent: copying an undefined default permission gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:84:6-84:39 ConditionalExpression "true" equivalent: copying an undefined quorum gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:97:7-97:32 ConditionalExpression "false" equivalent: a certificate principal's effect carries no info, delegation or certificate field [Keeta TS] index.js:69040-69047, so the loop records nothing for it.
- src/ledger/storage/confirmed.ts:97:34-99:4 BlockStatement "{}" equivalent: a certificate principal's effect carries no info, delegation or certificate field [Keeta TS] index.js:69040-69047, so the loop records nothing for it.
- src/ledger/storage/confirmed.ts:178:26-178:31 BooleanLiteral "true" harmless: final values add only reads and a supply range check [Keeta TS] index.js:68449-68457 that a confirmed staple passed when it was voted on; every delta written is the same.
- src/ledger/storage/confirmed.ts:212:7-212:27 ConditionalExpression "false" equivalent: preAdjust answers a height for every block of a staple it does not defer, so no height is missing.
- src/ledger/storage/confirmed.ts:212:29-214:4 BlockStatement "{}" equivalent: the error for a missing height is unreachable, as preAdjust answers a height for every block it does not defer.
- src/ledger/storage/confirmed.ts:213:20-213:64 StringLiteral "``" equivalent: the message of the unreachable error for a missing height.
- src/ledger/storage/memory/driver.ts:116:29-119:5 BlockStatement "{}" equivalent: neither merge can throw (commitOverlay only sets and deletes map entries), so the failure branch never runs.
- src/ledger/storage/memory/driver.ts:117:19-117:60 ObjectLiteral "{}" equivalent: the failed state is recorded only when a merge throws, which neither merge can.
- src/ledger/storage/memory/driver.ts:117:29-117:39 StringLiteral "\"\"" equivalent: the failed state is recorded only when a merge throws, which neither merge can.
- src/ledger/storage/memory/driver.ts:117:50-117:58 StringLiteral "\"\"" equivalent: the failed outcome is recorded only when a merge throws, which neither merge can.
- src/ledger/storage/memory/driver.ts:127:38-129:4 BlockStatement "{}" equivalent: the base runs one unit at a time per transaction, so units always close innermost first.
- src/ledger/storage/memory/driver.ts:128:20-128:106 StringLiteral "``" equivalent: the message of the unreachable error for units closed out of order.
- src/ledger/storage/memory/driver.ts:139:4-140:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled both transaction states is unreachable.
- src/ledger/storage/memory/driver.ts:165:3-166:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled both principal types is unreachable.
- src/ledger/storage/memory/driver.ts:204:6-204:31 ConditionalExpression "true" equivalent: a name is absent only from a multisig's creation, whose row is new, and an undefined name reads as an absent one.
- src/ledger/storage/memory/driver.ts:207:6-207:38 ConditionalExpression "true" equivalent: a description is absent only from a multisig's creation, whose row is new, and an undefined description reads as an absent one.
- src/ledger/storage/memory/driver.ts:210:6-210:35 ConditionalExpression "true" equivalent: metadata is absent only from a multisig's creation, whose row is new, and undefined metadata reads as absent.
- src/ledger/storage/memory/driver.ts:217:6-217:36 ConditionalExpression "false" equivalent: no info effect carries a null quorum; a quorum comes only from a multisig's creation [Keeta TS] index.js:69341-69345.
- src/ledger/storage/memory/driver.ts:217:38-219:3 BlockStatement "{}" equivalent: no info effect carries a null quorum; a quorum comes only from a multisig's creation [Keeta TS] index.js:69341-69345.
- src/ledger/storage/memory/driver.ts:219:13-219:48 ConditionalExpression "true" equivalent: a multisig has no blocks of its own [Keeta TS] index.js:64810, so its one info update is its creation, which carries the quorum.
- src/ledger/storage/memory/driver.ts:238:6-238:24 ConditionalExpression "false" equivalent: an emptied inner map left in place reads, for every ACL and certificate read, as the deleted row.
- src/ledger/storage/memory/driver.ts:238:26-241:3 BlockStatement "{}" equivalent: an emptied inner map left in place reads, for every ACL and certificate read, as the deleted row.
- src/ledger/storage/memory/driver.ts:252:9-252:33 ConditionalExpression "true" harmless: the orphaned-row count is a test hook; taking every index entry as covering stops it seeing a block left with an empty one, which the driver's writes never leave.
- src/ledger/storage/memory/driver.ts:252:9-252:33 EqualityOperator "(members?.size ?? 0) >= 0" harmless: the orphaned-row count is a test hook; taking an empty index entry as covering stops it seeing a block left with one, which the driver's writes never leave.
- src/ledger/storage/memory/driver.ts:252:10-252:23 OptionalChaining "members.size" harmless: the orphaned-row count is a test hook; it throws only for a side block with no index entry at all, which the driver's writes never leave.
- src/ledger/storage/memory/driver.ts:279:3-280:30 ConditionalExpression "default:" equivalent: the default of a switch that has handled every selector is unreachable.
- src/ledger/storage/memory/driver.ts:292:10-292:43 EqualityOperator "candidate.issued >= current.issued" equivalent: the test before it has already returned for equal issue times, so >= and > agree.
- src/ledger/storage/memory/driver.ts:294:9-294:82 EqualityOperator "toBlockHashKey(candidate.block.hash) >= toBlockHashKey(current.block.hash)" equivalent: two different pending successors never share a block hash, so >= and > agree.
- src/ledger/storage/memory/driver.ts:631:7-631:25 ConditionalExpression "true" equivalent: a page takes at least one vote, so its last vote is undefined only when no vote remains and the key is omitted either way.
- src/ledger/storage/memory/driver.ts:648:11-648:41 ConditionalExpression "true" equivalent: BlockHash.compare of undefined is false, so an absent exclusion excludes nothing either way.
- src/ledger/storage/memory/driver.ts:657:66-657:68 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the placeholder names no side block, so the read still finds no holder.
- src/ledger/storage/memory/driver.ts:677:8-677:39 ConditionalExpression "false" equivalent: a certificate principal can hold only default permissions [Keeta TS] index.js:66525-66529, never OWNER, so the OWNER test alone decides.
- src/ledger/storage/memory/driver.ts:750:120-750:122 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the placeholder has no latest vote or key, so it compares as equal to every staple and to where the listing starts, and the filter, which keeps only what comes after the start, never keeps it; first in the list, it leaves the order the sort gives the staples as it was.
- src/ledger/storage/memory/driver.ts:777:59-777:61 StringLiteral "\"Stryker was here!\"" equivalent: the start without a staple given is before every latest vote, so its key is never compared.
- src/ledger/storage/memory/driver.ts:829:75-829:77 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the placeholder names no deferred staple, so nothing is found for a block nothing waits on.
- src/ledger/storage/memory/driver.ts:831:9-831:26 ConditionalExpression "true" equivalent: forgetting a deferred staple clears its index entries, so the index names only stored staples.
- src/ledger/storage/memory/driver.ts:887:58-892:4 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once side rows leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:889:8-889:105 ConditionalExpression "false" harmless: the orphaned-row count is a test hook; it differs only once side blocks leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:889:8-889:50 ConditionalExpression "false" harmless: the orphaned-row count is a test hook; it differs only once a side block is also on main, which promotion never leaves.
- src/ledger/storage/memory/driver.ts:889:8-889:105 LogicalOperator "overlay.blocks.get(blockKey) !== undefined && !hasMembers(overlay.sideVotesByBlock.get(blockKey))" harmless: the orphaned-row count is a test hook; it differs only once side blocks leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:889:107-891:5 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once side blocks leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:890:5-890:29 CallExpression ";" harmless: the orphaned-row count is a test hook; it differs only once side blocks leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:894:69-900:4 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:895:38-899:5 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:896:9-896:82 ConditionalExpression "false" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:896:9-896:82 LogicalOperator "uncovered.has(blockKey) && overlay.sideBlocks.get(blockKey) === undefined" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:896:36-896:82 ConditionalExpression "false" harmless: the orphaned-row count is a test hook; it differs only once a claim outlives its side block, which the driver's writes never allow.
- src/ledger/storage/memory/driver.ts:896:84-898:6 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:897:6-897:16 UpdateOperator "orphaned--" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:940:3-940:38 CallExpression ";" equivalent: a vote's key is its identity, which fixes its blocks, so rewriting it indexes the same blocks again.
- src/ledger/storage/memory/driver.ts:975:7-975:24 ConditionalExpression "false" equivalent: gc collects only keys it has just read from the side votes, so the row is always there.
- src/ledger/storage/memory/driver.ts:975:26-977:4 BlockStatement "{}" equivalent: gc collects only keys it has just read from the side votes, so the early return never runs.
- src/ledger/storage/memory/driver.ts:990:7-990:34 ConditionalExpression "true" equivalent: removing a member under an undefined key reads an absent row and deletes nothing.
- src/ledger/storage/memory/driver.ts:1021:8-1021:25 ConditionalExpression "false" equivalent: a side vote and its index entries are written and forgotten together, so an indexed vote is always stored.
- src/ledger/storage/memory/driver.ts:1021:27-1023:5 BlockStatement "{}" equivalent: a side vote and its index entries are written and forgotten together, so the error never fires.
- src/ledger/storage/memory/driver.ts:1022:21-1022:84 StringLiteral "``" equivalent: the message of the unreachable error for an indexed vote that is not stored.
- src/ledger/storage/memory/driver.ts:1068:7-1068:24 ConditionalExpression "false" equivalent: a successor entry and its block are written in one persist, so the block is always stored.
- src/ledger/storage/memory/driver.ts:1068:26-1070:4 BlockStatement "{}" equivalent: a successor entry and its block are written in one persist, so the error never fires.
- src/ledger/storage/memory/driver.ts:1069:20-1069:95 StringLiteral "``" equivalent: the message of the unreachable error for a successor whose block is not stored.
- src/ledger/storage/memory/driver.ts:1112:4-1113:31 ConditionalExpression "default:" equivalent: the default of a switch that has handled every selector is unreachable.
- src/ledger/storage/memory/driver.ts:1120:7-1120:25 ConditionalExpression "false" equivalent: blocks are written in chain order, so each is above its account's head even when every head is taken to have no height.
- src/ledger/storage/memory/driver.ts:1120:7-1120:25 ConditionalExpression "true" equivalent: blocks are written in chain order, so each is above its account's head even when every account is taken to have none.
- src/ledger/storage/memory/driver.ts:1120:7-1120:25 EqualityOperator "head !== undefined" equivalent: blocks are written in chain order, so each is above its account's head whatever height the head is taken to have.
- src/ledger/storage/memory/driver.ts:1120:27-1122:4 BlockStatement "{}" equivalent: blocks are written in chain order, so each is above its account's head whatever height the head is taken to have.
- src/ledger/storage/memory/driver.ts:1123:10-1123:49 LogicalOperator "overlay.blocks.get(head)?.height && -1n" equivalent: blocks are written in chain order, so a head of height -1 or 0 is below every block written after it.
- src/ledger/storage/memory/driver.ts:1123:10-1123:42 OptionalChaining "overlay.blocks.get(head).height" equivalent: a head entry and its block are written in one persist, so the block is always there.
- src/ledger/storage/memory/driver.ts:1123:46-1123:49 UnaryOperator "+1n" equivalent: the fallback is unreachable, as a head entry's block is always stored.
- src/ledger/storage/memory/driver.ts:1128:7-1128:24 ConditionalExpression "false" equivalent: every block a head or successor names is written in the same persist, so it is always stored.
- src/ledger/storage/memory/driver.ts:1128:26-1130:4 BlockStatement "{}" equivalent: every block a head or successor names is written in the same persist, so the error never fires.
- src/ledger/storage/memory/driver.ts:1129:20-1129:90 StringLiteral "``" equivalent: the message of the unreachable error for a named block that is not stored.
- src/ledger/storage/memory/driver.ts:1136:7-1136:24 ConditionalExpression "false" equivalent: a block's staple and the block are written in one persist, so the staple is always stored.
- src/ledger/storage/memory/driver.ts:1136:26-1138:4 BlockStatement "{}" equivalent: a block's staple and the block are written in one persist, so the error never fires.
- src/ledger/storage/memory/driver.ts:1137:20-1137:90 StringLiteral "``" equivalent: the message of the unreachable error for a named staple that is not stored.
- src/ledger/storage/memory/driver.ts:1177:8-1177:28 ConditionalExpression "false" equivalent: blockHeightsOf has already required a height for every block of the staple.
- src/ledger/storage/memory/driver.ts:1177:30-1179:5 BlockStatement "{}" equivalent: blockHeightsOf has already required a height for every block of the staple, so the error never fires.
- src/ledger/storage/memory/driver.ts:1178:21-1178:70 StringLiteral "``" equivalent: the message of the unreachable error for a block without a height.
- src/ledger/storage/memory/driver.ts:1192:8-1192:51 ConditionalExpression "true" equivalent: blocks are written in chain order, so each block is above its account's head and becomes the head anyway.
- src/ledger/storage/memory/driver.ts:1192:8-1192:51 EqualityOperator "this.#headHeight(overlay, account) <= height" equivalent: blocks are written in chain order, so a block is never at its head's height.
- src/ledger/storage/memory/driver.ts:1209:9-1209:29 ConditionalExpression "false" equivalent: a zero change writes the balance the account already had, and getAllBalances leaves zero balances out.
- src/ledger/storage/memory/driver.ts:1209:31-1211:6 BlockStatement "{}" equivalent: a zero change writes the balance the account already had, and getAllBalances leaves zero balances out.
- src/ledger/storage/memory/driver.ts:1217:8-1217:26 ConditionalExpression "true" equivalent: an overlay entry set to undefined reads through to the underlying row, which is absent too.
- src/ledger/storage/memory/driver.ts:1259:8-1259:52 ConditionalExpression "false" equivalent: computeLedgerEffect resolves every permission update to a SET or a null [Keeta TS] index.js:68503-68522.
- src/ledger/storage/memory/driver.ts:1259:54-1261:5 BlockStatement "{}" equivalent: computeLedgerEffect resolves every permission update to a SET or a null, so the error never fires.
- src/ledger/storage/memory/driver.ts:1260:21-1260:104 StringLiteral "``" equivalent: the message of the unreachable error for an unresolved permission update.
- src/ledger/storage/memory/driver.ts:1284:5-1285:26 ConditionalExpression "default:" equivalent: the default of a switch that has handled both certificate methods is unreachable.
- src/ledger/storage/memory/driver.ts:1285:6-1285:26 CallExpression ";" equivalent: the assertNever of a switch that has handled both certificate methods is unreachable.
- src/ledger/storage/memory/driver.ts:1301:33-1301:83 ArrayDeclaration "[]" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/driver.ts:1301:86-1305:4 BlockStatement "{}" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/driver.ts:1302:8-1302:51 ConditionalExpression "false" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md); never writing one is unseen.
- src/ledger/storage/memory/driver.ts:1302:8-1302:51 ConditionalExpression "true" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md); rewriting one is unseen.
- src/ledger/storage/memory/driver.ts:1302:8-1302:51 EqualityOperator "overlay.accounts.get(account) !== undefined" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/driver.ts:1302:53-1304:5 BlockStatement "{}" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/driver.ts:1303:35-1303:58 ObjectLiteral "{}" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/state.ts:185:3-185:24 CallExpression ";" equivalent: every overlay is dropped once it has committed, so writes left in it are never read.
- src/ledger/storage/stage.ts:49:6-49:26 ConditionalExpression "false" equivalent: placeOf asks only whether an entry comes first, and removal compares an entry with itself, so the sign of a later key never matters.
- src/ledger/storage/stage.ts:49:28-51:3 BlockStatement "{}" equivalent: placeOf asks only whether an entry comes first, and removal compares an entry with itself, so the sign of a later key never matters.
- src/ledger/storage/stage.ts:62:7-62:23 ConditionalExpression "true" equivalent: the middle of the search is always below the list's length, so the entry is always there.
- src/ledger/storage/stage.ts:77:6-77:74 ConditionalExpression "true" equivalent: a held staple's entry is always where placeOf finds it, so the comparison is always zero.
- src/ledger/storage/stage.ts:77:33-77:60 ObjectLiteral "{}" equivalent: the fallback is unreachable, as a held staple's entry is always in the list.
- src/ledger/storage/stage.ts:77:56-77:58 StringLiteral "\"Stryker was here!\"" equivalent: the fallback is unreachable, as a held staple's entry is always in the list.
- src/ledger/storage/stage.ts:85:33-85:35 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the placeholder compares as never before any entry, so it stays last, and names no staple.
- src/ledger/storage/stage.ts:86:32-86:34 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the placeholder compares as never before any entry, so it stays last, and names no staple.
- src/ledger/storage/stage.ts:110:72-110:74 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the placeholder left out is no staple's key.
- src/ledger/storage/stage.ts:118:8-118:28 ConditionalExpression "true" equivalent: the index lists only held staples, as removal takes a staple out of both.
- src/ledger/storage/stage.ts:127:75-127:99 EqualityOperator "at <= this.#byLast.length" equivalent: one step past the end reads no staple, and the next test ends the loop.
- src/ledger/storage/stage.ts:128:37-128:58 OptionalChaining "this.#byLast[at].key" equivalent: inside the loop the index is in range, so the entry is always there.
- src/ledger/storage/stage.ts:128:62-128:64 StringLiteral "\"Stryker was here!\"" equivalent: the fallback is unreachable, as the index is in range inside the loop.
- src/ledger/storage/stage.ts:129:8-129:28 ConditionalExpression "true" equivalent: the index lists only held staples, as removal takes a staple out of both.

## postgres

- src/ledger/storage/postgres/driver.ts:242:34-242:52 ObjectLiteral "{}" equivalent: mapDatabaseError treats every failed statement not marked before-commit as the COMMIT, so a COMMIT marked with no kind is mapped the same.
- src/ledger/storage/postgres/driver.ts:242:42-242:50 StringLiteral "\"\"" equivalent: mapDatabaseError treats every failed statement not marked before-commit as the COMMIT, so a COMMIT marked with no kind is mapped the same.
- src/ledger/storage/postgres/driver.ts:294:4-295:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:361:6-361:25 ConditionalExpression "false" equivalent: a blocks hash is always 32 bytes, so its first byte is never undefined.
- src/ledger/storage/postgres/driver.ts:361:27-363:3 BlockStatement "{}" equivalent: a blocks hash is always 32 bytes, so its first byte is never undefined.
- src/ledger/storage/postgres/driver.ts:362:19-362:69 StringLiteral "\"\"" equivalent: the message of the unreachable error for an empty blocks hash.
- src/ledger/storage/postgres/driver.ts:378:36-378:38 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the history statements find an account by its public key, and no account has that one, so the extra pair adds no row.
- src/ledger/storage/postgres/driver.ts:379:34-379:36 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the history statements find an account by its public key, and no account has that one, so the extra pair removes no row.
- src/ledger/storage/postgres/driver.ts:435:6-435:21 ConditionalExpression "false" equivalent: every statement onlyRow reads is keyed by a primary or unique key, limited to one row, or an aggregate, so it never answers two rows.
- src/ledger/storage/postgres/driver.ts:435:23-437:3 BlockStatement "{}" equivalent: every statement onlyRow reads is keyed by a primary or unique key, limited to one row, or an aggregate, so it never answers two rows.
- src/ledger/storage/postgres/driver.ts:436:19-436:89 StringLiteral "``" equivalent: the message of the unreachable error for two rows where one was expected.
- src/ledger/storage/postgres/driver.ts:462:6-462:23 ConditionalExpression "true" equivalent: upstream reads a null name as the empty string, as it reads an absent one [Keeta TS] index.js:68769-68775.
- src/ledger/storage/postgres/driver.ts:465:6-465:30 ConditionalExpression "true" equivalent: upstream reads a null description as the empty string, as it reads an absent one [Keeta TS] index.js:68769-68775.
- src/ledger/storage/postgres/driver.ts:468:6-468:27 ConditionalExpression "true" equivalent: upstream reads null metadata as the empty string, as it reads absent metadata [Keeta TS] index.js:68769-68775.
- src/ledger/storage/postgres/driver.ts:477:6-477:42 ConditionalExpression "true" equivalent: infoParameters writes the default permission's two sets together or neither, and the merge keeps or replaces each column alike, so one is null exactly when the other is.
- src/ledger/storage/postgres/driver.ts:477:6-477:86 LogicalOperator "row.default_base_permission !== null || row.default_external_permission !== null" equivalent: infoParameters writes the default permission's two sets together or neither, and the merge keeps or replaces each column alike, so one is null exactly when the other is.
- src/ledger/storage/postgres/driver.ts:477:46-477:86 ConditionalExpression "true" equivalent: infoParameters writes the default permission's two sets together or neither, and the merge keeps or replaces each column alike, so one is null exactly when the other is.
- src/ledger/storage/postgres/driver.ts:533:3-534:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:544:3-545:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:551:6-551:22 ConditionalExpression "false" equivalent: every account a write names is interned first (accountsNamedBy), and interning answers an ID for every account it is given, so none is missing.
- src/ledger/storage/postgres/driver.ts:551:24-553:3 BlockStatement "{}" equivalent: every account a write names is interned first (accountsNamedBy), and interning answers an ID for every account it is given, so none is missing.
- src/ledger/storage/postgres/driver.ts:552:19-552:85 StringLiteral "``" equivalent: the message of the unreachable error for an account that was not interned.
- src/ledger/storage/postgres/driver.ts:570:45-570:75 ConditionalExpression "true" equivalent: upstream sets a quorum only to the quorum a multisig is created with, a bigint [Keeta TS] index.js:69345, never to null.
- src/ledger/storage/postgres/driver.ts:573:120-573:155 ConditionalExpression "false" equivalent: only a multisig has a quorum, which the insert that creates its info row writes whatever the flag says, and no block of a multisig can change its info later [Keeta TS] index.js:64809-64811; every other account's quorum is null either way.
- src/ledger/storage/postgres/driver.ts:573:120-573:155 ConditionalExpression "true" equivalent: only a multisig has a quorum, which the insert that creates its info row writes whatever the flag says, and no block of a multisig can change its info later [Keeta TS] index.js:64809-64811; every other account's quorum is null either way.
- src/ledger/storage/postgres/driver.ts:573:120-573:155 EqualityOperator "update.multisigQuorum === undefined" equivalent: only a multisig has a quorum, which the insert that creates its info row writes whatever the flag says, and no block of a multisig can change its info later [Keeta TS] index.js:64809-64811; every other account's quorum is null either way.
- src/ledger/storage/postgres/driver.ts:620:28-620:30 ArrayDeclaration "[\"Stryker was here\"]" equivalent: no staple is keyed by those bytes, so rebuilding reads nothing more.
- src/ledger/storage/postgres/driver.ts:628:6-628:26 ConditionalExpression "false" equivalent: without the early return the rebuild runs its two statements over no staples, which read nothing.
- src/ledger/storage/postgres/driver.ts:628:28-630:3 BlockStatement "{}" equivalent: without the early return the rebuild runs its two statements over no staples, which read nothing.
- src/ledger/storage/postgres/driver.ts:668:7-668:26 ConditionalExpression "false" equivalent: groupBy never makes an empty group, so a group always has a first vote.
- src/ledger/storage/postgres/driver.ts:668:28-670:4 BlockStatement "{}" equivalent: groupBy never makes an empty group, so a group always has a first vote.
- src/ledger/storage/postgres/driver.ts:669:20-669:63 StringLiteral "\"\"" equivalent: the message of the unreachable error for an empty group of votes.
- src/ledger/storage/postgres/driver.ts:805:7-805:28 ConditionalExpression "false" equivalent: both history counts are aggregates, which always answer one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:805:7-805:51 ConditionalExpression "false" equivalent: both history counts are aggregates, which always answer one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:805:7-805:51 LogicalOperator "removed === undefined && added === undefined" equivalent: both history counts are aggregates, which always answer one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:805:32-805:51 ConditionalExpression "false" equivalent: both history counts are aggregates, which always answer one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:805:53-807:4 BlockStatement "{}" equivalent: both history counts are aggregates, which always answer one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:806:20-806:69 StringLiteral "\"\"" equivalent: the message of the unreachable error for a history count with no row.
- src/ledger/storage/postgres/driver.ts:857:7-857:24 ConditionalExpression "false" equivalent: nextval always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:857:26-859:4 BlockStatement "{}" equivalent: nextval always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:858:20-858:61 StringLiteral "\"\"" equivalent: the message of the unreachable error for nextval with no row.
- src/ledger/storage/postgres/driver.ts:874:7-874:24 ConditionalExpression "false" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:874:26-876:4 BlockStatement "{}" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:875:20-875:59 StringLiteral "\"\"" equivalent: the message of the unreachable error for a sum with no row.
- src/ledger/storage/postgres/driver.ts:917:8-917:31 ConditionalExpression "false" equivalent: without the early return the statement runs with an empty entity list, which matches no row (D10), the answer the early return gives; the transaction is checked open either way.
- src/ledger/storage/postgres/driver.ts:917:33-920:5 BlockStatement "{}" equivalent: without the early return the statement runs with an empty entity list, which matches no row (D10), the answer the early return gives; the transaction is checked open either way.
- src/ledger/storage/postgres/driver.ts:969:4-970:31 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:1014:7-1014:27 ConditionalExpression "true" equivalent: the public key of an absent account is undefined [Keeta TS] index.js:63699-63701, which pg sends as the null the original passes.
- src/ledger/storage/postgres/driver.ts:1085:8-1085:25 ConditionalExpression "true" equivalent: the page after a start has rows only when the start is in the account's history, as the statement reads the start's time from the account's own row, so the check that the start is listed then passes.
- src/ledger/storage/postgres/driver.ts:1085:30-1085:127 OptionalChaining "(await transaction.run(accountHistoryLists, [publicKeyOf(account), hashBytes(start)]))[0].listed" equivalent: an EXISTS query always answers one row.
- src/ledger/storage/postgres/driver.ts:1115:7-1115:25 ConditionalExpression "true" equivalent: a page holds at least one vote, so the page is empty only when no row was read, and then no next key is made either way.
- src/ledger/storage/postgres/driver.ts:1150:7-1150:27 ConditionalExpression "true" equivalent: the public key of an absent account is undefined [Keeta TS] index.js:63699-63701, which pg sends as the null the original passes.
- src/ledger/storage/postgres/driver.ts:1176:4-1177:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:1177:5-1177:32 CallExpression ";" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:1232:53-1232:55 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the string makes a claim with no key and no block, and the insert keeps only a claim whose block is a side copy, so it inserts nothing.
- src/ledger/storage/postgres/driver.ts:1246:9-1246:31 ConditionalExpression "false" equivalent: an insert without a conflict clause answers its one row or fails, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:1246:33-1248:6 BlockStatement "{}" equivalent: an insert without a conflict clause answers its one row or fails, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:1247:22-1247:77 StringLiteral "``" equivalent: the message of the unreachable error for a side vote insert with no row.
- src/ledger/storage/postgres/driver.ts:1265:7-1265:24 ConditionalExpression "false" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:1265:26-1267:4 BlockStatement "{}" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:1266:20-1266:71 StringLiteral "\"\"" equivalent: the message of the unreachable error for the counts with no row.
- src/ledger/storage/postgres/driver.ts:1309:7-1309:24 ConditionalExpression "false" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:1309:26-1311:4 BlockStatement "{}" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:1310:20-1310:73 StringLiteral "\"\"" equivalent: the message of the unreachable error for the checksum with no row.
- src/ledger/storage/postgres/driver.ts:1383:7-1383:24 ConditionalExpression "false" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:1383:26-1385:4 BlockStatement "{}" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/driver.ts:1384:20-1384:81 StringLiteral "\"\"" equivalent: the message of the unreachable error for the orphaned row count with no row.
- src/ledger/storage/postgres/driver.ts:1399:7-1399:27 ConditionalExpression "true" equivalent: with no vote to collect, the three statements delete nothing.
- src/ledger/storage/postgres/driver.ts:1399:7-1399:27 EqualityOperator "collected.length >= 0" equivalent: with no vote to collect, the three statements delete nothing.
- src/ledger/storage/postgres/driver.ts:1435:7-1435:41 ConditionalExpression "false" equivalent: with no idempotent key, the statement finds no holder.
- src/ledger/storage/postgres/driver.ts:1435:43-1437:4 BlockStatement "{}" equivalent: with no idempotent key, the statement finds no holder.
- src/ledger/storage/postgres/driver.ts:1461:90-1463:4 BlockStatement "{}" equivalent: a block on main is the main successor of its own previous, which the same statement finds through the list of previous blocks, so it is still found on main.
- src/ledger/storage/postgres/driver.ts:1516:7-1516:40 ConditionalExpression "false" equivalent: the check before it refuses any block already on main in the same snapshot, and the insert turns a side copy into the main row, so it answers a row for every block.
- src/ledger/storage/postgres/driver.ts:1516:42-1518:4 BlockStatement "{}" equivalent: the check before it refuses any block already on main in the same snapshot, and the insert turns a side copy into the main row, so it answers a row for every block.
- src/ledger/storage/postgres/driver.ts:1517:28-1517:57 StringLiteral "\"\"" equivalent: the message of the unreachable error for a block the insert found already on main.
- src/ledger/storage/postgres/driver.ts:1517:59-1517:130 StringLiteral "``" equivalent: the message of the unreachable error for a block the insert found already on main.
- src/ledger/storage/postgres/driver.ts:1526:8-1526:28 ConditionalExpression "false" equivalent: the change holds a height for every block of its staple, as blockHeightsOf refuses a staple without one.
- src/ledger/storage/postgres/driver.ts:1526:30-1528:5 BlockStatement "{}" equivalent: the change holds a height for every block of its staple, as blockHeightsOf refuses a staple without one.
- src/ledger/storage/postgres/driver.ts:1527:21-1527:83 StringLiteral "``" equivalent: the message of the unreachable error for a block with no height.
- src/ledger/storage/postgres/driver.ts:1538:8-1538:28 ConditionalExpression "false" equivalent: the heights and the hashes are mapped from the same blocks, so the lists are equally long.
- src/ledger/storage/postgres/driver.ts:1538:8-1538:50 ConditionalExpression "false" equivalent: the heights and the hashes are mapped from the same blocks, so the lists are equally long.
- src/ledger/storage/postgres/driver.ts:1538:8-1538:50 LogicalOperator "height === undefined && hash === undefined" equivalent: the heights and the hashes are mapped from the same blocks, so the lists are equally long.
- src/ledger/storage/postgres/driver.ts:1538:32-1538:50 ConditionalExpression "false" equivalent: the heights and the hashes are mapped from the same blocks, so the lists are equally long.
- src/ledger/storage/postgres/driver.ts:1538:52-1540:5 BlockStatement "{}" equivalent: the heights and the hashes are mapped from the same blocks, so the lists are equally long.
- src/ledger/storage/postgres/driver.ts:1539:21-1539:68 StringLiteral "\"\"" equivalent: the message of the unreachable error for lists of unequal length.
- src/ledger/storage/postgres/driver.ts:1542:8-1542:56 ConditionalExpression "true" equivalent: a staple lists an account's blocks in chain order, as the base refuses any other, so each later block of an account is higher and keeping the last keeps the highest.
- src/ledger/storage/postgres/driver.ts:1542:33-1542:56 EqualityOperator "current.height <= height" equivalent: a staple lists an account's blocks in chain order, as the base refuses any other, so each later block of an account is higher and keeping the last keeps the highest.
- src/ledger/storage/postgres/driver.ts:1631:7-1631:31 ConditionalExpression "false" equivalent: with no delegation, the statement sets nothing.
- src/ledger/storage/postgres/driver.ts:1631:33-1633:4 BlockStatement "{}" equivalent: with no delegation, the statement sets nothing.
- src/ledger/storage/postgres/driver.ts:1657:8-1657:52 ConditionalExpression "false" equivalent: computeLedgerEffect resolves every permission update but a deletion into a SET [Keeta TS] index.js:68502-68522, so the guard is unreachable.
- src/ledger/storage/postgres/driver.ts:1657:54-1659:5 BlockStatement "{}" equivalent: computeLedgerEffect resolves every permission update but a deletion into a SET [Keeta TS] index.js:68502-68522, so the guard is unreachable.
- src/ledger/storage/postgres/driver.ts:1658:21-1658:104 StringLiteral "``" equivalent: the message of the unreachable error for an unresolved permission update.
- src/ledger/storage/postgres/driver.ts:1681:5-1682:26 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:1682:6-1682:26 CallExpression ";" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:1688:7-1688:41 ConditionalExpression "false" equivalent: with no idempotent key, the statement inserts nothing.
- src/ledger/storage/postgres/driver.ts:1688:43-1690:4 BlockStatement "{}" equivalent: with no idempotent key, the statement inserts nothing.
- src/ledger/storage/postgres/driver.ts:1726:3-1727:30 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/driver.ts:1746:8-1746:29 ConditionalExpression "true" equivalent: reading the side ledger for no keys answers nothing.
- src/ledger/storage/postgres/driver.ts:1746:8-1746:29 EqualityOperator "unanswered.length >= 0" equivalent: reading the side ledger for no keys answers nothing.
- src/ledger/storage/postgres/driver.ts:1753:3-1754:30 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/errors.ts:96:9-96:58 ConditionalExpression "true" equivalent: the transient codes are strings, so the set answers false for a code that is absent or not a string, as the guards do.
- src/ledger/storage/postgres/errors.ts:96:9-96:58 LogicalOperator "'code' in error || typeof error.code === 'string'" equivalent: the transient codes are strings, so the set answers false for a code that is absent or not a string, as the guards do.
- src/ledger/storage/postgres/errors.ts:96:28-96:58 ConditionalExpression "true" equivalent: the transient codes are strings, so the set answers false for a code that is absent or not a string, as the guards do.
- src/ledger/storage/postgres/migrations.ts:57:3-58:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/migrations.ts:85:6-85:47 ConditionalExpression "false" equivalent: every caller passes a positive whole number: a file number already checked to be at least 1, a position plus one, the count of migrations, which is never zero, or a recorded version greater than that count.
- src/ledger/storage/postgres/migrations.ts:85:6-85:47 LogicalOperator "!Number.isSafeInteger(value) && value < 1" equivalent: every caller passes a positive whole number: a file number already checked to be at least 1, a position plus one, the count of migrations, which is never zero, or a recorded version greater than that count.
- src/ledger/storage/postgres/migrations.ts:85:38-85:47 ConditionalExpression "false" equivalent: every caller passes a positive whole number: a file number already checked to be at least 1, a position plus one, the count of migrations, which is never zero, or a recorded version greater than that count.
- src/ledger/storage/postgres/migrations.ts:85:49-87:3 BlockStatement "{}" equivalent: every caller passes a positive whole number: a file number already checked to be at least 1, a position plus one, the count of migrations, which is never zero, or a recorded version greater than that count.
- src/ledger/storage/postgres/migrations.ts:86:19-86:77 StringLiteral "``" equivalent: the message of the unreachable error for a schema version that is not a positive whole number.
- src/ledger/storage/postgres/migrations.ts:164:7-164:30 ConditionalExpression "false" equivalent: a record with no migration at its position needs more records than migrations, and the newest record is then a version this build does not know, which is refused first.
- src/ledger/storage/postgres/pool.ts:91:4-92:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every case of its union is unreachable.
- src/ledger/storage/postgres/pool.ts:150:54-152:4 BlockStatement "{}" equivalent: a function with no body returns undefined, as the original does.
- src/ledger/storage/postgres/stage.ts:52:6-52:23 ConditionalExpression "false" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/stage.ts:52:25-54:3 BlockStatement "{}" equivalent: the statement is an aggregate, which always answers one row, so the guard for no row is unreachable.
- src/ledger/storage/postgres/stage.ts:53:19-53:83 StringLiteral "\"\"" equivalent: the message of the unreachable error for a stage count with no row.
- src/ledger/storage/postgres/stage.ts:80:7-80:27 ConditionalExpression "false" equivalent: staging nothing runs a statement over no staples, which stages and counts nothing, the counts NO_STAGED holds.
- src/ledger/storage/postgres/stage.ts:80:29-82:4 BlockStatement "{}" equivalent: staging nothing runs a statement over no staples, which stages and counts nothing, the counts NO_STAGED holds.
- src/ledger/storage/postgres/stage.ts:101:10-101:19 OptionalChaining "row.held" equivalent: an EXISTS query always answers one row.
- src/ledger/storage/postgres/stage.ts:104:78-104:80 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the string decodes as hex to no bytes, which no staged key equals.
- src/ledger/storage/postgres/stage.ts:113:7-113:24 ConditionalExpression "false" equivalent: removing nothing runs a statement over no staples, which removes and counts nothing, the counts NO_STAGED holds.
- src/ledger/storage/postgres/stage.ts:113:26-115:4 BlockStatement "{}" equivalent: removing nothing runs a statement over no staples, which removes and counts nothing, the counts NO_STAGED holds.

## bootstrap-client

Harmless here means the node ends up holding, queuing and staging the same
staples: what changes is when, how many requests it takes, how much memory it
keeps, or the text of a line it logs.

- src/node/bootstrap-cursors.ts:40:9-40:34 ConditionalExpression "true" equivalent: Number.isSafeInteger is false for every value that is no number, so the conjunction answers the same without the typeof test.
- src/node/bootstrap-cursors.ts:288:3-289:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of Awaited is unreachable.
- src/node/bootstrap-pacing.ts:44:51-44:55 BooleanLiteral "false" equivalent: the listener is removed once the wait ends, and a signal is aborted at most once, so it runs at most once either way.
- src/node/bootstrap-pacing.ts:104:8-104:16 EqualityOperator "wait >= 0" harmless: a wait of exactly 0 ms takes one timer tick before the same request is sent; a stop in that tick is reported as a stop while waiting, as the error the signal's reason wraps, rather than as the reason itself.
- src/node/bootstrap-pacing.ts:115:8-115:42 ConditionalExpression "false" equivalent: a peer's last turn left in place is settled, so the next request to the peer waits on a settled promise, as on none; the map keeps one turn per peer the node bootstraps from.
- src/node/bootstrap-pacing.ts:115:44-117:5 BlockStatement "{}" equivalent: a peer's last turn left in place is settled, so the next request to the peer waits on a settled promise, as on none; the map keeps one turn per peer the node bootstraps from.
- src/node/bootstrap-pacing.ts:116:5-116:34 CallExpression ";" equivalent: a peer's last turn left in place is settled, so the next request to the peer waits on a settled promise, as on none; the map keeps one turn per peer the node bootstraps from.
- src/node/bootstrap-page.ts:80:3-81:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of PageProblem is unreachable.
- src/node/bootstrap-page.ts:96:9-96:34 ConditionalExpression "true" equivalent: the callers read only the properties message, voteStaples and $binary, which no JSON value but an object has: a number, string, boolean or array answers undefined for each, as a value that is no record.
- src/node/bootstrap-page.ts:130:7-130:64 ConditionalExpression "true" equivalent: a value with no string message throws as its message is sliced, inside the try whose catch answers undefined, as the guard does.
- src/node/bootstrap-page.ts:130:7-130:64 LogicalOperator "isRecord(parsed) || typeof parsed['message'] === 'string'" equivalent: a value with no string message throws as its message is sliced, inside the try whose catch answers undefined, as the guard does.
- src/node/bootstrap-page.ts:130:27-130:64 ConditionalExpression "true" equivalent: a record with no string message throws as its message is sliced, inside the try whose catch answers undefined, as the guard does.
- src/node/bootstrap-page.ts:266:41-266:60 ObjectLiteral "{}" harmless: an https peer's pages then each open a connection of their own instead of reusing one; the pages read are the same.
- src/node/bootstrap-page.ts:378:17-378:24 StringLiteral "\"\"" equivalent: the error a response is destroyed with, too large or ended early, also fails its request, whose 'error' listener rejects the page with that error (Node's http client; bootstrap-page.test.ts runs both).
- src/node/bootstrap-page.ts:379:5-383:8 CallExpression ";" equivalent: Node's http client destroys a response that closes before it is complete with an 'aborted' error first, which rejects the page, so this rejection never decides it (bootstrap-page.test.ts, an answer that ends before its length).
- src/node/bootstrap-page.ts:379:17-379:24 StringLiteral "\"\"" equivalent: Node's http client destroys a response that closes before it is complete with an 'aborted' error first, which rejects the page, so this rejection never decides it.
- src/node/bootstrap-page.ts:379:43-383:6 BlockStatement "{}" equivalent: Node's http client destroys a response that closes before it is complete with an 'aborted' error first, which rejects the page, so this rejection never decides it.
- src/node/bootstrap-page.ts:380:10-380:28 BooleanLiteral "response.complete" equivalent: a complete response has resolved the page at its end, which a later rejection cannot change, and an incomplete one has been rejected by its 'aborted' error first.
- src/node/bootstrap-page.ts:380:10-380:28 ConditionalExpression "true" equivalent: a complete response has resolved the page at its end, which a later rejection cannot change, and an incomplete one has been rejected by its 'aborted' error first.
- src/node/bootstrap-page.ts:380:10-380:28 ConditionalExpression "false" equivalent: Node's http client destroys a response that closes before it is complete with an 'aborted' error first, which rejects the page, so this rejection never decides it.
- src/node/bootstrap-page.ts:380:30-382:7 BlockStatement "{}" equivalent: Node's http client destroys a response that closes before it is complete with an 'aborted' error first, which rejects the page, so this rejection never decides it.
- src/node/bootstrap-page.ts:381:67-381:91 StringLiteral "\"\"" equivalent: Node's http client destroys a response that closes before it is complete with an 'aborted' error first, which rejects the page, so this rejection never decides it.
- src/node/bootstrap-peers.ts:79:30-79:32 ArrayDeclaration "[\"Stryker was here\"]" equivalent: apiEndpointsOf takes only representatives, and a string has no kind.
- src/node/bootstrap-peers.ts:81:7-81:49 ConditionalExpression "false" equivalent: a peer that is no representative, weighed or not, is left out by apiEndpointsOf.
- src/node/bootstrap-peers.ts:81:51-83:4 BlockStatement "{}" equivalent: a peer that is no representative, weighed or not, is left out by apiEndpointsOf.
- src/node/bootstrap-peers.ts:102:25-102:27 ArrayDeclaration "[\"Stryker was here\"]" equivalent: apiEndpointsOf takes only representatives, and a string has no kind.
- src/node/bootstrap-peers.ts:108:48-108:50 ArrayDeclaration "[\"Stryker was here\"]" equivalent: apiEndpointsOf takes only representatives, and a string has no kind.
- src/node/bootstrap-update.ts:55:33-55:35 UnaryOperator "+1" equivalent: every peer sorted was set in the map just before, so the default is never taken.
- src/node/bootstrap-update.ts:55:61-55:63 UnaryOperator "+1" equivalent: every peer sorted was set in the map just before, so the default is never taken.
- src/node/bootstrap-update.ts:114:28-116:5 MethodExpression "peers" equivalent: the peer whose pass completed has reached the horizon, read from its own progress, so moveOnTo, which moves only a peer reached less far, leaves it as it is.
- src/node/bootstrap-update.ts:115:11-115:44 ConditionalExpression "true" equivalent: the peer whose pass completed has reached the horizon, read from its own progress, so moveOnTo, which moves only a peer reached less far, leaves it as it is.
- src/node/bootstrap-update.ts:115:33-115:44 StringLiteral "\"\"" equivalent: the peer whose pass completed has reached the horizon, read from its own progress, so moveOnTo, which moves only a peer reached less far, leaves it as it is.
- src/node/bootstrap.ts:100:3-101:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of PassOutcome is unreachable.
- src/node/bootstrap.ts:113:3-114:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of PassOutcome is unreachable.
- src/node/bootstrap.ts:186:8-186:17 StringLiteral "\"\"" equivalent: a stopped request then fails its pass through the unreachable default instead of with the PageError, and a pass that fails once the client is stopped is logged only as stopped, without its error.
- src/node/bootstrap.ts:188:3-189:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of PageProblem is unreachable.
- src/node/bootstrap.ts:289:40-289:42 ArrayDeclaration "[\"Stryker was here\"]" equivalent: nextUpdateDelay looks only for 'bounded', which the placeholder is not.
- src/node/bootstrap.ts:402:23-402:25 ArrayDeclaration "[\"Stryker was here\"]" equivalent: nextUpdateDelay looks only for 'bounded', which the placeholder is not.
- src/node/bootstrap.ts:441:5-441:21 CallExpression ";" harmless: the node adding what it staged then sees a moved frontier only at the next staple staged or once the passes end, when it adds the rest; it adds the same staples in the same order, later.
- src/node/bootstrap.ts:474:8-474:23 ConditionalExpression "false" harmless: an update that left staged staples after passes that all completed is then followed after the period rather than at once; the next update adds them.
- src/node/bootstrap.ts:474:25-477:5 BlockStatement "{}" harmless: an update that left staged staples after passes that all completed is then followed after the period rather than at once; the next update adds them.
- src/node/bootstrap.ts:476:25-476:58 ArrayDeclaration "[]" harmless: an update that left staged staples after passes that all completed is then followed after the period rather than at once; the next update adds them.
- src/node/bootstrap.ts:476:48-476:57 StringLiteral "\"\"" harmless: an update that left staged staples after passes that all completed is then followed after the period rather than at once; the next update adds them.
- src/node/bootstrap.ts:506:31-506:55 ConditionalExpression "true" equivalent: the layout an update logs against never has no ranges: once the last range is read the peers are moved on from it and it is cleared, before the update logs what it added.
- src/node/bootstrap.ts:506:31-506:55 EqualityOperator "layout.ranges.length >= 0" equivalent: the layout an update logs against never has no ranges: once the last range is read the peers are moved on from it and it is cleared, before the update logs what it added.
- src/node/bootstrap.ts:692:11-692:19 StringLiteral "\"\"" equivalent: a pass's result is read only as 'completed' or 'bounded', neither of which an empty one is, as 'failed' is not.
- src/node/bootstrap.ts:702:11-702:19 StringLiteral "\"\"" equivalent: a pass's result is read only as 'completed' or 'bounded', neither of which an empty one is, as 'failed' is not.
- src/node/bootstrap.ts:717:7-717:22 ConditionalExpression "false" harmless: a pass over a range begun after the stop fails at its first request, which the pacer refuses once stopped, and is logged as stopped all the same, having written the peer's first progress if it had none.
- src/node/bootstrap.ts:717:24-719:4 BlockStatement "{}" harmless: a pass over a range begun after the stop fails at its first request, which the pacer refuses once stopped, and is logged as stopped all the same, having written the peer's first progress if it had none.
- src/node/bootstrap.ts:718:11-718:20 StringLiteral "\"\"" harmless: a pass over a range begun after the stop fails at its first request, which the pacer refuses once stopped, and is logged as stopped all the same, having written the peer's first progress if it had none.
- src/node/bootstrap.ts:730:8-730:69 ConditionalExpression "false" harmless: only a stage at its 4 GiB bound throws here, since a pass over a range stages and never queues; its peer is then counted as failing instead of waiting for room.
- src/node/bootstrap.ts:730:8-730:69 LogicalOperator "error instanceof RetryQueueFull && error instanceof StageFull" harmless: only a stage at its 4 GiB bound throws here, since a pass over a range stages and never queues; its peer is then counted as failing instead of waiting for room.
- src/node/bootstrap.ts:730:71-733:5 BlockStatement "{}" harmless: only a stage at its 4 GiB bound throws here, since a pass over a range stages and never queues; its peer is then counted as failing instead of waiting for room.
- src/node/bootstrap.ts:731:37-731:183 StringLiteral "``" harmless: only a stage at its 4 GiB bound throws here; the text of its log line changes.
- src/node/bootstrap.ts:732:12-732:23 StringLiteral "\"\"" harmless: only a stage at its 4 GiB bound throws here, since a pass over a range stages and never queues; its peer is then counted as failing instead of waiting for room.
- src/node/bootstrap.ts:771:5-771:44 CallExpression ";" harmless: a pass that asks what the node holds after the stop reads the ledger once more, bounded by HELD_READ_MILLISECONDS, before its next request fails.
- src/node/bootstrap.ts:775:9-775:30 ConditionalExpression "false" equivalent: with as many named as the window allows, the read of the ledger is for none more, which it answers with none, so the names are the same.
- src/node/bootstrap.ts:775:9-775:30 EqualityOperator "named.length > count" equivalent: with as many named as the window allows, the read of the ledger is for none more, which it answers with none, so the names are the same.
- src/node/bootstrap.ts:775:32-777:6 BlockStatement "{}" equivalent: with as many named as the window allows, the read of the ledger is for none more, which it answers with none, so the names are the same.
- src/node/bootstrap.ts:793:6-794:26 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of Added is unreachable.
- src/node/bootstrap.ts:794:7-794:26 CallExpression ";" equivalent: the default of a switch that has handled every kind of Added is unreachable.
- src/node/bootstrap.ts:800:5-800:44 CallExpression ";" harmless: the retry the pass ends with after the stop reads which queued staples are due, and the ledger refuses to be offered any of them once stopped (#offer).
- src/node/bootstrap.ts:827:4-828:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled both ways of taking is unreachable.
- src/node/bootstrap.ts:834:4-835:16 ConditionalExpression "case 'add':" equivalent: an update adds only when it found the stage empty and no ranges, and adding stages nothing, so the stage names none either way.
- src/node/bootstrap.ts:838:4-839:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled both ways of taking is unreachable.
- src/node/bootstrap.ts:991:4-998:5 ConditionalExpression "case 'crowded':" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:991:9-991:18 StringLiteral "\"\"" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:991:20-998:5 BlockStatement "{}" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:993:9-993:48 ConditionalExpression "true" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:993:9-993:48 ConditionalExpression "false" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:993:9-993:48 EqualityOperator "this.#crowdedAt.get(endpoint) !== start" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:993:50-995:6 BlockStatement "{}" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:994:38-994:229 StringLiteral "``" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:996:5-996:42 CallExpression ";" harmless: only the warning of a pass that ended naming MAX_NAMED staples from one start changes; 20,000 staples at one moment are more than a test of the client can serve.
- src/node/bootstrap.ts:999:4-1000:24 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of PassEvent is unreachable.
- src/node/bootstrap.ts:1000:5-1000:24 CallExpression ";" equivalent: the default of a switch that has handled every kind of PassEvent is unreachable.
- src/node/bootstrap.ts:1011:213-1011:222 StringLiteral "\"\"" harmless: only the text of the log line of a split off a range no peer read changes.
- src/node/bootstrap.ts:1019:4-1020:24 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of RangeEvent is unreachable.
- src/node/bootstrap.ts:1020:5-1020:24 CallExpression ";" equivalent: the default of a switch that has handled every kind of RangeEvent is unreachable.
- src/node/bootstrap.ts:150:3-151:31 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of Added is unreachable.
- src/node/bootstrap.ts:618:8-618:23 ConditionalExpression "false" harmless: a client stopped while it asks for lacked blocks then goes on to each further block, whose requests fail at once on the aborted signal, and records it unanswered, which a stopped client never reads again.
- src/node/bootstrap.ts:618:25-620:5 BlockStatement "{}" harmless: a client stopped while it asks for lacked blocks then goes on to each further block, whose requests fail at once on the aborted signal, and records it unanswered, which a stopped client never reads again.
- src/node/bootstrap.ts:648:9-648:24 ConditionalExpression "false" harmless: a client stopped while it asks a peer for a block then warns that asking failed, and asks the next peer, whose request fails at once on the aborted signal.
- src/node/bootstrap.ts:648:26-650:6 BlockStatement "{}" harmless: a client stopped while it asks a peer for a block then warns that asking failed, and asks the next peer, whose request fails at once on the aborted signal.
- src/node/bootstrap.ts:649:13-649:18 BooleanLiteral "true" harmless: a client stopped while it asks a peer for a block then records the block as answered, which a stopped client never reads again.
- src/node/bootstrap.ts:663:9-663:25 ConditionalExpression "true" harmless: a client stopped while it adds a lacked block's staple then also warns that the add failed.
- src/node/bootstrap.ts:669:5-669:34 CallExpression ";" harmless: a block the ledger now holds then keeps its count of unanswered asks, which nothing reads again, as no deferred staple awaits a held block.
- src/node/bootstrap.ts:671:12-671:16 BooleanLiteral "false" harmless: a block the ledger now holds is then counted as asked once more, which nothing reads again, as no deferred staple awaits a held block.
- src/node/bootstrap.ts:195:39-195:70 ConditionalExpression "true" equivalent: only a PageError of kind status has a status, so for any other kind the status list finds none, as the kind check does.
- src/node/bootstrap.ts:898:20-900:6 MethodExpression "Math.max(...built.votes.map(function (vote): number {\n  return vote.validityFrom.getTime();\n}))" harmless: the lookup then starts at the staple's latest vote, and a peer keyed by votes begins the read from there at that vote, so it lists the staple for that vote as it would for its earliest.
- src/node/bootstrap-pacing.ts:44:43-44:57 ObjectLiteral "{}" equivalent: the listener is removed once the wait ends, and a signal is aborted at most once, so it runs at most once either way.
- src/node/bootstrap-page.ts:266:54-266:58 BooleanLiteral "false" harmless: an https peer's pages then each open a connection of their own instead of reusing one; the pages read are the same.

## bootstrap-pass

Harmless here means a pass holds, queues or stages the same staples by the
end of the passes over a peer, and concludes nothing on weaker evidence:
what changes is how many requests it takes, or what a peer sends again. No
entry rests on a deep re-scan reading a staple again, as a deep re-scan runs
the same code.

- src/node/bootstrap-pass.ts:205:7-205:37 ConditionalExpression "true" equivalent: while no answer has been too large, the comparison that follows is with undefined, which is false for any limit, as the check it replaces makes it.
- src/node/bootstrap-pass.ts:222:7-222:37 ConditionalExpression "true" equivalent: while no answer has been too large, the comparison that follows is with undefined, which is false for any limit, as the check it replaces makes it.
- src/node/bootstrap-pass.ts:228:7-228:37 ConditionalExpression "true" equivalent: while no answer has been too large, the comparison that follows is with undefined and false; while one has, the check is true as before.
- src/node/bootstrap-pass.ts:228:7-228:68 LogicalOperator "this.#tooLargeAt !== undefined || doubled >= this.#tooLargeAt" equivalent: while no answer has been too large, the comparison is with undefined and false, as the check made the whole; while one has, a page is asked for at most the size, so the size halves from a limit no smaller than the fewest staples an answer was too large for, and the size doubled to, capped no lower than any limit asked for, is never short of it, so both are true and only the count of full pages decides.
- src/node/bootstrap-pass.ts:228:41-228:68 ConditionalExpression "true" equivalent: while no answer has been too large, the check before it is false; while one has, a page is asked for at most the size, so the size halves from a limit no smaller than the fewest staples an answer was too large for, and the size doubled to, capped no lower than any limit asked for, is never short of it.
- src/node/bootstrap-pass.ts:251:3-252:30 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of PassIdentity is unreachable.
- src/node/bootstrap-pass.ts:426:3-427:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of PassOutcome is unreachable.
- src/node/bootstrap-pass.ts:437:3-438:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled both statuses of a settled promise is unreachable.
- src/node/bootstrap-pass.ts:718:11-720:5 BlockStatement "{}" harmless: a full page then does not start the count of short pages again, which only moves when the horizon is probed; each probe concludes only what it shows.
- src/node/bootstrap-pass.ts:727:45-727:69 ConditionalExpression "true" harmless: a short page then calls for a move before the peer sent anything from the start, which only changes when the pass asks for one; a move is made only as a page shows it.
- src/node/bootstrap-pass.ts:727:45-727:69 EqualityOperator "this.#named.received >= 0" harmless: a short page then calls for a move before the peer sent anything from the start, which only changes when the pass asks for one; a move is made only as a page shows it.
- src/node/bootstrap-pass.ts:746:8-746:12 ConditionalExpression "false" equivalent: a page that fits then goes on to the bound on names, which it is under, and is named as the block does; a filter that fitted it named fewer than BLOOM_CAPACITY, so its rate is at most the one the pass accepts and no further filter checks a move.
- src/node/bootstrap-pass.ts:746:14-749:5 BlockStatement "{}" equivalent: a page that fits then goes on to the bound on names, which it is under, and is named as the block does; a filter that fitted it named fewer than BLOOM_CAPACITY, so its rate is at most the one the pass accepts and no further filter checks a move.
- src/node/bootstrap-pass.ts:751:8-751:42 ArithmeticOperator "this.#named.received - page.length" harmless: the pass then ends at its start only once it names up to two pages more than MAX_NAMED, each at a higher rate, which the further filters check before any move as they do below it.
- src/node/bootstrap-pass.ts:751:8-751:54 EqualityOperator "this.#named.received + page.length >= MAX_NAMED" harmless: the pass ends at its start with one staple fewer named, at exactly MAX_NAMED.
- src/node/bootstrap-pass.ts:772:49-772:91 EqualityOperator "now - this.#began > MAX_PASS_MILLISECONDS" harmless: a pass then makes its next request at exactly its bound in time before it ends.
- src/node/bootstrap-pass.ts:801:7-801:16 ConditionalExpression "false" equivalent: the room is at most 0 only when the filter names BLOOM_CAPACITY staples or more, the priming window being at least PRIMING_FLOOR, and NamedStaples.hold then names none of what the read returns, whatever the count it was asked for (the client's read for a negative count is not empty).
- src/node/bootstrap-pass.ts:801:7-801:16 EqualityOperator "room < 0" equivalent: the room is at most 0 only when the filter names BLOOM_CAPACITY staples or more, the priming window being at least PRIMING_FLOOR, and NamedStaples.hold then names none of what the read returns, whatever the count it was asked for (the client's read for a negative count is not empty).
- src/node/bootstrap-pass.ts:801:18-803:4 BlockStatement "{}" equivalent: the room is at most 0 only when the filter names BLOOM_CAPACITY staples or more, the priming window being at least PRIMING_FLOOR, and NamedStaples.hold then names none of what the read returns, whatever the count it was asked for (the client's read for a negative count is not empty).
- src/node/bootstrap-pass.ts:813:7-813:14 EqualityOperator "at > 0" harmless: after a move, what the node holds is then not named when the staple the move was shown by is the first it lists, so the peer sends it again, where it is found held.
- src/node/bootstrap-pass.ts:814:15-814:29 MethodExpression "held" harmless: after a move, what the node holds is then named from before the staple the move was shown by too, which only changes what the peer sends again.
- src/node/bootstrap-pass.ts:837:4-838:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of PassAnswer is unreachable.
- src/node/bootstrap-pass.ts:855:9-855:45 ConditionalExpression "true" equivalent: with the whole page listed in full, every staple is in the reads listed in full, which shows and shownTarget weigh before the votes counted, so counting them changes nothing.
- src/node/bootstrap-pass.ts:855:9-855:45 EqualityOperator "evidence.wholeBelow <= staples.length" equivalent: with the whole page listed in full, every staple is in the reads listed in full, which shows and shownTarget weigh before the votes counted, so counting them changes nothing.
- src/node/bootstrap-pass.ts:862:4-863:47 ConditionalExpression "default:" equivalent: the default of a switch that has handled every PeerKeying is unreachable.
- src/node/bootstrap-pass.ts:879:4-880:35 ConditionalExpression "default:" equivalent: the default of a switch that has handled both ways the window narrows is unreachable.
- src/node/bootstrap-pass.ts:899:29-899:31 ArrayDeclaration "[\"Stryker was here\"]" harmless: the outcomes a check reads are then those of the staples before each, which only matters for a staple it lacked: a page that shows it read every key up to the moment listed every staple keyed there that no filter names, and the pass took each before it weighs the check, so the move it allows holds either way.
- src/node/bootstrap-pass.ts:908:4-908:20 CallExpression ";" harmless: a staple listed twice in one page then counts as one the node held before the page, which only makes the pass name what the node holds again after a move.
- src/node/bootstrap-pass.ts:935:45-935:47 UnaryOperator "+1" equivalent: with no target, the guard after it returns before the staple is read.
- src/node/bootstrap-pass.ts:936:7-936:27 ConditionalExpression "false" equivalent: the staple is undefined exactly when the target is, its index being a staple of the page.
- src/node/bootstrap-pass.ts:936:7-936:56 LogicalOperator "target === undefined && shownStaple === undefined" equivalent: the staple is undefined exactly when the target is, its index being a staple of the page.
- src/node/bootstrap-pass.ts:936:31-936:56 ConditionalExpression "false" equivalent: the target's index is that of a staple of the page, so the staple is defined whenever the target is.
- src/node/bootstrap-pass.ts:945:12-945:64 EqualityOperator "stamp > target.at - VOTE_KEY_TOLERANCE_MILLISECONDS" harmless: a staple of the page with a vote made exactly the tolerance before the moment moved to is then not named in the next filter, so the peer may send it again, where it is found held.
- src/node/bootstrap-pass.ts:1044:7-1044:29 EqualityOperator "this.#start > horizon" harmless: a start exactly at the horizon then probes the horizon rather than conclude at once, which concludes the same once the probe shows it.
- src/node/bootstrap-pass.ts:1050:19-1052:5 MethodExpression "evidence.page.every(function (_staple, index): boolean {\n  return shows(evidence, index, horizon);\n})" harmless: a pass over a range then probes its horizon less often, or more, which only changes how many requests it takes to conclude; a probe concludes only what it shows.
- src/node/bootstrap-pass.ts:1050:72-1052:4 BlockStatement "{}" harmless: a pass over a range then probes its horizon less often, or more, which only changes how many requests it takes to conclude; a probe concludes only what it shows.
- src/node/bootstrap-pass.ts:1053:7-1053:15 BooleanLiteral "mayShow" harmless: a pass over a range then probes its horizon less often, or more, which only changes how many requests it takes to conclude; a probe concludes only what it shows.
- src/node/bootstrap-pass.ts:1053:7-1053:83 ConditionalExpression "false" harmless: a pass over a range then probes its horizon less often, or more, which only changes how many requests it takes to conclude; a probe concludes only what it shows.
- src/node/bootstrap-pass.ts:1053:46-1053:83 ConditionalExpression "true" harmless: a pass over a range then probes its horizon less often, or more, which only changes how many requests it takes to conclude; a probe concludes only what it shows.
- src/node/bootstrap-pass.ts:1053:46-1053:83 EqualityOperator "evidence.keying.current === 'unknown'" harmless: a pass over a range then probes its horizon less often, or more, which only changes how many requests it takes to conclude; a probe concludes only what it shows.
- src/node/bootstrap-pass.ts:1053:74-1053:83 StringLiteral "\"\"" harmless: a pass over a range then probes its horizon less often, or more, which only changes how many requests it takes to conclude; a probe concludes only what it shows.
- src/node/bootstrap-pass.ts:1053:85-1055:4 BlockStatement "{}" harmless: a pass over a range then probes its horizon less often, or more, which only changes how many requests it takes to conclude; a probe concludes only what it shows.
- src/node/bootstrap-pass.ts:1072:8-1072:25 ConditionalExpression "false" harmless: a pass checking a conclusion past its bound then makes the checking requests it has begun before it ends.
- src/node/bootstrap-pass.ts:1072:27-1074:5 BlockStatement "{}" harmless: a pass checking a conclusion past its bound then makes the checking requests it has begun before it ends.
- src/node/bootstrap-pass.ts:1080:26-1080:33 ArrayDeclaration "[]" harmless: a staple a further filter found is then not named, so the next page from the start lists it again, where it is found held.
- src/node/bootstrap-pass.ts:1110:15-1110:20 BooleanLiteral "true" harmless: a peer keyed by when it applied them is then checked by votes as well, a stricter check that only defers a move until a page shows it.
- src/node/bootstrap-pass.ts:1118:4-1119:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every PeerKeying is unreachable.
- src/node/bootstrap-pass.ts:1133:11-1133:19 BooleanLiteral "byOrder" equivalent: the staple listed first from the moment, under the same filter, is listed from the start too, so a page from the start is empty only when no staple is listed from the moment either.
- src/node/bootstrap-pass.ts:1133:11-1133:43 ConditionalExpression "true" equivalent: the staple listed first from the moment, under the same filter, is listed from the start too, so a page from the start is empty only when no staple is listed from the moment either.
- src/node/bootstrap-pass.ts:1136:3-1136:31 CallExpression ";" harmless: the staples a check was listed are then not named, so the next page from the start lists them again, where they are found held.
- src/node/bootstrap-pass.ts:1141:7-1141:15 ConditionalExpression "false" harmless: a peer keyed by when it applied them is then checked by votes as well, a stricter check that only defers a move until a page shows it.
- src/node/bootstrap-pass.ts:1141:17-1143:4 BlockStatement "{}" harmless: a peer keyed by when it applied them is then checked by votes as well, a stricter check that only defers a move until a page shows it.
- src/node/bootstrap-pass.ts:1145:11-1145:37 ConditionalExpression "true" harmless: the check by votes then overlooks a staple it lacked, or counts one it held, which the page that checks took before it weighs the check: a page that shows it read every key up to the moment listed every staple keyed there that no filter names.
- src/node/bootstrap-pass.ts:1145:31-1145:37 StringLiteral "\"\"" harmless: the check by votes then overlooks a staple it lacked, or counts one it held, which the page that checks took before it weighs the check: a page that shows it read every key up to the moment listed every staple keyed there that no filter names.
- src/node/bootstrap-pass.ts:1147:17-1149:5 MethodExpression "listed.every(function (_staple, index): boolean {\n  return shows(evidence, index, to);\n})" harmless: the check by votes then asks that every staple of the page show the moment rather than one, a stricter check that only defers a move until a page shows it.
- src/node/bootstrap-pass.ts:1154:10-1154:60 OptionalChaining "(await this.#request(at, 1, bloomFilter)).staples" equivalent: a request for one staple never comes back too large but fails the pass instead, and a peer that gives up on it is asked again or fails the pass, so an answer is always given.
- src/node/bootstrap-pass.ts:1166:7-1166:12 ConditionalExpression "false" harmless: how much of a page a move leaves behind changes only how many of its staples the next filter names, and so how many the peer sends again.
- src/node/bootstrap-pass.ts:1166:7-1166:12 ConditionalExpression "true" harmless: how much of a page a move leaves behind changes only how many of its staples the next filter names, and so how many the peer sends again.
- src/node/bootstrap-pass.ts:1166:14-1168:4 BlockStatement "{}" harmless: how much of a page a move leaves behind changes only how many of its staples the next filter names, and so how many the peer sends again.
- src/node/bootstrap-pass.ts:1167:13-1167:95 MethodExpression "Math.min(1, Math.min(page.length - 1, Math.ceil(page.length * EARLY_REACH_SHARE)))" harmless: how much of a page a move leaves behind changes only how many of its staples the next filter names, and so how many the peer sends again.
- src/node/bootstrap-pass.ts:1167:25-1167:94 MethodExpression "Math.max(page.length - 1, Math.ceil(page.length * EARLY_REACH_SHARE))" harmless: how much of a page a move leaves behind changes only how many of its staples the next filter names, and so how many the peer sends again.
- src/node/bootstrap-pass.ts:1167:34-1167:49 ArithmeticOperator "page.length + 1" harmless: how much of a page a move leaves behind changes only how many of its staples the next filter names, and so how many the peer sends again.
- src/node/bootstrap-pass.ts:1167:61-1167:92 ArithmeticOperator "page.length / EARLY_REACH_SHARE" harmless: how much of a page a move leaves behind changes only how many of its staples the next filter names, and so how many the peer sends again.
- src/node/bootstrap-pass.ts:1175:24-1175:52 ConditionalExpression "true" harmless: the probes for how far one page reached are then bounded only by the pass's own bounds, one more or many, which only changes how many requests a page takes.
- src/node/bootstrap-pass.ts:1175:24-1175:52 EqualityOperator "probes <= MAX_PROBES_PER_PAGE" harmless: the probes for how far one page reached are then bounded only by the pass's own bounds, one more or many, which only changes how many requests a page takes.
- src/node/bootstrap-pass.ts:1175:76-1175:84 UpdateOperator "probes--" harmless: the probes for how far one page reached are then bounded only by the pass's own bounds, one more or many, which only changes how many requests a page takes.
- src/node/bootstrap-pass.ts:1193:8-1193:22 EqualityOperator "from > enough" harmless: the probing then goes on one probe further when a moment already leaves few enough staples of the page to name.
- src/node/bootstrap-evidence.ts:103:3-104:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every PeerKeying is unreachable.
- src/node/bootstrap-evidence.ts:116:3-117:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every PeerKeying is unreachable.
- src/node/bootstrap-evidence.ts:155:71-155:109 OptionalChaining "(forEarlier ?? staples[0]).blocksHash" equivalent: a page that changes what the pass knows of the peer lists a staple, twice or for earlier votes, so the staple it names exists.
- src/node/bootstrap-evidence.ts:155:124-155:126 StringLiteral "\"Stryker was here!\"" equivalent: a page that changes what the pass knows of the peer lists a staple, twice or for earlier votes, so the staple it names exists.
- src/node/bootstrap-evidence.ts:193:7-193:28 ConditionalExpression "false" equivalent: with fewer votes than asked for, the index past them answers undefined, as the guard does.
- src/node/bootstrap-evidence.ts:193:30-195:4 BlockStatement "{}" equivalent: with fewer votes than asked for, the index past them answers undefined, as the guard does.
- src/node/bootstrap-evidence.ts:273:3-274:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every PeerKeying is unreachable.
- src/node/bootstrap-window.ts:105:6-105:23 ConditionalExpression "true" equivalent: the key is a function of the staple's bytes, which a staple never changes; the cache only saves hashing them again.
- src/node/bootstrap-window.ts:107:3-107:25 CallExpression ";" equivalent: the key is a function of the staple's bytes, which a staple never changes; the cache only saves hashing them again.

## bootstrap-pipeline

Harmless here means the node ends up holding, queuing and staging the same
staples, in an order its votes allow: what changes is when, how many rounds
or requests it takes, how much memory it keeps, or a count it logs.

- src/node/bootstrap-ranges.ts:222:153-222:157 BooleanLiteral "false" equivalent: with the front at infinity every range runs, whether or not the ranges read ahead do.
- src/node/bootstrap-ranges.ts:236:15-236:32 ArithmeticOperator "ranges.length + 1" equivalent: the loop then first steps over two indices past the end, whose ranges are undefined and so have no peer, to the same latest range.
- src/node/bootstrap-ranges.ts:237:9-237:19 EqualityOperator "latest >= 0" equivalent: the loop stops at the first range then, which has no peer when it runs, and the handover needs a latest past the first either way.
- src/node/bootstrap-ranges.ts:237:23-237:43 OptionalChaining "ranges[latest].peer" equivalent: the loop reads only indices of ranges that exist.
- src/node/bootstrap-ranges.ts:241:6-241:25 ConditionalExpression "true" equivalent: a layout with no range is moved on from before any schedule runs, so the first range always exists.
- src/node/bootstrap-ranges.ts:241:79-241:98 ConditionalExpression "true" equivalent: the latest index is that of a range that exists.
- src/node/bootstrap-ranges.ts:274:7-274:31 ConditionalExpression "true" equivalent: the last range's end computed as the beginning plus every share is the end itself: dividing an integer below 2^53 by a count of peers and multiplying it back rounds to the same integer (checked over two million layouts), and were it a millisecond short, the peers move on to the overlap before the layout's end, which reads it again.
- src/node/bootstrap-ranges.ts:274:7-274:31 EqualityOperator "index <= peers.length - 1" equivalent: the last range's end computed as the beginning plus every share is the end itself: dividing an integer below 2^53 by a count of peers and multiplying it back rounds to the same integer (checked over two million layouts), and were it a millisecond short, the peers move on to the overlap before the layout's end, which reads it again.
- src/node/bootstrap-ranges.ts:274:15-274:31 ArithmeticOperator "peers.length + 1" equivalent: the last range's end computed as the beginning plus every share is the end itself: dividing an integer below 2^53 by a count of peers and multiplying it back rounds to the same integer (checked over two million layouts), and were it a millisecond short, the peers move on to the overlap before the layout's end, which reads it again.
- src/node/bootstrap-ranges.ts:326:3-327:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every RangeResult is unreachable.
- src/node/bootstrap-ranges.ts:340:3-341:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled every RangeResult is unreachable.
- src/node/bootstrap-ranges.ts:411:20-411:24 BooleanLiteral "false" equivalent: a schedule runs as soon as it is built, so no time has passed for its first claim either way.
- src/node/bootstrap-ranges.ts:549:3-549:28 CallExpression ";" harmless: a pass that ended is then counted as under way when the range it read is weighed for a split later in the same update, which only changes which range a free peer splits.
- src/node/bootstrap-ranges.ts:552:7-552:29 ConditionalExpression "false" equivalent: a range whose pass completed is dropped from the layout as the pass settles, so the pace recorded for it is never read.
- src/node/bootstrap-ranges.ts:552:18-552:29 StringLiteral "\"\"" equivalent: a range whose pass completed is dropped from the layout as the pass settles, so the pace recorded for it is never read.
- src/node/bootstrap-retry.ts:172:3-173:31 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of Awaited is unreachable.
- src/node/bootstrap-retry.ts:173:4-173:31 CallExpression ";" equivalent: the default of a switch that has handled every kind of Awaited is unreachable.
- src/node/bootstrap-retry.ts:282:4-283:30 ConditionalExpression "default:" equivalent: the default of a switch that has handled every QueueUse is unreachable.
- src/node/bootstrap-retry.ts:342:4-343:34 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of Offered is unreachable.
- src/node/bootstrap-retry.ts:392:7-392:25 ConditionalExpression "true" equivalent: the ledger answers whether the weight of no set of voters suffices with no answer, so nothing more is due.
- src/node/bootstrap-retry.ts:392:7-392:25 EqualityOperator "weighed.length >= 0" equivalent: the ledger answers whether the weight of no set of voters suffices with no answer, so nothing more is due.
- src/node/bootstrap-retry.ts:428:5-429:35 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of Offered is unreachable.
- src/node/bootstrap-retry.ts:476:7-476:28 ConditionalExpression "false" equivalent: #put is called only for an entry the queue holds, by retries that run one at a time, so the entry is always found.
- src/node/bootstrap-retry.ts:476:30-478:4 BlockStatement "{}" equivalent: #put is called only for an entry the queue holds, by retries that run one at a time, so the entry is always found.
- src/node/bootstrap-retry.ts:486:7-486:28 ConditionalExpression "false" equivalent: #remove is called only for an entry the queue holds, by retries that run one at a time, so the entry is always found.
- src/node/bootstrap-retry.ts:486:30-488:4 BlockStatement "{}" equivalent: #remove is called only for an entry the queue holds, by retries that run one at a time, so the entry is always found.
- src/node/bootstrap-retry.ts:519:8-519:33 ConditionalExpression "true" equivalent: nothing sets the load kept while it is under way, so a load that fails is always the one kept.
- src/node/bootstrap-stage.ts:227:8-227:31 ConditionalExpression "true" equivalent: the counts kept after a read are only ever changes chained on that read, which fail with it, so a failed read is always the one kept or its successors fail too; a read after clearing them reads the stage again.
- src/node/bootstrap-stage.ts:291:34-291:49 ObjectLiteral "{}" equivalent: the flag is read as false until the work ends either way, undefined being falsy.
- src/node/bootstrap-stage.ts:312:22-312:54 ConditionalExpression "true" equivalent: the one case it differs in, the work done with staples left and the queue not full nor the time up, continued the loop on the line before.
- src/node/bootstrap-stage.ts:318:29-318:55 ArrayDeclaration "[]" harmless: a failing adding then rejects before the batch read ahead is dropped and the removal under way ends; the removal still ends, and the caller hears the error that failed the adding.
- src/node/bootstrap-stage.ts:347:30-347:79 EqualityOperator "this.#stagedSinceAhead >= last.firstVote.getTime()" harmless: a staple staged meanwhile whose earliest vote ties that of the batch's last is added in the batch after rather than in key order among staples of that moment, which depend on none of each other but by the slop a refusal and its retry cover.
- src/node/bootstrap-stage.ts:353:73-353:91 ArrayDeclaration "[]" harmless: a staple still leaving the stage may be read again, found held or queued, and counted as leaving twice in the log line's count.
- src/node/bootstrap-stage.ts:381:30-383:4 BlockStatement "{}" harmless: a staple still leaving the stage may be read again, found held or queued, and counted as leaving twice in the log line's count.
- src/node/bootstrap-stage.ts:382:4-382:27 CallExpression ";" harmless: a staple still leaving the stage may be read again, found held or queued, and counted as leaving twice in the log line's count.
- src/node/bootstrap-stage.ts:409:15-409:20 BooleanLiteral "true" harmless: the queue is then offered again after a round that added nothing, which offers only the staples due anyway.
- src/node/bootstrap-stage.ts:425:14-425:33 ConditionalExpression "true" harmless: the queue is then offered again after a round that added nothing, which offers only the staples due anyway.
- src/node/bootstrap-stage.ts:429:7-429:26 ConditionalExpression "true" equivalent: with no batch read ahead, the batch to add next is undefined either way.
- src/node/bootstrap-stage.ts:435:7-435:20 ConditionalExpression "true" harmless: the queue is then offered again after a round that added nothing, which offers only the staples due anyway.

## api

- src/api/account.ts:87:4-88:24 ConditionalExpression "default:" equivalent: the default of a switch that has handled both kinds of requested account is unreachable.
- src/api/account.ts:88:5-88:24 CallExpression ";" equivalent: the default of a switch that has handled both kinds of requested account is unreachable.
- src/api/account.ts:98:6-98:25 ConditionalExpression "false" equivalent: accountStates answers one state per account requested, so the one account requested always has a state.
- src/api/account.ts:98:27-100:3 BlockStatement "{}" equivalent: accountStates answers one state per account requested, so the one account requested always has a state.
- src/api/account.ts:99:19-99:80 StringLiteral "\"\"" equivalent: accountStates answers one state per account requested, so the one account requested always has a state.
- src/api/account.ts:117:36-117:82 OptionalChaining "heights[account.publicKeyString.get()].height" equivalent: the block heights name every account asked for [Keeta TS] index.js:68683-68701, so the account's entry is always present.
- src/api/node.ts:47:3-48:30 ConditionalExpression "default:" equivalent: the default of a switch that has handled both kinds of peer is unreachable.
- src/api/order.ts:14:22-14:65 EqualityOperator "index <= Math.min(left.length, right.length)" equivalent: every entry of one list is keyed by as many texts, so the extra index reads '' on both sides, which orders nothing.
- src/api/order.ts:14:30-14:65 MethodExpression "Math.max(left.length, right.length)" equivalent: every entry of one list is keyed by as many texts, so the bound is the same.
- src/api/order.ts:15:44-15:46 StringLiteral "\"Stryker was here!\"" equivalent: the index stays below the length of both keys, so the fallback is never read.
- src/api/order.ts:15:64-15:66 StringLiteral "\"Stryker was here!\"" equivalent: the index stays below the length of both keys, so the fallback is never read.
- src/api/order.ts:20:9-20:35 ArithmeticOperator "left.length + right.length" equivalent: no two entries of one list share every key (a balance per token, a permission row per principal, entity and target, a vote per ID), so the length comparison is never reached.
- src/api/order.ts:54:3-55:29 ConditionalExpression "default:" equivalent: the default of a switch that has handled both principal types is unreachable.
- src/api/route.ts:132:3-133:31 ConditionalExpression "default:" equivalent: the default of a switch that has handled both methods is unreachable.
- src/api/route.ts:140:14-140:16 StringLiteral "\"Stryker was here!\"" equivalent: every parameter segment ranks with the same text either way, so no order or match key changes.
- src/api/route.ts:153:17-153:68 MethodExpression "Math.max(leftSegments.length, rightSegments.length)" equivalent: a segment past the shorter path reads as the fixed segment '', which sorts at or before any segment, so the shorter path still comes first, as the length comparison orders it.
- src/api/route.ts:154:22-154:36 EqualityOperator "index <= shared" equivalent: a segment past the shorter path reads as the fixed segment '', which sorts at or before any segment, so the shorter path still comes first, as the length comparison orders it.
- src/api/route.ts:155:67-155:69 StringLiteral "\"Stryker was here!\"" equivalent: the index stays below the length of both paths, so the fallback is never read.
- src/api/route.ts:156:70-156:72 StringLiteral "\"Stryker was here!\"" equivalent: the index stays below the length of both paths, so the fallback is never read.
- src/api/route.ts:174:36-174:39 StringLiteral "\"\"" equivalent: a segment's rank is a one-digit kind, 0 only before a fixed text and 1 alone for a parameter, and the joined ranks are split by '/', which no segment holds, so the match keys stay distinct without the colon.
- src/api/route.ts:175:10-175:13 StringLiteral "\"\"" equivalent: routeTable refuses a segment holding a colon that no backslash escapes before it reads a match key, so each colon that joins ranks follows a kind digit and each colon of a text follows a backslash, and the joined ranks split apart again without the slash.

## p2p

The peer-to-peer surface and what keeps it closed. No entry is in code that
decides whether a network is closed: every mutant of the closure, of the
write mode that votes and of the networks a node's ID names is killed, and
none of what the node holds of a connection outlives the connection. The
entries are:

* the unreachable defaults of switches, and a local network that falls
  through to the case of the known networks and still names no public one;
* the separators of a list of alternatives that is never two words long;
* checks of a message that a refusal of the switch's parser already decides;
* a starting count that the loop after it always sets;
* in the connections a switch holds, steps that the order in which upstream
  registers and unregisters a connection makes unnecessary: a resolver set
  at once, a closing of a connection already closed, a lookup that answers
  the entry it is given, and markings that are set again before anything
  reads them.

- src/api/p2p.ts:79:6-79:17 ConditionalExpression "false" equivalent: a refusal of the parser carries no type [Keeta TS] index.js:73912-73923, so the message read from it has none, which republishedMessage refuses as a type it does not act on.
- src/api/p2p.ts:79:19-81:3 BlockStatement "{}" equivalent: a refusal of the parser carries no type [Keeta TS] index.js:73912-73923, so the message read from it has none, which republishedMessage refuses as a type it does not act on.
- src/api/p2p.ts:88:9-88:34 ConditionalExpression "true" equivalent: an absent TTL is not at least 1, so the message is not relayed either way.
- src/api/p2p.ts:131:3-132:22 ConditionalExpression "default:" equivalent: without its return the default falls out of the switch, and the function answers undefined all the same.
- src/node/config.ts:110:3-111:30 ConditionalExpression "default:" equivalent: the default of a switch that has handled every write mode is unreachable.
- src/node/config.ts:535:3-536:22 ConditionalExpression "case 'local':" equivalent: a local selection falling through to the case of the known networks names no alias, which no public network matches, so it still names none.
- src/node/config.ts:541:3-542:35 ConditionalExpression "default:" equivalent: the default of a switch that has handled both kinds of network selection is unreachable.
- src/node/config.ts:971:3-972:41 ConditionalExpression "default:" equivalent: the default of a switch that has handled every write mode is unreachable.
- src/node/config.ts:1003:6-1003:22 EqualityOperator "words.length <= 2" equivalent: alternatives is given one word or three, never two: the write modes that do not vote, and those open on a network, which are no-voting alone on main and test and three on dev and staging.
- src/node/config.ts:1004:21-1004:23 StringLiteral "\"Stryker was here!\"" equivalent: a list of fewer than two words places no separator.
- src/node/config.ts:1006:69-1006:71 StringLiteral "\"Stryker was here!\"" equivalent: the last word alone places no separator.
- src/node/config.ts:1039:3-1040:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled both reasons for a closure is unreachable.
- src/node/connections.ts:21:4-21:22 OptionalChaining "resolvePromise()" equivalent: a promise's executor runs as the promise is built, so the resolver is always set by the time it is called.
- src/node/connections.ts:80:9-80:26 ConditionalExpression "true" equivalent: closing a connection already aborted only marks it aborted again and closes a socket that is already closing [Keeta TS] index.js:73565-73573, which does nothing.
- src/node/connections.ts:105:7-105:28 ConditionalExpression "true" equivalent: for a connection already tracked, the connection is not among those released, and #track answers its entry as it is.
- src/node/connections.ts:106:8-106:38 ConditionalExpression "true" equivalent: the switch registers a WebSocket connection as it attaches it, on a socket already open [Keeta TS] index.js:73436-73449, 73478-73489, so a connection being unregistered is tracked or released, and one that is neither, which the original would track, never reaches here.
- src/node/connections.ts:124:3-124:37 CallExpression ";" equivalent: whether a connection is released is read only while it is not tracked, and it stops being tracked only as it is marked released again.
- src/node/connections.ts:128:20-128:25 BooleanLiteral "true" equivalent: a registration marks its connection to be unregistered as it ends, and nothing reads the mark before: #settle returns while a registration is in flight, and #unregister, the only other caller of #track, never reaches it (see the entry for line 106).
- src/node/peer-store.ts:57:44-57:158 ObjectLiteral "{}" equivalent: the loop below sets the count of every arena of PEER_ARENAS, so no starting zero is ever read.

## config

How the node reads its environment, and the node upstream is given from it:
the rest of config.ts, beside the parts that close a network to peers, which
the p2p section holds. Every refusal says what it says, and keeps the
client's reason where the variable is not secret. The entries are:

* the unreachable defaults of switches;
* the fallbacks of the two endpoints of a manual peer, which the count of its
  fields already ensures.

- src/node/config.ts:222:3-223:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled every kind of problem is unreachable.
- src/node/config.ts:556:3-557:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled both kinds of network selection is unreachable.
- src/node/config.ts:689:15-689:17 StringLiteral "\"Stryker was here!\"" equivalent: a peer reaches this line only with at least two fields after its key, so the API endpoint is always given.
- src/node/config.ts:689:25-689:27 StringLiteral "\"Stryker was here!\"" equivalent: a peer reaches this line only with at least two fields after its key, so the p2p endpoint is always given.
- src/node/config.ts:805:3-806:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled both kinds of network selection is unreachable.
- src/node/config.ts:930:3-931:34 ConditionalExpression "default:" equivalent: the default of a switch that has handled both fee schedules is unreachable.
- src/node/config.ts:1128:3-1129:35 ConditionalExpression "default:" equivalent: the default of a switch that has handled both kinds of network selection is unreachable.
- src/node/config.ts:1140:3-1141:36 ConditionalExpression "default:" equivalent: the default of a switch that has handled both ways of receiving updates is unreachable.
