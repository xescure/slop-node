import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../../ledger/storage/base.js';
import { driversUnderTest } from '../../ledger/storage/suite/drivers.js';
import { blocksHashesOf, orphanedSideRowsOf } from '../../ledger/storage/suite/support.js';
import type { DriverUnderTest } from '../../ledger/storage/suite/types.js';
import { assertNever } from '../../util/assert-never.js';
import { stateDumpViolations } from '../schema.js';
import { STATE_DUMP_FORMAT, firstDifference, renderReplayStateDump } from './dump.js';
import type { StateDumpKind } from './dump.js';
import { EDGE_CASE_OUTCOMES, addEdgeCases, renderEdgeCaseOutcomes } from './edge-cases.js';
import type { EdgeCaseResult } from './edge-cases.js';
import { loadMainnetFixture } from './fixture.js';
import { compareText, replayMainnet } from './replay.js';
import type { ReplayOptions, ReplayResult } from './replay.js';
import { SHADOW_REFUSAL_REASONS, renderShadowVoteExceptions, shadowVoteExceptions, shadowVoter } from './shadow.js';
import type { ShadowVote } from './shadow.js';

const lib = KeetaNet.lib;

/*
 * One replay of the head per driver serves every assertion about it, so the
 * test time does not grow with each property checked: it shadow-votes each
 * staple before adding it, dumps the state it reaches, and then adds the
 * edge-case staples to the same ledger. The committed golden state, exception
 * set and edge-case outcomes must equal what the reference driver's replay
 * produces now; with SLOP_NODE_UPDATE_CONFORMANCE=1 they are written instead.
 */

const UPDATE = process.env['SLOP_NODE_UPDATE_CONFORMANCE'] === '1';

const REFERENCE_DRIVER_NAME = 'memory';

const HEAD_LEDGER_CHECKSUM = 0xc4896d171cb02d3c9cd929de064de0df788d100c20cb8260cc0072017c130a3an;

const GOLDEN_FILE = new URL('../../../conformance/mainnet/head.state.jsonl', import.meta.url);

const EXCEPTIONS_FILE = new URL('../../../conformance/mainnet/shadow-vote-exceptions.json', import.meta.url);

const EDGE_CASE_OUTCOMES_FILE = new URL('../../../conformance/mainnet/edge-cases.outcomes.json', import.meta.url);

const STATE_DUMP_DOCUMENT = new URL('../../../conformance/STATE-DUMP.md', import.meta.url);

const MAINNET_DOCUMENT = new URL('../../../conformance/MAINNET.md', import.meta.url);

/*
 * One replay of the head with its shadow votes and its dump took 16 s on the
 * memory driver, parsing the head included, and 38 s on Postgres on an idle
 * machine; while make -j8 ran the other tests and the linters beside it,
 * 23-29 s and 40-49 s. Without the votes the memory replay took 8-10 s. The
 * limit is about five times the slowest, so it leaves room for a machine
 * several times slower.
 */
const REPLAY_TIMEOUT_MILLISECONDS = 240_000;

/** The fields that identify a record of each kind, in the order they sort by. */
const RECORD_KEYS = {
	account: ['account'],
	acl: ['principalType', 'principal', 'certificate', 'entity', 'target'],
	balance: ['account', 'token'],
	certificate: ['account', 'hash'],
	checksum: [],
	head: ['account'],
	idempotent: ['account', 'key'],
	supply: ['token'],
	weight: ['representative']
} as const satisfies Record<StateDumpKind, readonly string[]>;

type PlainReplay = {
	readonly result: ReplayResult;
	readonly dump: string;
};

type EmptiedBalance = { readonly account: string; readonly token: string; readonly listed: boolean };

type HeadReplay = PlainReplay & {
	readonly shadowVotes: readonly ShadowVote[];
	readonly orphanedSideRows: number;
	/** Each balance that some applied SEND moved and that the head leaves at zero. */
	readonly emptied: readonly EmptiedBalance[];
	readonly edgeCases: readonly EdgeCaseResult[];
};

