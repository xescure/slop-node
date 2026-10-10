# Surviving mutants

Every mutant that survives `make mutation` is listed here, and `make mutation`
fails while one is not. An entry names exactly one mutant: where its replaced
code starts and ends, its mutator, and its replacement as a JSON string, as
Stryker reports them:

`- <file>:<line>:<column>-<line>:<column> <mutator> <replacement> <equivalent|harmless>: <reason>`

An equivalent mutant behaves as the original does for every input the code can
receive, so no test can kill it. A harmless mutant changes behavior that no
caller can observe through the storage contract. Equivalent mutants leave the
module's score after triage; harmless ones count against it.

## storage

- src/ledger/storage/base.ts:35:99-40:3 BlockStatement "{}" equivalent: upstream folds only the ledger checksum into a transaction's statistics [Keeta TS] index.js:69415, and the override drops that key either way.
- src/ledger/storage/base.ts:36:7-36:34 ConditionalExpression "true" equivalent: dropping every key drops only the ledger checksum, the one key upstream ever folds in [Keeta TS] index.js:69415.
- src/ledger/storage/base.ts:39:3-39:26 CallExpression ";" equivalent: only a key other than the ledger checksum reaches super.xor, and upstream folds no other key [Keeta TS] index.js:69415.
- src/ledger/storage/base.ts:57:7-57:33 ConditionalExpression "true" equivalent: assigning the absent node assigns undefined, which every reader sees as no node.
- src/ledger/storage/base.ts:189:4-190:33 ConditionalExpression "default:" equivalent: the default of a switch that has handled both driver states is unreachable.
- src/ledger/storage/base.ts:274:7-274:27 ConditionalExpression "false" equivalent: without the early return, getVoteStaples of no hashes answers an empty map, which maps to the same empty list.
- src/ledger/storage/base.ts:274:29-276:4 BlockStatement "{}" equivalent: without the early return, getVoteStaples of no hashes answers an empty map, which maps to the same empty list.
- src/ledger/storage/base.ts:280:8-280:47 ConditionalExpression "false" equivalent: listMainStaplesHolding names only staples whose blocks are stored, and a staple and its blocks are written in one persist, so the whole check is never true.
- src/ledger/storage/base.ts:280:8-280:28 ConditionalExpression "false" equivalent: getVoteStaples answers every hash it is asked for, so the staple is never undefined.
- src/ledger/storage/base.ts:280:8-280:47 LogicalOperator "staple === undefined && staple === null" equivalent: the staple holding a stored main block is always stored, so neither half of the check is ever true.
- src/ledger/storage/base.ts:280:32-280:47 ConditionalExpression "false" equivalent: the staple holding a stored main block is never answered as null.
- src/ledger/storage/base.ts:280:49-282:5 BlockStatement "{}" equivalent: the integrity error is unreachable while a staple and its blocks are written in one persist.
- src/ledger/storage/base.ts:281:21-281:122 StringLiteral "``" equivalent: the message of the unreachable integrity error.
- src/ledger/storage/base.ts:316:7-316:27 ConditionalExpression "false" equivalent: preAdjust defers a staple only for a previous it lacks [Keeta TS] index.js:67717-67728, so waitingOn is never empty here.
- src/ledger/storage/base.ts:316:29-318:4 BlockStatement "{}" equivalent: the error for a deferral that waits on nothing is unreachable, as preAdjust defers only for a missing previous.
- src/ledger/storage/base.ts:317:20-317:119 StringLiteral "``" equivalent: the message of the unreachable error for a deferral that waits on nothing.
- src/ledger/storage/base.ts:361:105-363:3 BlockStatement "{}" equivalent: both drivers override runIsolated, so the default body never runs.
- src/ledger/storage/base.ts:684:8-684:26 ConditionalExpression "false" equivalent: the driver's write refuses the same fork with the same code and message (the memory driver's #writeStaple, the Postgres driver's write).
- src/ledger/storage/base.ts:684:28-686:5 BlockStatement "{}" equivalent: the driver's write refuses the same fork with the same code and message (the memory driver's #writeStaple, the Postgres driver's write).
- src/ledger/storage/base.ts:758:3-759:37 ConditionalExpression "default:" equivalent: the default of a switch that has handled both ways a staple is applied is unreachable.
- src/ledger/storage/confirmed.ts:72:6-72:29 ConditionalExpression "true" equivalent: copying an undefined name gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:75:6-75:36 ConditionalExpression "true" equivalent: copying an undefined description gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:78:6-78:33 ConditionalExpression "true" equivalent: copying an undefined metadata gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:81:6-81:42 ConditionalExpression "true" equivalent: copying an undefined default permission gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:84:6-84:39 ConditionalExpression "true" equivalent: copying an undefined quorum gives a field both drivers skip exactly as an absent one.
- src/ledger/storage/confirmed.ts:97:7-97:32 ConditionalExpression "false" equivalent: a certificate principal's effect carries no info, delegation or certificate field [Keeta TS] index.js:68004-68011, so the loop records nothing for it.
- src/ledger/storage/confirmed.ts:97:34-99:4 BlockStatement "{}" equivalent: a certificate principal's effect carries no info, delegation or certificate field [Keeta TS] index.js:68004-68011, so the loop records nothing for it.
- src/ledger/storage/confirmed.ts:130:38-134:3 BlockStatement "{}" harmless: on Postgres an account the staple only touches is left without its account row and first_staple, documented schema (schema/CONTRACT.md, section 6) that no storage member reads.
- src/ledger/storage/confirmed.ts:131:35-133:4 BlockStatement "{}" harmless: on Postgres an account the staple only touches is left without its account row and first_staple, documented schema (schema/CONTRACT.md, section 6) that no storage member reads.
- src/ledger/storage/confirmed.ts:132:4-132:36 CallExpression ";" harmless: on Postgres an account the staple only touches is left without its account row and first_staple, documented schema (schema/CONTRACT.md, section 6) that no storage member reads.
- src/ledger/storage/confirmed.ts:178:26-178:31 BooleanLiteral "true" harmless: final values add only reads and a supply range check [Keeta TS] index.js:67413-67421 that a confirmed staple passed when it was voted on; every delta written is the same.
- src/ledger/storage/confirmed.ts:212:7-212:27 ConditionalExpression "false" equivalent: preAdjust answers a height for every block of a staple it does not defer, so no height is missing.
- src/ledger/storage/confirmed.ts:212:29-214:4 BlockStatement "{}" equivalent: the error for a missing height is unreachable, as preAdjust answers a height for every block it does not defer.
- src/ledger/storage/confirmed.ts:213:20-213:64 StringLiteral "``" equivalent: the message of the unreachable error for a missing height.
- src/ledger/storage/memory/driver.ts:115:29-118:5 BlockStatement "{}" equivalent: neither merge can throw (commitOverlay only sets and deletes map entries), so the failure branch never runs.
- src/ledger/storage/memory/driver.ts:116:19-116:60 ObjectLiteral "{}" equivalent: the failed state is recorded only when a merge throws, which neither merge can.
- src/ledger/storage/memory/driver.ts:116:29-116:39 StringLiteral "\"\"" equivalent: the failed state is recorded only when a merge throws, which neither merge can.
- src/ledger/storage/memory/driver.ts:116:50-116:58 StringLiteral "\"\"" equivalent: the failed outcome is recorded only when a merge throws, which neither merge can.
- src/ledger/storage/memory/driver.ts:126:38-128:4 BlockStatement "{}" equivalent: the base runs one unit at a time per transaction, so units always close innermost first.
- src/ledger/storage/memory/driver.ts:127:20-127:106 StringLiteral "``" equivalent: the message of the unreachable error for units closed out of order.
- src/ledger/storage/memory/driver.ts:138:4-139:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled both transaction states is unreachable.
- src/ledger/storage/memory/driver.ts:164:3-165:32 ConditionalExpression "default:" equivalent: the default of a switch that has handled both principal types is unreachable.
- src/ledger/storage/memory/driver.ts:203:6-203:31 ConditionalExpression "true" equivalent: a name is absent only from a multisig's creation, whose row is new, and an undefined name reads as an absent one.
- src/ledger/storage/memory/driver.ts:206:6-206:38 ConditionalExpression "true" equivalent: a description is absent only from a multisig's creation, whose row is new, and an undefined description reads as an absent one.
- src/ledger/storage/memory/driver.ts:209:6-209:35 ConditionalExpression "true" equivalent: metadata is absent only from a multisig's creation, whose row is new, and undefined metadata reads as absent.
- src/ledger/storage/memory/driver.ts:216:6-216:36 ConditionalExpression "false" equivalent: no info effect carries a null quorum; a quorum comes only from a multisig's creation [Keeta TS] index.js:68305-68309.
- src/ledger/storage/memory/driver.ts:216:38-218:3 BlockStatement "{}" equivalent: no info effect carries a null quorum; a quorum comes only from a multisig's creation [Keeta TS] index.js:68305-68309.
- src/ledger/storage/memory/driver.ts:218:13-218:48 ConditionalExpression "true" equivalent: a multisig has no blocks of its own [Keeta TS] index.js:63820, so its one info update is its creation, which carries the quorum.
- src/ledger/storage/memory/driver.ts:237:6-237:24 ConditionalExpression "false" equivalent: an emptied inner map left in place reads, for every ACL and certificate read, as the deleted row.
- src/ledger/storage/memory/driver.ts:237:26-240:3 BlockStatement "{}" equivalent: an emptied inner map left in place reads, for every ACL and certificate read, as the deleted row.
- src/ledger/storage/memory/driver.ts:251:9-251:33 ConditionalExpression "true" harmless: the orphaned-row count is a test hook; taking every index entry as covering stops it seeing a block left with an empty one, which the driver's writes never leave.
- src/ledger/storage/memory/driver.ts:251:9-251:33 EqualityOperator "(members?.size ?? 0) >= 0" harmless: the orphaned-row count is a test hook; taking an empty index entry as covering stops it seeing a block left with one, which the driver's writes never leave.
- src/ledger/storage/memory/driver.ts:251:10-251:23 OptionalChaining "members.size" harmless: the orphaned-row count is a test hook; it throws only for a side block with no index entry at all, which the driver's writes never leave.
- src/ledger/storage/memory/driver.ts:278:3-279:30 ConditionalExpression "default:" equivalent: the default of a switch that has handled every selector is unreachable.
- src/ledger/storage/memory/driver.ts:291:10-291:43 EqualityOperator "candidate.issued >= current.issued" equivalent: the test before it has already returned for equal issue times, so >= and > agree.
- src/ledger/storage/memory/driver.ts:293:9-293:82 EqualityOperator "toBlockHashKey(candidate.block.hash) >= toBlockHashKey(current.block.hash)" equivalent: two different pending successors never share a block hash, so >= and > agree.
- src/ledger/storage/memory/driver.ts:630:7-630:25 ConditionalExpression "true" equivalent: a page takes at least one vote, so its last vote is undefined only when no vote remains and the key is omitted either way.
- src/ledger/storage/memory/driver.ts:647:11-647:41 ConditionalExpression "true" equivalent: BlockHash.compare of undefined is false, so an absent exclusion excludes nothing either way.
- src/ledger/storage/memory/driver.ts:656:66-656:68 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the placeholder names no side block, so the read still finds no holder.
- src/ledger/storage/memory/driver.ts:676:8-676:39 ConditionalExpression "false" equivalent: a certificate principal can hold only default permissions [Keeta TS] index.js:65535-65539, never OWNER, so the OWNER test alone decides.
- src/ledger/storage/memory/driver.ts:787:75-787:77 ArrayDeclaration "[\"Stryker was here\"]" equivalent: the placeholder names no deferred staple, so nothing is found for a block nothing waits on.
- src/ledger/storage/memory/driver.ts:789:9-789:26 ConditionalExpression "true" equivalent: forgetting a deferred staple clears its index entries, so the index names only stored staples.
- src/ledger/storage/memory/driver.ts:845:58-850:4 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once side rows leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:847:8-847:105 ConditionalExpression "false" harmless: the orphaned-row count is a test hook; it differs only once side blocks leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:847:8-847:50 ConditionalExpression "false" harmless: the orphaned-row count is a test hook; it differs only once a side block is also on main, which promotion never leaves.
- src/ledger/storage/memory/driver.ts:847:8-847:105 LogicalOperator "overlay.blocks.get(blockKey) !== undefined && !hasMembers(overlay.sideVotesByBlock.get(blockKey))" harmless: the orphaned-row count is a test hook; it differs only once side blocks leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:847:107-849:5 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once side blocks leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:848:5-848:29 CallExpression ";" harmless: the orphaned-row count is a test hook; it differs only once side blocks leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:852:69-858:4 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:853:38-857:5 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:854:9-854:82 ConditionalExpression "false" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:854:9-854:82 LogicalOperator "uncovered.has(blockKey) && overlay.sideBlocks.get(blockKey) === undefined" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:854:36-854:82 ConditionalExpression "false" harmless: the orphaned-row count is a test hook; it differs only once a claim outlives its side block, which the driver's writes never allow.
- src/ledger/storage/memory/driver.ts:854:84-856:6 BlockStatement "{}" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:855:6-855:16 UpdateOperator "orphaned--" harmless: the orphaned-row count is a test hook; it differs only once idempotent claims leak, which the driver's writes never do.
- src/ledger/storage/memory/driver.ts:898:3-898:38 CallExpression ";" equivalent: a vote's key is its identity, which fixes its blocks, so rewriting it indexes the same blocks again.
- src/ledger/storage/memory/driver.ts:933:7-933:24 ConditionalExpression "false" equivalent: gc collects only keys it has just read from the side votes, so the row is always there.
- src/ledger/storage/memory/driver.ts:933:26-935:4 BlockStatement "{}" equivalent: gc collects only keys it has just read from the side votes, so the early return never runs.
- src/ledger/storage/memory/driver.ts:948:7-948:34 ConditionalExpression "true" equivalent: removing a member under an undefined key reads an absent row and deletes nothing.
- src/ledger/storage/memory/driver.ts:979:8-979:25 ConditionalExpression "false" equivalent: a side vote and its index entries are written and forgotten together, so an indexed vote is always stored.
- src/ledger/storage/memory/driver.ts:979:27-981:5 BlockStatement "{}" equivalent: a side vote and its index entries are written and forgotten together, so the error never fires.
- src/ledger/storage/memory/driver.ts:980:21-980:84 StringLiteral "``" equivalent: the message of the unreachable error for an indexed vote that is not stored.
- src/ledger/storage/memory/driver.ts:1026:7-1026:24 ConditionalExpression "false" equivalent: a successor entry and its block are written in one persist, so the block is always stored.
- src/ledger/storage/memory/driver.ts:1026:26-1028:4 BlockStatement "{}" equivalent: a successor entry and its block are written in one persist, so the error never fires.
- src/ledger/storage/memory/driver.ts:1027:20-1027:95 StringLiteral "``" equivalent: the message of the unreachable error for a successor whose block is not stored.
- src/ledger/storage/memory/driver.ts:1070:4-1071:31 ConditionalExpression "default:" equivalent: the default of a switch that has handled every selector is unreachable.
- src/ledger/storage/memory/driver.ts:1078:7-1078:25 ConditionalExpression "false" equivalent: blocks are written in chain order, so each is above its account's head even when every head is taken to have no height.
- src/ledger/storage/memory/driver.ts:1078:7-1078:25 ConditionalExpression "true" equivalent: blocks are written in chain order, so each is above its account's head even when every account is taken to have none.
- src/ledger/storage/memory/driver.ts:1078:7-1078:25 EqualityOperator "head !== undefined" equivalent: blocks are written in chain order, so each is above its account's head whatever height the head is taken to have.
- src/ledger/storage/memory/driver.ts:1078:27-1080:4 BlockStatement "{}" equivalent: blocks are written in chain order, so each is above its account's head whatever height the head is taken to have.
- src/ledger/storage/memory/driver.ts:1081:10-1081:49 LogicalOperator "overlay.blocks.get(head)?.height && -1n" equivalent: blocks are written in chain order, so a head of height -1 or 0 is below every block written after it.
- src/ledger/storage/memory/driver.ts:1081:10-1081:42 OptionalChaining "overlay.blocks.get(head).height" equivalent: a head entry and its block are written in one persist, so the block is always there.
- src/ledger/storage/memory/driver.ts:1081:46-1081:49 UnaryOperator "+1n" equivalent: the fallback is unreachable, as a head entry's block is always stored.
- src/ledger/storage/memory/driver.ts:1086:7-1086:24 ConditionalExpression "false" equivalent: every block a head or successor names is written in the same persist, so it is always stored.
- src/ledger/storage/memory/driver.ts:1086:26-1088:4 BlockStatement "{}" equivalent: every block a head or successor names is written in the same persist, so the error never fires.
- src/ledger/storage/memory/driver.ts:1087:20-1087:90 StringLiteral "``" equivalent: the message of the unreachable error for a named block that is not stored.
- src/ledger/storage/memory/driver.ts:1094:7-1094:24 ConditionalExpression "false" equivalent: a block's staple and the block are written in one persist, so the staple is always stored.
- src/ledger/storage/memory/driver.ts:1094:26-1096:4 BlockStatement "{}" equivalent: a block's staple and the block are written in one persist, so the error never fires.
- src/ledger/storage/memory/driver.ts:1095:20-1095:90 StringLiteral "``" equivalent: the message of the unreachable error for a named staple that is not stored.
- src/ledger/storage/memory/driver.ts:1135:8-1135:28 ConditionalExpression "false" equivalent: blockHeightsOf has already required a height for every block of the staple.
- src/ledger/storage/memory/driver.ts:1135:30-1137:5 BlockStatement "{}" equivalent: blockHeightsOf has already required a height for every block of the staple, so the error never fires.
- src/ledger/storage/memory/driver.ts:1136:21-1136:70 StringLiteral "``" equivalent: the message of the unreachable error for a block without a height.
- src/ledger/storage/memory/driver.ts:1150:8-1150:51 ConditionalExpression "true" equivalent: blocks are written in chain order, so each block is above its account's head and becomes the head anyway.
- src/ledger/storage/memory/driver.ts:1150:8-1150:51 EqualityOperator "this.#headHeight(overlay, account) <= height" equivalent: blocks are written in chain order, so a block is never at its head's height.
- src/ledger/storage/memory/driver.ts:1167:9-1167:29 ConditionalExpression "false" equivalent: a zero change writes the balance the account already had, and getAllBalances leaves zero balances out.
- src/ledger/storage/memory/driver.ts:1167:31-1169:6 BlockStatement "{}" equivalent: a zero change writes the balance the account already had, and getAllBalances leaves zero balances out.
- src/ledger/storage/memory/driver.ts:1175:8-1175:26 ConditionalExpression "true" equivalent: an overlay entry set to undefined reads through to the underlying row, which is absent too.
- src/ledger/storage/memory/driver.ts:1217:8-1217:52 ConditionalExpression "false" equivalent: computeLedgerEffect resolves every permission update to a SET or a null [Keeta TS] index.js:67467-67486.
- src/ledger/storage/memory/driver.ts:1217:54-1219:5 BlockStatement "{}" equivalent: computeLedgerEffect resolves every permission update to a SET or a null, so the error never fires.
- src/ledger/storage/memory/driver.ts:1218:21-1218:104 StringLiteral "``" equivalent: the message of the unreachable error for an unresolved permission update.
- src/ledger/storage/memory/driver.ts:1242:5-1243:26 ConditionalExpression "default:" equivalent: the default of a switch that has handled both certificate methods is unreachable.
- src/ledger/storage/memory/driver.ts:1243:6-1243:26 CallExpression ";" equivalent: the assertNever of a switch that has handled both certificate methods is unreachable.
- src/ledger/storage/memory/driver.ts:1259:33-1259:83 ArrayDeclaration "[]" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/driver.ts:1259:86-1263:4 BlockStatement "{}" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/driver.ts:1260:8-1260:51 ConditionalExpression "false" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md); never writing one is unseen.
- src/ledger/storage/memory/driver.ts:1260:8-1260:51 ConditionalExpression "true" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md); rewriting one is unseen.
- src/ledger/storage/memory/driver.ts:1260:8-1260:51 EqualityOperator "overlay.accounts.get(account) !== undefined" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/driver.ts:1260:53-1262:5 BlockStatement "{}" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
- src/ledger/storage/memory/driver.ts:1261:35-1261:58 ObjectLiteral "{}" equivalent: account rows are only written, and no storage member reads them (schema/CONTRACT.md).
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
