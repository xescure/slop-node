import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertNever } from '../util/assert-never.js';
import { getOK } from './api-source.js';
import type { APIAnswer, APISource } from './api-source.js';
import type { FollowerStore, KnownAccount } from './follower-store.js';
import { sweepCursorOf } from './log.js';
import { selfCheckOf } from './self-check.js';
import type { Disputed, DisputedKind, ParityLog, RecordedWalk, RepresentativeReading, SelfCheck, SweepBatchRecord, SweepCursor, SweepOutcome, SweepRecord, SweepWalk } from './log.js';

/** Where each walk of the sweep resumes, in the follower's directory. */
export const SWEEP_CURSOR_FILES: Readonly<Record<SweepWalk, string>> = { chain: 'parity-sweep-chain.json', passive: 'parity-sweep-passive.json' };

export type SweepCursorPaths = Readonly<Record<SweepWalk, string>>;

export function sweepCursorPaths(directory: string): SweepCursorPaths {
	return({ chain: join(directory, SWEEP_CURSOR_FILES.chain), passive: join(directory, SWEEP_CURSOR_FILES.passive) });
}

/**
 * How long before where the follower holds every staple an account's
 * newest staple must have been voted on for the account to be compared.
 * Only the newest staple is read, and a representative orders an account's
 * history by its own vote in each staple (conformance/API.md, Differences),
 * so an older staple may carry a vote later than the newest's by the spread
 * of one staple's votes, seconds on the main network; the follower's reach
 * is itself a vote key, which a representative may set a second off. An
 * hour covers both many times over.
 */
export const QUIET_MARGIN_MILLISECONDS: number = 60 * 60_000;

/** Chain accounts compared before the cursor moves: a few for each representative, which a crash compares again. */
const CHAIN_ACCOUNTS_PER_REPRESENTATIVE_IN_A_BATCH = 8;

/**
 * Passive accounts whose states one request asks for. The client joins
 * every account it is given into one path, without a bound
 * [Keeta TS] index.js:58565-58577, 59958-59960; the bound observed is the
 * servers': the representatives and the follower answer 431 to a request
 * line beyond about 16 KiB, some 225 accounts. A hundred stays well inside
 * that, and a representative answers it in about a second.
 */
export const ACCOUNTS_PER_STATES_REQUEST = 100;

const START: SweepCursor = { lap: 0, afterRowID: '0' };

/** How many more times a chain account found moving is compared at once, before its chain is compared instead. */
const MOVING_RETRIES = 2;

/** Blocks of a chain one request asks for: as many as the client asks for [Keeta TS] index.js:58873. */
const CHAIN_PAGE_BLOCKS = 200;

/** Pages of a representative's chain read past the follower's head before the account is left unanswered. */
const CHAIN_PAGES = 10;

/**
 * A representative votes on a block only within five minutes of its date
 * [Keeta TS] index.js:70185-70196, so a block dated that long before the
 * follower's reach less the margin was voted on before the reach.
 */
const BLOCK_DATE_VOTE_SPREAD_MILLISECONDS = 5 * 60_000;

/** The cursor stored, or the start of the first lap when none is. */
export async function readSweepCursor(path: string): Promise<SweepCursor> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return(START);
		}
		throw(error);
	}
	const cursor = sweepCursorOf(JSON.parse(text));
	if (cursor === undefined) {
		throw(new Error(`${path} holds no sweep cursor`));
	}
	return(cursor);
}

/** Written beside its place and renamed into it, so that a crash leaves the old cursor or the new one. */
async function writeSweepCursor(path: string, cursor: SweepCursor): Promise<void> {
	await writeFile(`${path}.new`, `${JSON.stringify(cursor)}\n`);
	await rename(`${path}.new`, path);
}

function isFields(value: unknown): value is Readonly<Record<string, unknown>> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** The path of the first field at which the two bodies differ, or nothing when they are equal. */
export function firstDifference(follower: unknown, representative: unknown, path = ''): string | undefined {
	const here = path || '(body)';
	if (Array.isArray(follower) && Array.isArray(representative)) {
		for (let index = 0; index < Math.max(follower.length, representative.length); index++) {
			if (index >= follower.length || index >= representative.length) {
				return(`${path}[${String(index)}]`);
			}
			const found = firstDifference(follower[index], representative[index], `${path}[${String(index)}]`);
			if (found !== undefined) {
				return(found);
			}
		}
		return(undefined);
	}
	if (isFields(follower) && isFields(representative)) {
		const names = [...new Set([...Object.keys(follower), ...Object.keys(representative)])].sort();
		for (const name of names) {
			let named = name;
			if (path !== '') {
				named = `${path}.${name}`;
			}
			if (!(name in follower) || !(name in representative)) {
				return(named);
			}
			const found = firstDifference(follower[name], representative[name], named);
			if (found !== undefined) {
				return(found);
			}
		}
		return(undefined);
	}
	if (isDeepStrictEqual(follower, representative)) {
		return(undefined);
	}
	return(here);
}

/** An account's newest staple on a representative: the hash of its blocks, and the latest moment one of its votes was valid from. */
export type NewestStaple = { readonly staple: string; readonly latestVote: Date };

/** The newest staple of a page of history, nothing for an empty page, or an error for a page that is not one. */
export function newestStapleOf(page: unknown): NewestStaple | undefined {
	if (!isFields(page) || !Array.isArray(page['history'])) {
		throw(new Error(`not a page of history: ${JSON.stringify(page).slice(0, 200)}`));
	}
	const entry: unknown = page['history'][0];
	if (entry === undefined) {
		return(undefined);
	}
	if (!isFields(entry) || typeof entry['$id'] !== 'string' || !isFields(entry['voteStaple']) || !Array.isArray(entry['voteStaple']['votes'])) {
		throw(new Error(`not an entry of history: ${JSON.stringify(entry).slice(0, 200)}`));
	}
	const moments = entry['voteStaple']['votes'].map(function(vote: unknown): number {
		if (!isFields(vote) || typeof vote['validityFrom'] !== 'string') {
			return(Number.NaN);
		}
		return(Date.parse(vote['validityFrom']));
	});
	const latest = Math.max(...moments);
	if (!Number.isFinite(latest)) {
		throw(new Error(`a vote of the staple ${entry['$id']} has no moment it is valid from`));
	}
	return({ staple: entry['$id'], latestVote: new Date(latest) });
}