const opened: { readonly driver: DriverUnderTest; readonly storage: LedgerStorageDriverBase }[] = [];

afterAll(async function() {
	for (const { driver, storage } of opened.splice(0)) {
		await driver.destroy(storage);
	}
});

async function openStorage(driver: DriverUnderTest): Promise<LedgerStorageDriverBase> {
	const storage = await driver.create();
	opened.push({ driver, storage });
	return(storage);
}

async function replayHeadOn(storage: LedgerStorageDriverBase, options: ReplayOptions): Promise<PlainReplay> {
	const result = await replayMainnet(storage, await loadMainnetFixture('head'), options);
	return({ result, dump: await renderReplayStateDump(result) });
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

/*
 * Everything read from the head's state is read before the edge cases are
 * added, since they change the ledger; the shadow votes are classified later
 * but read only the network's settings.
 */
async function replayHead(driver: DriverUnderTest): Promise<HeadReplay> {
	const storage = await openStorage(driver);
	const voter = shadowVoter();
	const replay = await replayHeadOn(storage, { beforeAdd: voter.beforeAdd });
	const orphanedSideRows = await orphanedSideRowsOf(storage);
	const emptied = await emptiedBalances(replay.result);
	const edgeCases = await addEdgeCases(storage, replay.result.ledger, await loadMainnetFixture('edge-cases'));
	return({ ...replay, shadowVotes: voter.votes, orphanedSideRows, emptied, edgeCases });
}

/** Without shadow votes, so that comparing it with a shadow-voting replay shows the votes leave the state as it was. */
async function replayHeadWithoutVoting(driver: DriverUnderTest): Promise<PlainReplay> {
	return(await replayHeadOn(await openStorage(driver), {}));
}

// A replay sets the one fake clock of the worker, so two replays never run at once.
let replayQueue: Promise<unknown> = Promise.resolve();

function queued<Replay>(replayOn: (driver: DriverUnderTest) => Promise<Replay>, driver: DriverUnderTest): Promise<Replay> {
	const replay = replayQueue.then(function() {
		return(replayOn(driver));
	});
	replayQueue = replay.catch(function() {
		return(undefined);
	});
	return(replay);
}

const sharedReplays = new Map<string, Promise<HeadReplay>>();

function sharedReplay(driver: DriverUnderTest): Promise<HeadReplay> {
	const replay = sharedReplays.get(driver.name) ?? queued(replayHead, driver);
	sharedReplays.set(driver.name, replay);
	return(replay);
}

function driverNamed(name: string): DriverUnderTest {
	const driver = driversUnderTest.find(function(candidate): boolean {
		return(candidate.name === name);
	});
	if (driver === undefined) {
		throw(new Error(`the ${name} driver is not under test`));
	}
	return(driver);
}

function exceptionsOf({ result, shadowVotes }: HeadReplay): string {
	return(renderShadowVoteExceptions(shadowVoteExceptions(shadowVotes, result.ledger)));
}

async function readCommitted(file: URL, generate: (replay: HeadReplay) => string): Promise<string> {
	if (UPDATE) {
		await writeFile(file, generate(await sharedReplay(driverNamed(REFERENCE_DRIVER_NAME))));
	}
	try {
		return(await readFile(file, 'utf8'));
	} catch (error: unknown) {
		throw(new Error(`cannot read the committed ${file.pathname}; run make conformance`, { cause: error }));
	}
}

const committedFiles = new Map<string, Promise<string>>();

function committed(file: URL, generate: (replay: HeadReplay) => string): Promise<string> {
	const text = committedFiles.get(file.href) ?? readCommitted(file, generate);
	committedFiles.set(file.href, text);
	return(text);
}

function committedGolden(): Promise<string> {
	return(committed(GOLDEN_FILE, function({ dump }): string {
		return(dump);
	}));
}

function committedExceptions(): Promise<string> {
	return(committed(EXCEPTIONS_FILE, exceptionsOf));
}

function committedEdgeCaseOutcomes(): Promise<string> {
	return(committed(EDGE_CASE_OUTCOMES_FILE, function({ edgeCases }): string {
		return(renderEdgeCaseOutcomes(edgeCases));
	}));
}

type ParsedRecord = { readonly kind: StateDumpKind; readonly line: string; readonly key: readonly string[] };

function isStateDumpKind(kind: unknown): kind is StateDumpKind {
	return(typeof kind === 'string' && Object.hasOwn(RECORD_KEYS, kind));
}

function parseRecord(line: string): ParsedRecord {
	const record: unknown = JSON.parse(line);
	const kind: unknown = Reflect.get(Object(record), 'kind');
	if (!isStateDumpKind(kind)) {
		throw(new Error(`not a record: ${line}`));
	}
	const key = [kind, ...RECORD_KEYS[kind].map(function(field): string {
		return(String(Reflect.get(Object(record), field) ?? ''));
	})];
	return({ kind, line, key });
}

function compareKeys(left: readonly string[], right: readonly string[]): number {
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const order = compareText(left[index] ?? '', right[index] ?? '');
		if (order !== 0) {
			return(order);
		}
	}
	return(left.length - right.length);
}

