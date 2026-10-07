import { readFile, rename, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../../ledger/storage/base.js';
import { driverUnderTestNamed } from '../../ledger/storage/suite/drivers.js';
import { blocksHashesOf, orphanedSideRowsOf } from '../../ledger/storage/suite/support.js';
import type { DriverUnderTest } from '../../ledger/storage/suite/types.js';
import { assertNever } from '../../util/assert-never.js';
import { firstDifference, renderReplayStateDump } from './dump.js';
import { addEdgeCases, renderEdgeCaseOutcomes } from './edge-cases.js';
import type { EdgeCaseResult } from './edge-cases.js';
import { loadMainnetFixture } from './fixture.js';
import { replayMainnet } from './replay.js';
import type { ReplayOptions, ReplayResult } from './replay.js';
import { renderShadowVoteExceptions, shadowVoteExceptions, shadowVoter } from './shadow.js';
import type { ShadowVote } from './shadow.js';

const lib = KeetaNet.lib;

/*
 * One replay of the head per driver serves every assertion about it, so the
 * test time does not grow with each property checked: it shadow-votes each
 * staple before adding it, dumps the state it reaches, and then adds the
 * edge-case staples to the same ledger. Each driver's replay runs in a test
 * file of its own, so the drivers replay in parallel. The committed golden
 * state, exception set and edge-case outcomes must equal what every driver's
 * replay produces now; with SLOP_NODE_UPDATE_CONFORMANCE=1 the reference
 * driver's replay writes them instead.
 */

const UPDATE = process.env['SLOP_NODE_UPDATE_CONFORMANCE'] === '1';

export const REFERENCE_DRIVER_NAME = 'memory';

const HEAD_LEDGER_CHECKSUM = 0xc4896d171cb02d3c9cd929de064de0df788d100c20cb8260cc0072017c130a3an;

const GOLDEN_FILE = new URL('../../../conformance/mainnet/head.state.jsonl', import.meta.url);

const EXCEPTIONS_FILE = new URL('../../../conformance/mainnet/shadow-vote-exceptions.json', import.meta.url);

const EDGE_CASE_OUTCOMES_FILE = new URL('../../../conformance/mainnet/edge-cases.outcomes.json', import.meta.url);

/*
 * One replay of the head with its shadow votes and its dump took 16 s on the
 * memory driver, parsing the head included, and 38 s on Postgres on an idle
 * machine; while make -j8 ran the other tests and the linters beside it,
 * 23-29 s and 40-49 s. Without the votes the memory replay took 8-10 s. The
 * limit is about five times the slowest, so it leaves room for a machine
 * several times slower.
 */
export const REPLAY_TIMEOUT_MILLISECONDS = 240_000;

export type PlainReplay = {
	readonly result: ReplayResult;
	readonly dump: string;
};

type EmptiedBalance = { readonly account: string; readonly token: string; readonly listed: boolean };

export type HeadReplay = PlainReplay & {
	readonly shadowVotes: readonly ShadowVote[];
	readonly orphanedSideRows: number;
	/** Each balance that some applied SEND moved and that the head leaves at zero. */
	readonly emptied: readonly EmptiedBalance[];
	readonly edgeCases: readonly EdgeCaseResult[];
};

/** One driver's replays of the head and the committed files they are checked against. */
export type HeadReplays = {
	/** The shadow-voting replay that every test of the driver reads. */
	shared(): Promise<HeadReplay>;
	/** A further replay, without shadow votes. */
	withoutVoting(): Promise<PlainReplay>;
	committedGolden(): Promise<string>;
	committedExceptions(): Promise<string>;
	committedEdgeCaseOutcomes(): Promise<string>;
};

type SentToken = { readonly account: GenericAccount; readonly token: TokenAddress };

/** Each account and token that some applied SEND moved, once. */
function sentTokens(staples: readonly VoteStaple[]): SentToken[] {
	const sent = new Map<string, SentToken>();
	for (const block of staples.flatMap(function(staple) {
		return(staple.blocks);
	})) {
		for (const operation of block.operations) {
			if (operation.type === lib.Block.OperationType.SEND) {
				sent.set(`${block.account.publicKeyString.get()}/${operation.token.publicKeyString.get()}`, { account: block.account, token: operation.token });
			}
		}
	}
	return([...sent.values()]);
}

async function emptiedBalances(result: ReplayResult): Promise<EmptiedBalance[]> {
	return(await result.ledger.runReadOnly('emptied-balances', async function(reader) {
		const found: EmptiedBalance[] = [];
		for (const { account, token } of sentTokens(result.appliedStaples)) {
			if (await reader.getBalance(account, token) !== 0n) {
				continue;
			}
			const listed = (await reader.getAllBalances(account)).some(function(entry): boolean {
				return(entry.token.comparePublicKey(token));
			});
			found.push({ account: account.publicKeyString.get(), token: token.publicKeyString.get(), listed });
		}
		return(found);
	}));
}

function exceptionsOf({ result, shadowVotes }: HeadReplay): string {
	return(renderShadowVoteExceptions(shadowVoteExceptions(shadowVotes, result.ledger)));
}

function sameHashes(left: readonly BlockHash[], right: readonly BlockHash[]): boolean {
	return(left.length === right.length && left.every(function(hash, index): boolean {
		return(hash.toString() === right[index]?.toString());
	}));
}

async function readCommitted(file: URL): Promise<string> {
	try {
		return(await readFile(file, 'utf8'));
	} catch (error: unknown) {
		throw(new Error(`cannot read the committed ${file.pathname}; run make conformance`, { cause: error }));
	}
}

function headReplaysOn(driver: DriverUnderTest): HeadReplays {
	const opened: LedgerStorageDriverBase[] = [];

	afterAll(async function() {
		for (const storage of opened.splice(0)) {
			await driver.destroy(storage);
		}
	});

	async function openStorage(): Promise<LedgerStorageDriverBase> {
		const storage = await driver.create();
		opened.push(storage);
		return(storage);
	}

	async function replayHeadOn(storage: LedgerStorageDriverBase, options: ReplayOptions): Promise<PlainReplay> {
		const result = await replayMainnet(storage, await loadMainnetFixture('head'), options);
		return({ result, dump: await renderReplayStateDump(result) });
	}

	/*
	 * Everything read from the head's state is read before the edge cases are
	 * added, since they change the ledger; the shadow votes are classified
	 * later but read only the network's settings.
	 */
	async function replayHead(): Promise<HeadReplay> {
		const storage = await openStorage();
		const voter = shadowVoter();
		const replay = await replayHeadOn(storage, { beforeAdd: voter.beforeAdd });
		const orphanedSideRows = await orphanedSideRowsOf(storage);
		const emptied = await emptiedBalances(replay.result);
		const edgeCases = await addEdgeCases(storage, replay.result.ledger, await loadMainnetFixture('edge-cases'));
		return({ ...replay, shadowVotes: voter.votes, orphanedSideRows, emptied, edgeCases });
	}

	async function replayHeadWithoutVoting(): Promise<PlainReplay> {
		return(await replayHeadOn(await openStorage(), {}));
	}

	// A replay sets the one fake clock of the worker, so two replays never run at once.
	let replayQueue: Promise<unknown> = Promise.resolve();

	function queued<Replay>(replay: () => Promise<Replay>): Promise<Replay> {
		const next = replayQueue.then(replay);
		replayQueue = next.catch(function() {
			return(undefined);
		});
		return(next);
	}

	let sharedReplay: Promise<HeadReplay> | undefined;

	function shared(): Promise<HeadReplay> {
		sharedReplay ??= queued(replayHead);
		return(sharedReplay);
	}

	const committedFiles = new Map<string, Promise<string>>();

	/** Only the reference driver writes the files, so a replay on another driver is always checked against them. */
	async function updatedThenRead(file: URL, generate: (replay: HeadReplay) => string): Promise<string> {
		if (UPDATE && driver.name === REFERENCE_DRIVER_NAME) {
			// A file of another driver's run may be reading the file meanwhile, so it only ever sees a whole file.
			const partial = new URL(`${file.href}.partial`);
			await writeFile(partial, generate(await shared()));
			await rename(partial, file);
		}
		return(await readCommitted(file));
	}

	function committed(file: URL, generate: (replay: HeadReplay) => string): Promise<string> {
		const text = committedFiles.get(file.href) ?? updatedThenRead(file, generate);
		committedFiles.set(file.href, text);
		return(text);
	}

	return({
		shared,
		withoutVoting: function() {
			return(queued(replayHeadWithoutVoting));
		},
		committedGolden: function() {
			return(committed(GOLDEN_FILE, function({ dump }): string {
				return(dump);
			}));
		},
		committedExceptions: function() {
			return(committed(EXCEPTIONS_FILE, exceptionsOf));
		},
		committedEdgeCaseOutcomes: function() {
			return(committed(EDGE_CASE_OUTCOMES_FILE, function({ edgeCases }): string {
				return(renderEdgeCaseOutcomes(edgeCases));
			}));
		}
	});
}

/** Registers the tests that every driver's replay of the head must pass, and returns its replays for any further tests. */
export function describeHeadReplay(driverName: string): HeadReplays {
	const driver = driverUnderTestNamed(driverName);
	const replays = headReplaysOn(driver);

	describe(`the mainnet head replayed on the ${driver.name} driver`, function() {
		test('every staple applies and none stays deferred', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
			const { result } = await replays.shared();

			expect(result.deferred).toEqual([]);
			expect(result.applied).toBe((await loadMainnetFixture('head')).length);
		});

		test('the ledger checksum is the pinned value', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
			const { result } = await replays.shared();

			expect(result.ledgerChecksum).toBe(HEAD_LEDGER_CHECKSUM);
		});

		test('the state dump equals the committed golden file', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
			const { dump } = await replays.shared();

			expect(firstDifference(await replays.committedGolden(), dump)).toBeNull();
		});

		test('an account that sent all of a token away has a zero balance of it, and getAllBalances omits it', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
			const { emptied } = await replays.shared();

			expect(emptied.length).toBeGreaterThan(0);
			expect(emptied.filter(function(entry): boolean {
				return(entry.listed);
			})).toEqual([]);
		});

		test('shadow votes refuse exactly the classified staples', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
			const replay = await replays.shared();

			expect(exceptionsOf(replay)).toBe(await replays.committedExceptions());
		});

		test('every staple is shadow-voted, and each vote given is a temporary vote over exactly the staple\'s blocks', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
			const { result, shadowVotes } = await replays.shared();

			expect(blocksHashesOf(shadowVotes.map(function(shadow) {
				return(shadow.staple);
			}))).toEqual(blocksHashesOf(result.appliedStaples));
			const unlike = shadowVotes.filter(function(shadow): boolean {
				switch (shadow.outcome) {
					case 'voted':
						return(shadow.vote.$permanent || !sameHashes(shadow.vote.blocks, shadow.staple.blocks.map(function(block): BlockHash {
							return(block.hash);
						})));
					case 'refused':
						return(false);
					default:
						return(assertNever(shadow));
				}
			});
			expect(blocksHashesOf(unlike.map(function(shadow) {
				return(shadow.staple);
			}))).toEqual([]);
		});

		test('the shadow votes leave no side rows behind', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
			const { orphanedSideRows } = await replays.shared();

			expect(orphanedSideRows).toBe(0);
		});

		test('the edge-case staples, added after the head, end as the committed outcomes', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
			const { edgeCases } = await replays.shared();

			expect(renderEdgeCaseOutcomes(edgeCases)).toBe(await replays.committedEdgeCaseOutcomes());
			expect(edgeCases).toHaveLength((await loadMainnetFixture('edge-cases')).length);
		});
	});

	return(replays);
}