function headOf(state: unknown): string | null {
	if (isFields(state) && typeof state['currentHeadBlock'] === 'string') {
		return(state['currentHeadBlock']);
	}
	return(null);
}

/** The head a reading of a chain names, or null. */
function chainHeadOf(reading: unknown): string | null {
	if (isFields(reading) && typeof reading['head'] === 'string') {
		return(reading['head']);
	}
	return(null);
}

/** The hash of the head block an account's head answers with, the block whole (api/node.d.ts, getAccountsHead), or null for an account without one. */
function headBlockOf(answer: unknown): string | null {
	if (!isFields(answer) || answer['block'] === null) {
		return(null);
	}
	const block = answer['block'];
	if (!isFields(block) || typeof block['$hash'] !== 'string') {
		throw(new Error(`not the head of an account: ${JSON.stringify(answer).slice(0, 200)}`));
	}
	return(block['$hash']);
}

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

type AccountComparison = {
	readonly follower: APISource;
	readonly representative: APISource;
	readonly store: Pick<FollowerStore, 'historyHolds'>;
	/** The follower's reach less the margin: an account whose newest staple has a vote from then on may be moving. */
	readonly quietBefore: Date;
	readonly account: string;
};

/**
 * Compares what the follower and the representative hold of the account,
 * when both hold it at the same point. The representative's state is read
 * before its newest staple, so a staple it adds in between shows as newest;
 * the follower is read on both sides of the two, so a staple it applies in
 * between shows as a change. The account counts only when its newest staple
 * was voted on before where the follower holds every staple, by the margin:
 * then the follower holds every staple of the account the representative
 * does, and the two must agree on all of it, its head included, and the
 * follower must answer for it at all.
 */
export async function compareAccount(comparison: AccountComparison): Promise<SweepOutcome> {
	const { follower, representative, store, quietBefore, account } = comparison;
	const path = `/node/ledger/account/${account}`;
	let followerBefore: APIAnswer;
	let representativeState: unknown;
	let newest: NewestStaple | undefined;
	let followerAfter: APIAnswer;
	try {
		followerBefore = await follower.get(path);
		representativeState = await getOK(representative, path);
		newest = newestStapleOf(await getOK(representative, `${path}/history?limit=1`));
		followerAfter = await follower.get(path);
	} catch (error: unknown) {
		return({ kind: 'skipped', reason: 'unanswered', detail: messageOf(error) });
	}
	if (newest !== undefined && newest.latestVote.getTime() >= quietBefore.getTime()) {
		return({
			kind: 'skipped',
			reason: 'moving',
			side: 'representative',
			detail: `its newest staple ${newest.staple} has a vote from ${newest.latestVote.toISOString()}, not before ${quietBefore.toISOString()}, the follower's reach less the margin`
		});
	}
	if (!isDeepStrictEqual(followerBefore, followerAfter)) {
		return({ kind: 'skipped', reason: 'moving', side: 'follower', detail: 'the follower changed the account while it was compared' });
	}
	const staple = newest?.staple ?? null;
	if (followerAfter.status !== 200) {
		return({ kind: 'diverged', divergence: { account, field: 'status', staple }, follower: followerAfter, representative: representativeState, readings: [], selfCheck: null });
	}
	if (newest !== undefined && !await store.historyHolds(account, newest.staple)) {
		return({ kind: 'diverged', divergence: { account, field: 'history', staple }, follower: followerAfter.body, representative: representativeState, readings: [], selfCheck: null });
	}
	/*
	 * The account's state has no node-local field: a node holding the same
	 * ledger answers it exactly as a representative does, which the replay
	 * of its captures checks unnormalized (src/api/captures.test.ts), so the
	 * bodies are compared whole.
	 */
	const field = firstDifference(followerAfter.body, representativeState);
	const error = stateErrorOf(representativeState);
	if (field === undefined && error !== undefined) {
		return({ kind: 'error-both', error });
	}
	if (field !== undefined) {
		return({ kind: 'diverged', divergence: { account, field, staple }, follower: followerAfter.body, representative: representativeState, readings: [], selfCheck: null });
	}
	return({ kind: 'match', head: headOf(representativeState), staple });
}

/** What the sweep reads of the follower's storage. */
export type SweepStore = Pick<FollowerStore, 'progress' | 'chainAccountsAfter' | 'passiveAccountsAfter' | 'chainAccounts' | 'historyHolds' | 'holdsBlock' | 'balancesFromHistory'>;

export type SweepSetup = {
	readonly follower: APISource;
	/** Each batch is compared with one of them, in turn; their requests are paced by the caller. */
	readonly representatives: readonly APISource[];
	readonly store: SweepStore;
	readonly log: ParityLog;
	readonly cursorPaths: SweepCursorPaths;
	/** How many accounts each walk goes past before stopping. */
	readonly accounts: Readonly<Record<SweepWalk, number>>;
	/** Stops each walk at the end of the lap it is on. */
	readonly toLapEnd: boolean;
	/** Requests of the passive walk in flight to each representative at once, each for a hundred accounts of the batch. */
	readonly passiveRequestsInFlight: number;
	/** Stops the sweep after the batch under way; what that batch compared is not recorded. */
	readonly stopped: AbortSignal;
};

export type WalkSummary = {
	/** Accounts walked past, compared or not. */
	readonly walked: number;
	readonly compared: number;
	readonly matched: number;
	/** Accounts the follower disagrees with most representatives about, or that they split on. */
	readonly diverged: number;
	/** Accounts one representative alone disagreed about, the follower agreeing with most of the others. */
	readonly representativeLocal: number;
	/** Chain accounts moving on every attempt, compared by their chains, among those compared and apart from those matched. */
	readonly comparedByChain: number;
	/** Accounts not compared: found moving, unanswered, or answered with the same error by both; each is compared again on the next lap. */
	readonly skipped: number;
	readonly cursor: SweepCursor;
};

export type SweepSummary = Readonly<Record<SweepWalk, WalkSummary>>;

type Tally = { walked: number; compared: number; matched: number; diverged: number; representativeLocal: number; comparedByChain: number; skipped: number };

