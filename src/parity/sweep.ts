import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertNever } from '../util/assert-never.js';
import { getOK } from './api-source.js';
import type { APIAnswer, APISource } from './api-source.js';
import type { FollowerStore, KnownAccount } from './follower-store.js';
import { sweepCursorOf } from './log.js';
import type { ParityLog, SweepCursor, SweepOutcome, SweepRecord } from './log.js';

/** Where the sweep resumes, in the follower's directory. */
export const SWEEP_CURSOR_FILE = 'parity-sweep.json';

export function sweepCursorPath(directory: string): string {
	return(join(directory, SWEEP_CURSOR_FILE));
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

/** Accounts compared before the cursor moves: a few for each representative, which a crash compares again. */
const ACCOUNTS_PER_REPRESENTATIVE_IN_A_BATCH = 8;

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

/** Before any request: the follower itself holds a staple of the account from within the margin of its reach, or nothing at all yet. */
function movingOnFollower(known: KnownAccount, quietBefore: Date | undefined): boolean {
	return(quietBefore === undefined || (known.newestStaple !== undefined && known.newestStaple.getTime() >= quietBefore.getTime()));
}

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
export type SweepStore = Pick<FollowerStore, 'progress' | 'accountsAfter' | 'historyHolds'>;

export type SweepSetup = {
	readonly follower: APISource;
	/** Each account is compared with one of them, in turn; their requests are paced by the caller. */
	readonly representatives: readonly APISource[];
	readonly store: SweepStore;
	readonly log: ParityLog;
	readonly cursorPath: string;
	/** How many accounts to walk past before stopping. */
	readonly accounts: number;
	/** Stops the sweep after the batch under way; what that batch compared is not recorded. */
	readonly stopped: AbortSignal;
};

export type SweepSummary = {
	/** Accounts walked past, compared or not. */
	readonly walked: number;
	/**
	 * Accounts the follower itself holds a staple of from within the margin
	 * of its reach, which are moving whatever a representative holds, so
	 * none is asked about them and they are not recorded; the next lap
	 * walks past them again.
	 */
	readonly movingOnFollower: number;
	readonly compared: number;
	readonly matched: number;
	readonly diverged: number;
	/** Accounts recorded as skipped, after asking a representative. */
	readonly skipped: number;
	readonly cursor: SweepCursor;
};

/** Read through a call, as a signal is aborted while the sweep awaits. */
function isStopped(signal: AbortSignal): boolean {
	return(signal.aborted);
}

/** Compares a batch, one worker for each representative, each taking every so many of the accounts, and records each as it is compared. */
async function compareBatch(setup: SweepSetup, batch: readonly KnownAccount[], lap: number, quietBefore: Date): Promise<readonly SweepOutcome[]> {
	const outcomes: SweepOutcome[] = [];
	const workers = setup.representatives.map(async function(representative, worker) {
		for (let index = worker; index < batch.length; index += setup.representatives.length) {
			const account = batch[index]?.account ?? '';
			const outcome = await compareAccount({ follower: setup.follower, representative, store: setup.store, quietBefore, account });
			if (isStopped(setup.stopped)) {
				return;
			}
			const record: SweepRecord = { kind: 'sweep', at: new Date().toISOString(), representative: representative.endpoint, account, lap, outcome };
			await setup.log.append([record]);
			outcomes.push(outcome);
		}
	});
	await Promise.all(workers);
	return(outcomes);
}

/**
 * Walks the accounts the follower knows, in the order of their rows, from
 * where the last sweep stopped, comparing each with a representative, and
 * moves the cursor after each batch. Past the last account, a new lap
 * begins at the first, which compares again what was skipped as moving.
 */
export async function sweepAccounts(setup: SweepSetup): Promise<SweepSummary> {
	if (setup.representatives.length === 0) {
		throw(new Error('the sweep needs a representative to compare with'));
	}
	let cursor = await readSweepCursor(setup.cursorPath);
	const { heldBefore } = await setup.store.progress();
	let quietBefore: Date | undefined;
	if (heldBefore !== undefined) {
		quietBefore = new Date(heldBefore.getTime() - QUIET_MARGIN_MILLISECONDS);
	}
	const counts = { walked: 0, movingOnFollower: 0, compared: 0, matched: 0, diverged: 0, skipped: 0 };
	let emptyLaps = 0;
	while (counts.walked < setup.accounts && !isStopped(setup.stopped) && emptyLaps < 2) {
		const size = Math.min(setup.accounts - counts.walked, setup.representatives.length * ACCOUNTS_PER_REPRESENTATIVE_IN_A_BATCH);
		const batch = await setup.store.accountsAfter(cursor.afterRowID, size);
		const last = batch.at(-1);
		if (last === undefined) {
			cursor = { lap: cursor.lap + 1, afterRowID: START.afterRowID };
			await writeSweepCursor(setup.cursorPath, cursor);
			emptyLaps++;
			continue;
		}
		emptyLaps = 0;
		const quiet = batch.filter(function(known): boolean {
			return(!movingOnFollower(known, quietBefore));
		});
		let outcomes: readonly SweepOutcome[] = [];
		if (quietBefore !== undefined) {
			outcomes = await compareBatch(setup, quiet, cursor.lap, quietBefore);
		}
		if (isStopped(setup.stopped)) {
			break;
		}
		counts.walked += batch.length;
		counts.movingOnFollower += batch.length - quiet.length;
		for (const outcome of outcomes) {
			switch (outcome.kind) {
				case 'match':
					counts.compared++;
					counts.matched++;
					break;
				case 'diverged':
					counts.compared++;
					counts.diverged++;
					break;
				case 'skipped':
					counts.skipped++;
					break;
				default:
					assertNever(outcome);
			}
		}
		cursor = { lap: cursor.lap, afterRowID: last.rowID };
		await writeSweepCursor(setup.cursorPath, cursor);
	}
	return({ ...counts, cursor });
}