function recordLinesOf(dump: string): string[] {
	return(dump.split('\n').slice(1, -1));
}

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

function sameHashes(left: readonly BlockHash[], right: readonly BlockHash[]): boolean {
	return(left.length === right.length && left.every(function(hash, index): boolean {
		return(hash.toString() === right[index]?.toString());
	}));
}

describe.each(driversUnderTest)('the mainnet head replayed on the $name driver', function(driver) {
	test('every staple applies and none stays deferred', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { result } = await sharedReplay(driver);

		expect(result.deferred).toEqual([]);
		expect(result.applied).toBe((await loadMainnetFixture('head')).length);
	});

	test('the ledger checksum is the pinned value', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { result } = await sharedReplay(driver);

		expect(result.ledgerChecksum).toBe(HEAD_LEDGER_CHECKSUM);
	});

	test('the state dump equals the committed golden file', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { dump } = await sharedReplay(driver);

		expect(firstDifference(await committedGolden(), dump)).toBeNull();
	});

	test('an account that sent all of a token away has a zero balance of it, and getAllBalances omits it', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { emptied } = await sharedReplay(driver);

		expect(emptied.length).toBeGreaterThan(0);
		expect(emptied.filter(function(entry): boolean {
			return(entry.listed);
		})).toEqual([]);
	});

	test('shadow votes refuse exactly the classified staples', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const replay = await sharedReplay(driver);

		expect(exceptionsOf(replay)).toBe(await committedExceptions());
	});

	test('every staple is shadow-voted, and each vote given is a temporary vote over exactly the staple\'s blocks', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { result, shadowVotes } = await sharedReplay(driver);

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
		const { orphanedSideRows } = await sharedReplay(driver);

		expect(orphanedSideRows).toBe(0);
	});

	test('the edge-case staples, added after the head, end as the committed outcomes', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { edgeCases } = await sharedReplay(driver);

		expect(renderEdgeCaseOutcomes(edgeCases)).toBe(await committedEdgeCaseOutcomes());
		expect(edgeCases).toHaveLength((await loadMainnetFixture('edge-cases')).length);
	});
});