function emptyTally(): Tally {
	return({ walked: 0, compared: 0, matched: 0, diverged: 0, representativeLocal: 0, comparedByChain: 0, skipped: 0 });
}

function addTally(tally: Tally, more: Tally): void {
	tally.walked += more.walked;
	tally.compared += more.compared;
	tally.matched += more.matched;
	tally.diverged += more.diverged;
	tally.representativeLocal += more.representativeLocal;
	tally.comparedByChain += more.comparedByChain;
	tally.skipped += more.skipped;
}

function count(tally: Tally, outcome: SweepOutcome): void {
	switch (outcome.kind) {
		case 'match':
			tally.compared++;
			tally.matched++;
			break;
		case 'diverged':
		case 'unresolved':
			tally.compared++;
			tally.diverged++;
			break;
		case 'representative-local':
			tally.compared++;
			tally.representativeLocal++;
			break;
		case 'compared-chain':
			tally.compared++;
			tally.comparedByChain++;
			break;
		case 'skipped':
		case 'error-both':
			tally.skipped++;
			break;
		default:
			assertNever(outcome);
	}
}

/** Read through a call, as a signal is aborted while the sweep awaits. */
function isStopped(signal: AbortSignal): boolean {
	return(signal.aborted);
}

const FOLLOWER_HOLDS_RECENT = 'the follower holds a staple of it from within the margin of its reach';

/**
 * What another representative holds of the account, read as the one
 * compared with was: its state, then its newest staple, which must be
 * before the margin and held by the follower for the state to agree.
 */
async function readingOf(store: Pick<SweepStore, 'historyHolds'>, representative: APISource, account: string, follower: Disputed, quietBefore: Date): Promise<RepresentativeReading> {
	const path = `/node/ledger/account/${account}`;
	let state: unknown;
	let newest: NewestStaple | undefined;
	try {
		state = await getOK(representative, path);
		newest = newestStapleOf(await getOK(representative, `${path}/history?limit=1`));
	} catch (error: unknown) {
		return({ representative: representative.endpoint, kind: 'unanswered', detail: messageOf(error) });
	}
	if (newest !== undefined && newest.latestVote.getTime() >= quietBefore.getTime()) {
		return({ representative: representative.endpoint, kind: 'moving', detail: `its newest staple ${newest.staple} has a vote from ${newest.latestVote.toISOString()}` });
	}
	const staple = newest?.staple ?? null;
	const agrees = follower.divergence.field !== 'status' && isDeepStrictEqual(follower.follower, state) && (newest === undefined || await store.historyHolds(account, newest.staple));
	if (agrees) {
		return({ representative: representative.endpoint, kind: 'agrees', state, staple });
	}
	return({ representative: representative.endpoint, kind: 'disagrees', state, staple });
}

/** How many of the values are each distinct value, by deep equality. */
function tallies(values: readonly unknown[]): readonly number[] {
	const distinct: { readonly value: unknown; count: number }[] = [];
	for (const value of values) {
		const known = distinct.find(function(entry): boolean {
			return(isDeepStrictEqual(entry.value, value));
		});
		if (known === undefined) {
			distinct.push({ value, count: 1 });
		} else {
			known.count++;
		}
	}
	return(distinct.map(function(entry): number {
		return(entry.count);
	}));
}

/** What the representatives that answered apart answered, as their difference is judged. */
export type Dissent = {
	/** The value the representative compared with answered. */
	readonly compared: unknown;
	/**
	 * Whether the follower holds what each representative apart holds newest
	 * of the account, the one compared with included: the staple of its
	 * newest history entry, or the block at the head of its chain.
	 */
	readonly followerHoldsDissent: boolean;
};

/**
 * Whose a divergence is, by the representatives that gave a reading, the one
 * compared with among them: the representatives' own that answer apart when
 * at least two answer as the follower, every other value is answered by
 * fewer, so that one other representative alone never outweighs the one
 * compared with, nor do as many answering one value, and the follower holds
 * what each of them holds newest; the follower's when most disagree with
 * it. A staple the follower lacks is never one representative's own:
 * another representative may list a different staple first, ordering its
 * history by its own votes, and agree on a state the lacked staple left
 * unchanged.
 */
export function disputedKindOf(readings: readonly RepresentativeReading[], field: string, dissent: Dissent): DisputedKind {
	const { compared, followerHoldsDissent } = dissent;
	const agreeing = readings.filter(function(reading): boolean {
		return(reading.kind === 'agrees');
	}).length;
	const dissenting = [compared, ...readings.flatMap(function(reading): unknown[] {
		if (reading.kind !== 'disagrees') {
			return([]);
		}
		return([reading.state]);
	})];
	const disagreeing = dissenting.length;
	const read = agreeing + disagreeing;
	if (agreeing >= 2 && Math.max(...tallies(dissenting)) < agreeing && followerHoldsDissent && field !== 'history') {
		return('representative-local');
	}
	if (disagreeing * 2 > read) {
		return('diverged');
	}
	return('unresolved');
}

type Comparing = Pick<SweepSetup, 'follower' | 'representatives' | 'store'>;

/**
 * Compares an account by itself, and reads one that diverges again from
 * every other representative, to tell the follower's divergence from one
 * representative's own.
 */
async function compareAdjudicated(setup: Comparing, representative: APISource, account: string, quietBefore: Date): Promise<SweepOutcome> {
	const outcome = await compareAccount({ follower: setup.follower, representative, store: setup.store, quietBefore, account });
	if (outcome.kind !== 'diverged') {
		return(outcome);
	}
	const others = setup.representatives.filter(function(other): boolean {
		return(other.endpoint !== representative.endpoint);
	});
	const readings = await Promise.all(others.map(function(other) {
		return(readingOf(setup.store, other, account, outcome, quietBefore));
	}));
	const dissentingStaples = [outcome.divergence.staple, ...readings.map(function(reading): string | null {
		if (reading.kind !== 'disagrees') {
			return(null);
		}
		return(reading.staple);
	})];
	const followerHoldsDissent = (await Promise.all(dissentingStaples.map(function(staple): Promise<boolean> {
		if (staple === null) {
			return(Promise.resolve(true));
		}
		return(setup.store.historyHolds(account, staple));
	}))).every(function(held): boolean {
		return(held);
	});
	return(await withSelfCheck(setup, { ...outcome, kind: disputedKindOf(readings, outcome.divergence.field, { compared: outcome.representative, followerHoldsDissent }), readings }));
}

