import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertNever } from '../util/assert-never.js';
import { getOK } from './api-source.js';
import type { APIAnswer, APISource } from './api-source.js';
import type { FollowerStore, KnownAccount } from './follower-store.js';
import { sweepCursorOf } from './log.js';
import type { ParityLog, SweepBatchRecord, SweepCursor, SweepOutcome, SweepRecord, SweepWalk } from './log.js';

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
 * Passive accounts whose states one request asks for. The route takes any
 * number of accounts, as one path [Keeta TS] index.js:58565-58577, so only
 * the length of the request line bounds them: the representatives and the
 * follower answer 431 to a line beyond about 16 KiB, some 225 accounts. A
 * hundred stays well inside that, and a representative answers it in about
 * a second.
 */
export const ACCOUNTS_PER_STATES_REQUEST = 100;

const START: SweepCursor = { lap: 0, afterRowID: '0' };

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
		return({ kind: 'diverged', divergence: { account, field: 'status', staple }, follower: followerAfter, representative: representativeState });
	}
	if (newest !== undefined && !await store.historyHolds(account, newest.staple)) {
		return({ kind: 'diverged', divergence: { account, field: 'history', staple }, follower: followerAfter.body, representative: representativeState });
	}
	/*
	 * The account's state has no node-local field: a node holding the same
	 * ledger answers it exactly as a representative does, which the replay
	 * of its captures checks unnormalized (src/api/captures.test.ts), so the
	 * bodies are compared whole.
	 */
	const field = firstDifference(followerAfter.body, representativeState);
	if (field !== undefined) {
		return({ kind: 'diverged', divergence: { account, field, staple }, follower: followerAfter.body, representative: representativeState });
	}
	return({ kind: 'match', head: headOf(representativeState), staple });
}

/** What the sweep reads of the follower's storage. */
export type SweepStore = Pick<FollowerStore, 'progress' | 'chainAccountsAfter' | 'passiveAccountsAfter' | 'historyHolds'>;

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
	/** Stops the sweep after the batch under way; what that batch compared is not recorded. */
	readonly stopped: AbortSignal;
};

export type WalkSummary = {
	/** Accounts walked past, compared or not. */
	readonly walked: number;
	readonly compared: number;
	readonly matched: number;
	readonly diverged: number;
	/** Accounts not compared: found moving, or unanswered; each is compared again on the next lap. */
	readonly skipped: number;
	readonly cursor: SweepCursor;
};

export type SweepSummary = Readonly<Record<SweepWalk, WalkSummary>>;

type Tally = { walked: number; compared: number; matched: number; diverged: number; skipped: number };

function emptyTally(): Tally {
	return({ walked: 0, compared: 0, matched: 0, diverged: 0, skipped: 0 });
}

function count(tally: Tally, outcome: SweepOutcome): void {
	switch (outcome.kind) {
		case 'match':
			tally.compared++;
			tally.matched++;
			break;
		case 'diverged':
			tally.compared++;
			tally.diverged++;
			break;
		case 'skipped':
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
 * Compares an account by itself, unless the follower holds a staple of it
 * from within the margin of its reach: then it is moving whatever a
 * representative holds, and none is asked about it.
 */
function compareKnown(setup: SweepSetup, representative: APISource, known: KnownAccount, quietBefore: Date): Promise<SweepOutcome> {
	if (known.newestStaple !== undefined && known.newestStaple.getTime() >= quietBefore.getTime()) {
		return(Promise.resolve({ kind: 'skipped', reason: 'moving', side: 'follower', detail: FOLLOWER_HOLDS_RECENT }));
	}
	return(compareAccount({ follower: setup.follower, representative, store: setup.store, quietBefore, account: known.account }));
}

function sweepRecord(representative: APISource, account: string, lap: number, walk: SweepWalk, outcome: SweepOutcome): SweepRecord {
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
			const outcome = await compareKnown(setup, representative, known, quietBefore);
			if (isStopped(setup.stopped)) {
				return;
			}
			await setup.log.append([sweepRecord(representative, known.account, lap, 'chain', outcome)]);
			count(tally, outcome);
		}
	});
	await Promise.all(workers);
	return(tally);
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
 * again on the next lap. Nothing is returned once the sweep is stopped.
 */
async function comparePassiveBatch(setup: SweepSetup, representative: APISource, batch: readonly KnownAccount[], afterRowID: string, lap: number, quietBefore: Date): Promise<PassiveBatch | undefined> {
	const path = `/node/ledger/accounts/${batch.map(function(known): string {
		return(known.account);
	}).join(',')}`;
	const records: SweepRecord[] = [];
	const skipped: string[] = [];
	let matched = 0;
	let unanswered: string | null = null;
	let followerStates: readonly unknown[] | undefined;
	let representativeStates: readonly unknown[] = [];
	try {
		const followerAnswer = await setup.follower.get(path);
		representativeStates = statesOf(await getOK(representative, path), batch);
		if (followerAnswer.status === 200) {
			followerStates = statesOf(followerAnswer.body, batch);
		}
	} catch (error: unknown) {
		unanswered = messageOf(error);
	}
	for (const [index, known] of batch.entries()) {
		if (unanswered !== null) {
			skipped.push(known.account);
			continue;
		}
		if (followerStates !== undefined && isDeepStrictEqual(followerStates[index], representativeStates[index])) {
			matched++;
			continue;
		}
		const outcome = await compareKnown(setup, representative, known, quietBefore);
		records.push(sweepRecord(representative, known.account, lap, 'passive', outcome));
		if (outcome.kind === 'skipped') {
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

/** Compares a batch of passive accounts, consecutive in their rows, a request's worth for each representative, and records each part as it is compared. */
async function comparePassiveAccounts(setup: SweepSetup, batch: readonly KnownAccount[], cursor: SweepCursor, quietBefore: Date): Promise<Tally> {
	const tally = emptyTally();
	const parts = setup.representatives.map(function(representative, index) {
		const part = batch.slice(index * ACCOUNTS_PER_STATES_REQUEST, (index + 1) * ACCOUNTS_PER_STATES_REQUEST);
		const afterRowID = batch[index * ACCOUNTS_PER_STATES_REQUEST - 1]?.rowID ?? cursor.afterRowID;
		return({ representative, part, afterRowID });
	}).filter(function(entry): boolean {
		return(entry.part.length > 0);
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

type Walk = {
	readonly name: SweepWalk;
	/** How many accounts one batch walks past, before the cursor moves. */
	readonly batchSize: number;
	accountsAfter(rowID: string, count: number): Promise<readonly KnownAccount[]>;
	compare(batch: readonly KnownAccount[], cursor: SweepCursor, quietBefore: Date): Promise<Tally>;
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
		tally.walked += batch.length;
		tally.compared += compared.compared;
		tally.matched += compared.matched;
		tally.diverged += compared.diverged;
		tally.skipped += compared.skipped;
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
			}
		}),
		walk(setup, {
			name: 'passive',
			batchSize: setup.representatives.length * ACCOUNTS_PER_STATES_REQUEST,
			accountsAfter(rowID, size) {
				return(setup.store.passiveAccountsAfter(rowID, size));
			},
			compare(batch, cursor, quietBefore) {
				return(comparePassiveAccounts(setup, batch, cursor, quietBefore));
			}
		})
	]);
	return({ chain, passive });
}