describe('the mainnet head state', function() {
	const reference = driverNamed(REFERENCE_DRIVER_NAME);
	const others = driversUnderTest.filter(function(driver): boolean {
		return(driver !== reference);
	});

	test.each(others)(`the $name dump is byte-identical to the ${REFERENCE_DRIVER_NAME} dump`, { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function(driver) {
		const [expected, actual] = await Promise.all([sharedReplay(reference), sharedReplay(driver)]);

		expect(firstDifference(expected.dump, actual.dump)).toBeNull();
	});

	test(`a second replay on the ${REFERENCE_DRIVER_NAME} driver, without shadow votes, dumps the same state`, { timeout: 2 * REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const first = await sharedReplay(reference);
		const second = await queued(replayHeadWithoutVoting, reference);

		expect(firstDifference(first.dump, second.dump)).toBeNull();
	});

	test('the golden file is valid under the schema, and its records are in key order with unique keys', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const dump = await committedGolden();
		const lines = dump.split('\n');
		const records = recordLinesOf(dump).map(parseRecord);

		expect(lines[0]).toBe(JSON.stringify({ format: STATE_DUMP_FORMAT }));
		expect(lines.at(-1)).toBe('');
		for (const line of lines.slice(0, -1)) {
			expect(stateDumpViolations(JSON.parse(line))).toEqual([]);
		}
		expect(records.map(function(record): string {
			return(record.line);
		})).toEqual([...records].sort(function(left, right): number {
			return(compareKeys(left.key, right.key));
		}).map(function(record): string {
			return(record.line);
		}));
		expect(new Set(records.map(function(record): string {
			return(JSON.stringify(record.key));
		})).size).toBe(records.length);
	});

	test('STATE-DUMP.md states the record count of each kind in the golden file', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const records = recordLinesOf(await committedGolden()).map(parseRecord);
		const document = await readFile(STATE_DUMP_DOCUMENT, 'utf8');

		for (const kind of Object.keys(RECORD_KEYS).filter(isStateDumpKind)) {
			const count = records.filter(function(record): boolean {
				return(record.kind === kind);
			}).length;
			expect(document).toContain(`| \`${kind}\` | ${count.toLocaleString('en-US')} |`);
		}
	});

	test('MAINNET.md states the staple count of each edge-case outcome', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const outcomes = await committedEdgeCaseOutcomes();
		const document = await readFile(MAINNET_DOCUMENT, 'utf8');

		for (const outcome of EDGE_CASE_OUTCOMES) {
			const count = outcomes.split(`"outcome": ${JSON.stringify(outcome)}`).length - 1;
			expect(document).toContain(`| \`${outcome}\` | ${count.toLocaleString('en-US')} |`);
		}
	});

	test('MAINNET.md states how many deferred edge cases wait only on blocks in neither file, and how many only on other edge cases', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const { edgeCases } = await sharedReplay(reference);
		const edgeCaseBlocks = new Set((await loadMainnetFixture('edge-cases')).flatMap(function(staple): string[] {
			return(staple.blocks.map(function(block): string {
				return(block.hash.toString());
			}));
		}));
		const waits = edgeCases.flatMap(function(result): (readonly string[])[] {
			switch (result.outcome) {
				case 'deferred':
					return([result.waitingOn]);
				case 'applied':
				case 'refused':
					return([]);
				default:
					return(assertNever(result));
			}
		});
		const onEdgeCasesOnly = waits.filter(function(waitingOn): boolean {
			return(waitingOn.every(function(hash): boolean {
				return(edgeCaseBlocks.has(hash));
			}));
		}).length;
		const outsideOnly = waits.filter(function(waitingOn): boolean {
			return(!waitingOn.some(function(hash): boolean {
				return(edgeCaseBlocks.has(hash));
			}));
		}).length;
		const document = await readFile(MAINNET_DOCUMENT, 'utf8');

		expect(onEdgeCasesOnly + outsideOnly).toBe(waits.length);
		expect(document).toContain(`Of the deferred staples, ${String(outsideOnly)} wait only on blocks that are in neither file`);
		expect(document).toContain(`The other ${String(onEdgeCasesOnly)} wait only on blocks of other edge-case staples`);
	});

	test('MAINNET.md states the staple count of each reason in the shadow-vote exceptions', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const exceptions = await committedExceptions();
		const document = await readFile(MAINNET_DOCUMENT, 'utf8');

		for (const reason of SHADOW_REFUSAL_REASONS) {
			const count = exceptions.split(`"reason": ${JSON.stringify(reason)}`).length - 1;
			expect(document).toContain(`| \`${reason}\` | ${count.toLocaleString('en-US')} |`);
		}
	});
});