/**
 * Whether the follower's balances of the account are those its own history
 * leaves it with: the state is read before and after the history, and the
 * two must be one, so that a staple the follower adds in between is not
 * taken for a difference.
 */
async function selfCheckOfAccount(setup: Comparing, account: string): Promise<SelfCheck> {
	const path = `/node/ledger/account/${account}`;
	try {
		const before = await getOK(setup.follower, path);
		const fromHistory = await setup.store.balancesFromHistory(account);
		const after = await getOK(setup.follower, path);
		if (!isDeepStrictEqual(before, after)) {
			return({ kind: 'unchecked', why: 'the follower changed the account while its history was read' });
		}
		return(selfCheckOf(after, fromHistory));
	} catch (error: unknown) {
		return({ kind: 'unchecked', why: messageOf(error) });
	}
}

/**
 * A divergence the representatives leave to one of them, or split on, rests
 * on more than their votes: the follower's balances of the account must be
 * those its own history leaves it with, or the divergence is the
 * follower's whatever they answer.
 */
async function withSelfCheck(setup: Comparing, outcome: { readonly kind: DisputedKind } & Disputed): Promise<SweepOutcome> {
	if (outcome.kind === 'diverged') {
		return(outcome);
	}
	const selfCheck = await selfCheckOfAccount(setup, outcome.divergence.account);
	if (selfCheck.kind === 'inconsistent') {
		return({ ...outcome, kind: 'diverged', selfCheck });
	}
	return({ ...outcome, selfCheck });
}

/** A block of a page of a chain, as far as the comparison of chains reads it. */
type ChainBlock = { readonly hash: string; readonly previous: string; readonly date: Date };

function chainPageOf(body: unknown): { readonly blocks: readonly ChainBlock[]; readonly nextKey: string | null } {
	if (!isFields(body) || !Array.isArray(body['blocks']) || !(body['nextKey'] === null || typeof body['nextKey'] === 'string')) {
		throw(new Error(`not a page of a chain: ${JSON.stringify(body).slice(0, 200)}`));
	}
	const blocks = body['blocks'].map(function(entry: unknown): ChainBlock {
		let block: unknown;
		if (isFields(entry)) {
			block = entry['block'];
		}
		if (!isFields(block) || typeof block['$hash'] !== 'string' || typeof block['previous'] !== 'string' || typeof block['date'] !== 'string') {
			throw(new Error(`not a block of a chain: ${JSON.stringify(entry).slice(0, 200)}`));
		}
		return({ hash: block['$hash'], previous: block['previous'], date: new Date(block['date']) });
	});
	return({ blocks, nextKey: body['nextKey'] });
}

/** How one representative's chain of the account stands to the follower's. */
type ChainCheck =
	| { readonly kind: 'agrees'; readonly head: string; readonly representativeHead: string; readonly lacking: number }
	| { readonly kind: 'disagrees'; readonly head: string | null; readonly representativeHead: string | null; readonly detail: string }
	| { readonly kind: 'unanswered'; readonly detail: string };

/**
 * Reads the representative's chain of the account from its head down to the
 * follower's head, a page at a time. The follower's chain is the
 * representative's when its head is a block of it, since each block names
 * the one before it; the blocks above it, which the follower lacks, must
 * all be dated too recently for the follower to hold them, which the oldest
 * of them decides.
 */
async function chainCheckOf(follower: APISource, representative: APISource, account: string, quietBefore: Date): Promise<ChainCheck> {
	const path = `/node/ledger/account/${account}`;
	try {
		const head = headBlockOf(await getOK(follower, `${path}/head`));
		let representativeHead: string | null = null;
		let oldestLacked: ChainBlock | undefined;
		let lacking = 0;
		let start = 'HEAD';
		for (let page = 0; page < CHAIN_PAGES; page++) {
			let end = '';
			if (head !== null) {
				end = `&end=${head}`;
			}
			const { blocks, nextKey } = chainPageOf(await getOK(representative, `${path}/chain?start=${start}${end}&limit=${String(CHAIN_PAGE_BLOCKS)}`));
			representativeHead = representativeHead ?? blocks[0]?.hash ?? null;
			for (const block of blocks) {
				if (block.hash === head && representativeHead !== null) {
					return(lackedCheck(head, representativeHead, oldestLacked, lacking, quietBefore));
				}
				lacking++;
				oldestLacked = block;
			}
			if (nextKey === null) {
				return({ kind: 'disagrees', head, representativeHead, detail: `the follower's head ${head ?? 'null'} is no block of the representative's chain` });
			}
			start = nextKey;
		}
		return({ kind: 'unanswered', detail: `the representative's chain holds more than ${String(CHAIN_PAGES * CHAIN_PAGE_BLOCKS)} blocks past the follower's head` });
	} catch (error: unknown) {
		return({ kind: 'unanswered', detail: messageOf(error) });
	}
}

function lackedCheck(head: string, representativeHead: string, oldestLacked: ChainBlock | undefined, lacking: number, quietBefore: Date): ChainCheck {
	if (oldestLacked === undefined) {
		return({ kind: 'agrees', head, representativeHead, lacking });
	}
	if (oldestLacked.previous !== head) {
		return({ kind: 'disagrees', head, representativeHead, detail: `the block ${oldestLacked.hash} above the follower's head names ${oldestLacked.previous} before it` });
	}
	if (oldestLacked.date.getTime() + BLOCK_DATE_VOTE_SPREAD_MILLISECONDS < quietBefore.getTime()) {
		return({ kind: 'disagrees', head, representativeHead, detail: `the follower lacks the block ${oldestLacked.hash}, dated ${oldestLacked.date.toISOString()}, before its reach less the margin` });
	}
	return({ kind: 'agrees', head, representativeHead, lacking });
}

function chainReadingOf(representative: APISource, check: ChainCheck): RepresentativeReading {
	switch (check.kind) {
		case 'agrees':
			return({ representative: representative.endpoint, kind: 'agrees', state: { head: check.representativeHead, lacking: check.lacking }, staple: null });
		case 'disagrees':
			return({ representative: representative.endpoint, kind: 'disagrees', state: { head: check.representativeHead, detail: check.detail }, staple: null });
		case 'unanswered':
			return({ representative: representative.endpoint, kind: 'unanswered', detail: check.detail });
		default:
			return(assertNever(check));
	}
}

/**
 * Compares the account's chain with the representative's, and reads a chain
 * that disagrees again from every other representative, by the same rule as
 * a state.
 */
async function compareByChain(setup: Comparing, representative: APISource, account: string, quietBefore: Date): Promise<SweepOutcome> {
	const check = await chainCheckOf(setup.follower, representative, account, quietBefore);
	switch (check.kind) {
		case 'agrees':
			return({ kind: 'compared-chain', head: check.head, representativeHead: check.representativeHead, lacking: check.lacking });
		case 'unanswered':
			return({ kind: 'skipped', reason: 'unanswered', detail: check.detail });
		case 'disagrees':
			break;
		default:
			return(assertNever(check));
	}
	const others = setup.representatives.filter(function(other): boolean {
		return(other.endpoint !== representative.endpoint);
	});
	const readings = await Promise.all(others.map(async function(other) {
		return(chainReadingOf(other, await chainCheckOf(setup.follower, other, account, quietBefore)));
	}));
	const divergence = { account, field: 'chain', staple: null };
	const representativeChain = { head: check.representativeHead, detail: check.detail };
	const dissentingHeads = [check.representativeHead, ...readings.map(function(reading): string | null {
		if (reading.kind !== 'disagrees') {
			return(null);
		}
		return(chainHeadOf(reading.state));
	})];
	const followerHoldsDissent = (await Promise.all(dissentingHeads.map(function(head): Promise<boolean> {
		if (head === null) {
			return(Promise.resolve(true));
		}
		return(setup.store.holdsBlock(head));
	}))).every(function(held): boolean {
		return(held);
	});
	let kind = disputedKindOf(readings, divergence.field, { compared: representativeChain, followerHoldsDissent });
	/*
	 * A representative whose chain runs on past the follower's head agrees
	 * with the follower's chain, but holds the account at another point, so
	 * it does not count toward the two that must hold it at the follower's.
	 */
	const atFollowersHead = readings.filter(function(reading): boolean {
		return(reading.kind === 'agrees' && chainHeadOf(reading.state) === check.head);
	}).length;
	if (kind === 'representative-local' && atFollowersHead < 2) {
		kind = 'unresolved';
	}
	return(await withSelfCheck(setup, { kind, divergence, follower: { head: check.head }, representative: representativeChain, readings, selfCheck: null }));
}

function isMoving(outcome: SweepOutcome): boolean {
	return(outcome.kind === 'skipped' && outcome.reason === 'moving');
}

function holdsRecent(known: KnownAccount, quietBefore: Date): boolean {
	return(known.newestStaple !== undefined && known.newestStaple.getTime() >= quietBefore.getTime());
}

/**
 * Compares a chain account by itself; one found moving is compared again at
 * once a few times, and one still moving, as a busy account is on every
 * attempt, by its chain, which needs no quiet hour. One the follower itself
 * holds a staple of from within the margin is moving whatever is read again,
 * so its chain is compared at once.
 */
async function compareChainKnown(setup: Comparing & Pick<SweepSetup, 'stopped'>, representative: APISource, known: KnownAccount, quietBefore: Date): Promise<SweepOutcome> {
	let outcome = await compareKnown(setup, representative, known, quietBefore);
	for (let retry = 0; retry < MOVING_RETRIES && isMoving(outcome) && !holdsRecent(known, quietBefore) && !isStopped(setup.stopped); retry++) {
		outcome = await compareAdjudicated(setup, representative, known.account, quietBefore);
	}
	if (!isMoving(outcome) || isStopped(setup.stopped)) {
		return(outcome);
	}
	return(await compareByChain(setup, representative, known.account, quietBefore));
}

/**
 * Compares an account by itself, unless the follower holds a staple of it
 * from within the margin of its reach: then it is moving whatever a
 * representative holds, and none is asked about it.
 */
function compareKnown(setup: Comparing, representative: APISource, known: KnownAccount, quietBefore: Date): Promise<SweepOutcome> {
	if (holdsRecent(known, quietBefore)) {
		return(Promise.resolve({ kind: 'skipped', reason: 'moving', side: 'follower', detail: FOLLOWER_HOLDS_RECENT }));
	}
	return(compareAdjudicated(setup, representative, known.account, quietBefore));
}

function recordOf(representative: APISource, account: string, lap: number, walk: RecordedWalk, outcome: SweepOutcome): SweepRecord {
	return({ kind: 'sweep', at: new Date().toISOString(), representative: representative.endpoint, account, lap, walk, outcome });
}

/** Compares a batch of chain accounts, one worker for each representative, each taking every so many of the accounts, and records each as it is compared. */
async function compareChainAccounts(setup: SweepSetup, batch: readonly KnownAccount[], lap: number, quietBefore: Date): Promise<Tally> {
	const tally = emptyTally();
	const workers = setup.representatives.map(async function(representative, worker) {
		for (let index = worker; index < batch.length; index += setup.representatives.length) {
			const known = batch[index];
			if (known === undefined) {
				continue;
			}
			const outcome = await compareChainKnown(setup, representative, known, quietBefore);
			if (isStopped(setup.stopped)) {
				return;
			}
			await setup.log.append([recordOf(representative, known.account, lap, 'chain', outcome)]);
			tally.walked++;
			count(tally, outcome);
		}
	});
	await Promise.all(workers);
	return(tally);
}

/**
 * Compares by itself, at the end of a lap of the chain walk, each chain
 * account the lap did not walk: one that gained its chain after the walk
 * passed its row, which the passive walk may not have reached either.
 */
async function compareLateChainAccounts(setup: SweepSetup, lap: number, quietBefore: Date, limit: number): Promise<LapEnd> {
	const walked = new Set<string>();
	for (const record of (await setup.log.read()).records) {
		if (record.kind === 'sweep' && record.walk === 'chain' && record.lap === lap) {
			walked.add(record.account);
		}
	}
	const late = (await setup.store.chainAccounts()).filter(function(known): boolean {
		return(!walked.has(known.account));
	});
	return({ tally: await compareChainAccounts(setup, late.slice(0, limit), lap, quietBefore), done: late.length <= limit });
}

/** The error an entry of a list of states holds in place of a state, or nothing. */
function stateErrorOf(entry: unknown): string | undefined {
	if (isFields(entry) && typeof entry['error'] === 'string') {
		return(entry['error']);
	}
	return(undefined);
}

/** The states a list of accounts was answered with, one for each in the order asked, or an error naming why it is not that. */
function statesOf(body: unknown, accounts: readonly KnownAccount[]): readonly unknown[] {
	if (!Array.isArray(body) || body.length !== accounts.length || !accounts.every(function(known, index): boolean {
		const entry: unknown = body[index];
		return(isFields(entry) && entry['account'] === known.account);
	})) {
		throw(new Error(`not the state of each account requested: ${JSON.stringify(body).slice(0, 200)}`));
	}
	return(body);
}

type PassiveBatch = { readonly records: readonly SweepRecord[]; readonly batch: SweepBatchRecord };

/**
 * Compares a batch of passive accounts with one representative: both are
 * asked for the states of all of them in one request, and an account
 * answered alike matches, as no lag of either side makes two states equal
 * that are not. An account answered apart is compared by itself, as a chain
 * account is, with its newest staple, the latest that touched it, for a
 * head: the difference counts only when that staple was voted on before the
 * follower's reach, by the margin, so that the follower holds every staple
 * of the account the representative does, and it is read again there, on
 * both sides; otherwise the account is skipped as moving, and compared
 * again on the next lap. The hour is the quiet window the difference must
 * persist across, so the second reading follows at once. Nothing is
 * returned once the sweep is stopped.
 */
async function comparePassiveBatch(setup: SweepSetup, representative: APISource, batch: readonly KnownAccount[], afterRowID: string, lap: number, quietBefore: Date): Promise<PassiveBatch | undefined> {
	const path = `/node/ledger/accounts/${batch.map(function(known): string {
		return(known.account);
	}).join(',')}`;
	const records: SweepRecord[] = [];
	const skipped: string[] = [];
	let matched = 0;
	let unanswered: string | null = null;
	let followerAnswer: APIAnswer | undefined;
	let representativeStates: readonly unknown[] = [];
	try {
		followerAnswer = await setup.follower.get(path);
		representativeStates = statesOf(await getOK(representative, path), batch);
	} catch (error: unknown) {
		unanswered = messageOf(error);
	}
	/*
	 * A follower that fails the request, or answers it with a list that is
	 * not one state for each account, has each account compared by itself,
	 * where what it answers for the account is recorded.
	 */
	let followerStates: readonly unknown[] | undefined;
	if (followerAnswer?.status === 200) {
		try {
			followerStates = statesOf(followerAnswer.body, batch);
		} catch {
			followerStates = undefined;
		}
	}
	for (const [index, known] of batch.entries()) {
		if (unanswered !== null) {
			skipped.push(known.account);
			continue;
		}
		const theirs = representativeStates[index];
		if (followerStates !== undefined && isDeepStrictEqual(followerStates[index], theirs)) {
			const error = stateErrorOf(theirs);
			if (error === undefined) {
				matched++;
				continue;
			}
			records.push(recordOf(representative, known.account, lap, 'passive', { kind: 'error-both', error }));
			skipped.push(known.account);
			continue;
		}
		const outcome = await compareKnown(setup, representative, known, quietBefore);
		records.push(recordOf(representative, known.account, lap, 'passive', outcome));
		if (outcome.kind === 'skipped' || outcome.kind === 'error-both') {
			skipped.push(known.account);
		}
	}
	if (isStopped(setup.stopped)) {
		return(undefined);
	}
	const throughRowID = batch.at(-1)?.rowID ?? afterRowID;
	return({
		records,
		batch: { kind: 'sweep-batch', at: new Date().toISOString(), representative: representative.endpoint, lap, afterRowID, throughRowID, accounts: batch.length, matched, skipped, unanswered }
	});
}

/**
 * Compares a batch of passive accounts, consecutive in their rows, a
 * request's worth for each representative in turn, so many for each, and
 * records each part as it is compared. The cursor moves past the batch only
 * once every part is compared, so a stop compares the whole batch again.
 */
async function comparePassiveAccounts(setup: SweepSetup, batch: readonly KnownAccount[], cursor: SweepCursor, quietBefore: Date): Promise<Tally> {
	const tally = emptyTally();
	const slots = setup.representatives.length * setup.passiveRequestsInFlight;
	const parts = Array.from({ length: slots }, function(_, index) {
		return(index);
	}).flatMap(function(index) {
		const representative = setup.representatives[index % setup.representatives.length];
		const part = batch.slice(index * ACCOUNTS_PER_STATES_REQUEST, (index + 1) * ACCOUNTS_PER_STATES_REQUEST);
		const afterRowID = batch[index * ACCOUNTS_PER_STATES_REQUEST - 1]?.rowID ?? cursor.afterRowID;
		if (representative === undefined || part.length === 0) {
			return([]);
		}
		return([{ representative, part, afterRowID }]);
	});
	await Promise.all(parts.map(async function({ representative, part, afterRowID }) {
		const compared = await comparePassiveBatch(setup, representative, part, afterRowID, cursor.lap, quietBefore);
		if (compared === undefined) {
			return;
		}
		await setup.log.append([...compared.records, compared.batch]);
		tally.matched += compared.batch.matched;
		tally.compared += compared.batch.matched;
		for (const record of compared.records) {
			count(tally, record.outcome);
		}
		if (compared.batch.unanswered !== null) {
			tally.skipped += compared.batch.skipped.length;
		}
	}));
	return(tally);
}

/** Where the follower holds every staple before, less the margin, read afresh for each batch; nothing while it has read from no representative. */
async function quietBeforeOf(store: SweepStore): Promise<Date | undefined> {
	const { heldBefore } = await store.progress();
	if (heldBefore === undefined) {
		return(undefined);
	}
	return(new Date(heldBefore.getTime() - QUIET_MARGIN_MILLISECONDS));
}

/** What a walk compared at the end of a lap, and whether it compared all it had to, so that the lap may end. */
type LapEnd = { readonly tally: Tally; readonly done: boolean };

type Walk = {
	readonly name: SweepWalk;
	/** How many accounts one batch walks past, before the cursor moves. */
	readonly batchSize: number;
	accountsAfter(rowID: string, count: number): Promise<readonly KnownAccount[]>;
	compare(batch: readonly KnownAccount[], cursor: SweepCursor, quietBefore: Date): Promise<Tally>;
	/** What the walk compares once it has gone past the last account of the lap, before the lap ends, at most so many accounts. */
	lapEnd(lap: number, quietBefore: Date, limit: number): Promise<LapEnd>;
};

/**
 * Walks the accounts of one kind, in the order of their rows, from where
 * the walk stopped last, and moves its cursor after each batch. Past the
 * last account, a new lap begins at the first, which compares again what
 * was skipped. Nothing is walked while the follower has read from no
 * representative, since every account would be moving.
 */
async function walk(setup: SweepSetup, walking: Walk): Promise<WalkSummary> {
	const path = setup.cursorPaths[walking.name];
	const limit = setup.accounts[walking.name];
	let cursor = await readSweepCursor(path);
	const tally = emptyTally();
	let emptyLaps = 0;
	while (tally.walked < limit && !isStopped(setup.stopped) && emptyLaps < 2) {
		const quietBefore = await quietBeforeOf(setup.store);
		if (quietBefore === undefined) {
			break;
		}
		const batch = await walking.accountsAfter(cursor.afterRowID, Math.min(limit - tally.walked, walking.batchSize));
		const last = batch.at(-1);
		if (last === undefined) {
			const ending = await walking.lapEnd(cursor.lap, quietBefore, limit - tally.walked);
			addTally(tally, ending.tally);
			if (isStopped(setup.stopped) || !ending.done) {
				break;
			}
			cursor = { lap: cursor.lap + 1, afterRowID: START.afterRowID };
			await writeSweepCursor(path, cursor);
			emptyLaps++;
			if (setup.toLapEnd) {
				break;
			}
			continue;
		}
		emptyLaps = 0;
		const compared = await walking.compare(batch, cursor, quietBefore);
		if (isStopped(setup.stopped)) {
			break;
		}
		addTally(tally, { ...compared, walked: batch.length });
		cursor = { lap: cursor.lap, afterRowID: last.rowID };
		await writeSweepCursor(path, cursor);
	}
	return({ ...tally, cursor });
}

/**
 * Walks the follower's accounts in two walks side by side, each with its
 * own cursor, sharing the representatives' pace: the accounts with a chain
 * one at a time, compared at the same head; the rest, which only other
 * accounts' blocks change, a request's worth at a time.
 */
export async function sweepAccounts(setup: SweepSetup): Promise<SweepSummary> {
	if (setup.representatives.length === 0) {
		throw(new Error('the sweep needs a representative to compare with'));
	}
	const [chain, passive] = await Promise.all([
		walk(setup, {
			name: 'chain',
			batchSize: setup.representatives.length * CHAIN_ACCOUNTS_PER_REPRESENTATIVE_IN_A_BATCH,
			accountsAfter(rowID, size) {
				return(setup.store.chainAccountsAfter(rowID, size));
			},
			compare(batch, cursor, quietBefore) {
				return(compareChainAccounts(setup, batch, cursor.lap, quietBefore));
			},
			lapEnd(lap, quietBefore, limit) {
				return(compareLateChainAccounts(setup, lap, quietBefore, limit));
			}
		}),
		walk(setup, {
			name: 'passive',
			batchSize: setup.representatives.length * setup.passiveRequestsInFlight * ACCOUNTS_PER_STATES_REQUEST,
			accountsAfter(rowID, size) {
				return(setup.store.passiveAccountsAfter(rowID, size));
			},
			compare(batch, cursor, quietBefore) {
				return(comparePassiveAccounts(setup, batch, cursor, quietBefore));
			},
			lapEnd() {
				return(Promise.resolve({ tally: emptyTally(), done: true }));
			}
		})
	]);
	return({ chain, passive });
}

/** A chain divergence is compared again by the chain, which its account was compared by for moving on every attempt. */
function compareAgain(setup: Comparing, representative: APISource, record: SweepRecord, quietBefore: Date): Promise<SweepOutcome> {
	if ((record.outcome.kind === 'diverged' || record.outcome.kind === 'unresolved' || record.outcome.kind === 'representative-local') && record.outcome.divergence.field === 'chain') {
		return(compareByChain(setup, representative, record.account, quietBefore));
	}
	return(compareAdjudicated(setup, representative, record.account, quietBefore));
}

export type RecheckSetup = Pick<SweepSetup, 'follower' | 'representatives' | 'store' | 'log' | 'stopped'>;

/** How many accounts were compared again, by the outcome each had. */
export type RecheckSummary = Readonly<Partial<Record<SweepOutcome['kind'], number>>>;

/** The latest record of each account that read something of it, a comparison or an error both sides answered, in the order the accounts were first read. */
function latestReadings(records: readonly SweepRecord[]): readonly SweepRecord[] {
	const latest = new Map<string, SweepRecord>();
	for (const record of records) {
		if (record.outcome.kind !== 'skipped') {
			latest.set(record.account, record);
		}
	}
	return([...latest.values()]);
}

/**
 * Compares again each account whose latest comparison diverged or was
 * unresolved, or left the difference to the representatives apart without
 * a consistent check of the follower's balances, or whose latest reading
 * both sides answered with the same error, with the representative it was compared with and read again
 * from every other, and records the outcome in that comparison's walk and
 * lap, where it stands as the account's latest. A representative the run
 * does not reach leaves its accounts as they stand.
 */
export async function recheckDivergences(setup: RecheckSetup): Promise<RecheckSummary> {
	const quietBefore = await quietBeforeOf(setup.store);
	if (quietBefore === undefined) {
		throw(new Error('the follower has read from no representative yet'));
	}
	const disputed = latestReadings((await setup.log.read()).records.filter(function(record): record is SweepRecord {
		return(record.kind === 'sweep');
	})).filter(function(record): boolean {
		return(record.outcome.kind === 'diverged' || record.outcome.kind === 'unresolved' || record.outcome.kind === 'error-both' || (record.outcome.kind === 'representative-local' && record.outcome.selfCheck?.kind !== 'consistent'));
	});
	const summary: Partial<Record<SweepOutcome['kind'], number>> = {};
	for (const record of disputed) {
		const representative = setup.representatives.find(function(source): boolean {
			return(source.endpoint === record.representative);
		});
		if (representative === undefined) {
			continue;
		}
		const outcome = await compareAgain(setup, representative, record, quietBefore);
		if (isStopped(setup.stopped)) {
			break;
		}
		await setup.log.append([recordOf(representative, record.account, record.lap, record.walk, outcome)]);
		summary[outcome.kind] = (summary[outcome.kind] ?? 0) + 1;
	}
	return(summary);
}

/**
 * Reads of the follower's state of a passive account after the
 * representative's, a second apart, for the follower to reach the state the
 * representative served: three minutes, as the follower may add a staple a
 * representative added a minute or more later, and each state of a busy
 * account stands for the seconds until its next staple.
 */
const FOLLOWER_CATCH_UP_READS = 180;

const FOLLOWER_CATCH_UP_INTERVAL_MILLISECONDS = 1000;

/** Waits that long, as the caller's clock runs. */
export type Wait = (milliseconds: number) => Promise<void>;

/** The newest staple of the account a node serves, by the hash of its blocks, or null for an account with no history. */
async function newestStapleServed(source: APISource, account: string): Promise<string | null> {
	return(newestStapleOf(await getOK(source, `/node/ledger/account/${account}/history?limit=1`))?.staple ?? null);
}

/**
 * Compares a passive account by itself as its walk compares one in a batch,
 * at the same point of its history: the follower is read again until it
 * holds, as its newest staple of the account, the newest the
 * representative held when it served its state, and the state then matches
 * when it is the representative's. A value alone may come round again,
 * as when an account is credited the same amount time after time, so only
 * the same newest staple places both at one point. An account a staple
 * touches every few seconds needs those reads; states apart are compared
 * by themselves.
 */
async function comparePassiveAlone(setup: Comparing & Pick<SweepSetup, 'stopped'>, representative: APISource, account: string, quietBefore: Date, wait: Wait): Promise<SweepOutcome> {
	const path = `/node/ledger/account/${account}`;
	try {
		const representativeState = await getOK(representative, path);
		const representativeNewest = await newestStapleServed(representative, account);
		if (stateErrorOf(representativeState) === undefined) {
			for (let read = 0; read < FOLLOWER_CATCH_UP_READS && !isStopped(setup.stopped); read++) {
				if (read > 0) {
					await wait(FOLLOWER_CATCH_UP_INTERVAL_MILLISECONDS);
				}
				const newestBefore = await newestStapleServed(setup.follower, account);
				const followerState = await getOK(setup.follower, path);
				const newestAfter = await newestStapleServed(setup.follower, account);
				if (newestBefore === representativeNewest && newestAfter === representativeNewest && firstDifference(followerState, representativeState) === undefined) {
					return({ kind: 'match', head: headOf(representativeState), staple: representativeNewest });
				}
			}
		}
	} catch {
		// Compared by itself, which records why it was not answered.
	}
	return(await compareAdjudicated(setup, representative, account, quietBefore));
}

/** The accounts no lap compared, by the walk that missed them: those with a chain as the follower knows them. */
export type NeverCompared = { readonly chain: readonly KnownAccount[]; readonly passive: readonly string[] };

/** An account a complete lap never compared, in the walk and lap that missed it. */
type Missed =
	| { readonly walk: 'chain'; readonly lap: number; readonly known: KnownAccount }
	| { readonly walk: 'passive'; readonly lap: number; readonly account: string };

function accountOf(missed: Missed): string {
	switch (missed.walk) {
		case 'chain':
			return(missed.known.account);
		case 'passive':
			return(missed.account);
		default:
			return(assertNever(missed));
	}
}

/**
 * Compares by itself each account a complete lap never compared, one at a
 * time for each representative in turn, as its walk would, and records it
 * in that walk and lap, so that the lap's coverage completes without a
 * whole new lap. A walk that has completed no lap, its lap given as
 * undefined, has missed none of the accounts it has not walked yet.
 */
export async function compareNeverCompared(setup: RecheckSetup, accounts: NeverCompared, laps: Readonly<Record<SweepWalk, number | undefined>>, wait: Wait): Promise<RecheckSummary> {
	const quietBefore = await quietBeforeOf(setup.store);
	if (quietBefore === undefined) {
		throw(new Error('the follower has read from no representative yet'));
	}
	const { chain: chainLap, passive: passiveLap } = laps;
	const pending: Missed[] = [];
	if (chainLap !== undefined) {
		pending.push(...accounts.chain.map(function(known): Missed {
			return({ walk: 'chain', lap: chainLap, known });
		}));
	}
	if (passiveLap !== undefined) {
		pending.push(...accounts.passive.map(function(account): Missed {
			return({ walk: 'passive', lap: passiveLap, account });
		}));
	}
	const summary: Partial<Record<SweepOutcome['kind'], number>> = {};
	await Promise.all(setup.representatives.map(async function(representative, worker) {
		for (let index = worker; index < pending.length && !isStopped(setup.stopped); index += setup.representatives.length) {
			const missed = pending[index];
			if (missed === undefined) {
				continue;
			}
			let outcome: SweepOutcome;
			switch (missed.walk) {
				case 'chain':
					outcome = await compareChainKnown(setup, representative, missed.known, quietBefore);
					break;
				case 'passive':
					outcome = await comparePassiveAlone(setup, representative, missed.account, quietBefore, wait);
					break;
				default:
					outcome = assertNever(missed);
			}
			if (isStopped(setup.stopped)) {
				return;
			}
			await setup.log.append([recordOf(representative, accountOf(missed), missed.lap, missed.walk, outcome)]);
			summary[outcome.kind] = (summary[outcome.kind] ?? 0) + 1;
		}
	}));
	return(summary);
}
