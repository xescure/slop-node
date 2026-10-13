import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import { advanceClock } from '../../../testing/network.js';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import { assertNever } from '../../../util/assert-never.js';
import type { LedgerStorageDriverBase } from '../base.js';
import { blocksHashesOf, checksumOf, hashOf, headOf, identitiesOf, ledgerChecksumOf, orphanedSideRowsOf, requireAt, useFixtures } from './support.js';
import type { FixtureFactory } from './support.js';
import type { DriverUnderTest, StoreSharing } from './types.js';

const lib = KeetaNet.lib;

// Longer than the slop either side of a vote's validity, shorter than a temporary vote's lifetime.
const ADMISSION_DELAY_MILLISECONDS = 120_000;

const NEWCOMER_SEED = '3e9a51c07d2b48f6a1c0e9d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8';

const SERIALS_PER_PROCESS = 10;

type Member = (...input: unknown[]) => Promise<unknown>;

// Ledger and the base call each of these through the instance, so a replacement set on the instance sees every call.
type InterceptedMember = 'beginTransaction' | 'addPendingVote' | 'persistConfirmedStaple';

/** Replaces a member on one instance only, keeping the driver's own behind the replacement. */
function intercept(storage: LedgerStorageDriverBase, name: InterceptedMember, replace: (original: Member) => Member): void {
	const original: unknown = Reflect.get(storage, name);
	if (typeof original !== 'function') {
		throw(new Error(`the driver has no ${name} member`));
	}
	Reflect.set(storage, name, replace(async function(...input: unknown[]): Promise<unknown> {
		const result: unknown = Reflect.apply(original, storage, input);
		return(await result);
	}));
}

/** A promise and the function that settles it. */
function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
	let open = function(): void {
		// Replaced synchronously by the promise executor below.
	};
	const opened = new Promise<void>(function(resolve) {
		open = resolve;
	});
	return({ opened, open });
}

/**
 * Holds the next transactions an instance is asked to open until released.
 * Ledger fixes an attempt's moment before it asks the driver for the
 * transaction, so a held attempt keeps a moment from before the wait, like
 * one queued behind a lock or waiting for a connection.
 * [Keeta TS] index.js:71429-71432
 */
class HeldAdmissions {
	readonly #count: number;
	readonly #arrived = gate();
	readonly #released = gate();
	#held = 0;

	constructor(storage: LedgerStorageDriverBase, count: number) {
		this.#count = count;
		intercept(storage, 'beginTransaction', (original) => {
			return(async (...input: unknown[]): Promise<unknown> => {
				if (this.#held < this.#count) {
					this.#held++;
					if (this.#held === this.#count) {
						this.#arrived.open();
					}
					await this.#released.opened;
				}
				return(await original(...input));
			});
		});
	}

	/** Settles once every attempt to hold has asked for its transaction, and so has its moment. */
	get arrived(): Promise<void> {
		return(this.#arrived.opened);
	}

	release(): void {
		this.#released.open();
	}
}

/**
 * Holds every attempt that reaches a member until a given number have, so
 * each of them has made all its reads before any of them writes, while all of
 * their transactions are open. Attempts that arrive later, the retries, pass
 * at once.
 */
class Barrier {
	readonly #parties: number;
	readonly #all = gate();
	#arrivals = 0;

	constructor(parties: number) {
		this.#parties = parties;
	}

	get arrivals(): number {
		return(this.#arrivals);
	}

	holdBefore(storage: LedgerStorageDriverBase, name: InterceptedMember): void {
		intercept(storage, name, (original) => {
			return(async (...input: unknown[]): Promise<unknown> => {
				this.#arrivals++;
				if (this.#arrivals === this.#parties) {
					this.#all.open();
				}
				await this.#all.opened;
				return(await original(...input));
			});
		});
	}
}

/** Counts the read-write transactions instances open: one for every attempt of a vote or add, retries included. */
class WriteAttempts {
	#count = 0;

	constructor(storages: readonly LedgerStorageDriverBase[]) {
		for (const storage of storages) {
			intercept(storage, 'beginTransaction', (original) => {
				return(async (...input: unknown[]): Promise<unknown> => {
					const [options]: unknown[] = input;
					if (Reflect.get(Object(options), 'readOnly') === false) {
						this.#count++;
					}
					return(await original(...input));
				});
			});
		}
	}

	get count(): number {
		return(this.#count);
	}
}

function settledValues<Value>(outcomes: readonly PromiseSettledResult<Value>[]): Value[] {
	return(outcomes.flatMap(function(outcome): Value[] {
		if (outcome.status === 'fulfilled') {
			return([outcome.value]);
		}
		return([]);
	}));
}

function settledReasons(outcomes: readonly PromiseSettledResult<unknown>[]): unknown[] {
	return(outcomes.flatMap(function(outcome): unknown[] {
		if (outcome.status === 'rejected') {
			return([outcome.reason]);
		}
		return([]);
	}));
}

function newcomerAccount(): Account {
	return(lib.Account.fromSeed(NEWCOMER_SEED, 0));
}

/*
 * Requests run through the public ledger at the same time. Voting and adding
 * check, then write; a driver must keep two requests from both passing the
 * check, whether it serializes them or aborts one for a retry.
 */
export function defineConcurrencyCases(driver: DriverUnderTest): void {
	describe('concurrency', function() {
		const startNetwork = useFixtures(driver);

		test('concurrent competing votes produce exactly one temporary vote', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const representative = requireAt(network.representatives, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const competing = await Promise.all([5n, 7n].map(function(amount) {
				return(sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount, token: network.baseToken, network: network.network }));
			}));

			const outcomes = await Promise.allSettled(competing.map(function(block) {
				return(ledger.vote([block]));
			}));

			const votes = settledValues(outcomes);
			expect(votes).toHaveLength(1);
			const [vote] = votes;
			if (vote === undefined) {
				throw(new Error('one vote expected'));
			}
			expect(vote.$permanent).toBe(false);
			expect(settledReasons(outcomes)).toEqual([expect.objectContaining({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' })]);
			const voted = competing.find(function(block): boolean {
				return(block.hash.toString() === requireAt(vote.blocks, 0).toString());
			});
			const refused = competing.find(function(block): boolean {
				return(block !== voted);
			});
			if (voted === undefined || refused === undefined) {
				throw(new Error('the vote should cover one of the competing blocks'));
			}
			const found = await ledger.getVotesFromMultiplePrevious([genesisHead], 'both', representative);
			expect(identitiesOf(found[genesisHead.toString()])).toEqual([vote.$uid]);
			expect(hashOf(await ledger.getBlockFromPrevious(genesisHead, 'side'))).toBe(hashOf(voted));
			expect(await ledger.getVotes(refused.hash, 'side')).toBeNull();
			expect(await ledger.getBlock(refused.hash, 'side')).toBeNull();
		});

		test('a vote admitted late still sees a competing vote committed meanwhile', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const [first, late] = await Promise.all([5n, 7n].map(function(amount) {
				return(sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount, token: network.baseToken, network: network.network }));
			}));
			if (first === undefined || late === undefined) {
				throw(new Error('two competing blocks expected'));
			}
			const admissions = new HeldAdmissions(storage, 1);
			const lateVote = ledger.vote([late]);
			await admissions.arrived;

			// The competing vote is issued after the late request's moment.
			advanceClock(ADMISSION_DELAY_MILLISECONDS);
			const vote = await ledger.vote([first]);
			admissions.release();

			await expect(lateVote).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' });
			const found = await ledger.getVotesFromMultiplePrevious([genesisHead], 'both', requireAt(network.representatives, 0));
			expect(identitiesOf(found[genesisHead.toString()])).toEqual([vote.$uid]);
		});

		test('side reads admitted late see a vote committed meanwhile', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const idempotent = btoa('queued-order');
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount: 5n, token: network.baseToken, network: network.network, idempotent });
			const admissions = new HeldAdmissions(storage, 4);
			const reading = Promise.all([
				ledger.getVotes(send.hash, 'side'),
				ledger.getBlock(send.hash, 'side'),
				ledger.getBlockFromPrevious(genesisHead, 'side'),
				ledger.getIdempotentBlockHash(user, idempotent, 'side')
			]);
			await admissions.arrived;

			advanceClock(ADMISSION_DELAY_MILLISECONDS);
			const vote = await ledger.vote([send]);
			admissions.release();
			const [votes, block, successor, holder] = await reading;

			expect(identitiesOf(votes)).toEqual([vote.$uid]);
			expect(hashOf(block)).toBe(hashOf(send));
			expect(hashOf(successor)).toBe(hashOf(send));
			expect(hashOf(holder)).toBe(hashOf(send));
		});

		test('gc admitted late keeps a vote committed meanwhile', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount: 5n, token: network.baseToken, network: network.network });
			const admissions = new HeldAdmissions(storage, 1);
			const collecting = ledger.gc();
			await admissions.arrived;

			advanceClock(ADMISSION_DELAY_MILLISECONDS);
			const vote = await ledger.vote([send]);
			admissions.release();

			expect(await collecting).toBe(false);
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual([vote.$uid]);
			const competitor = await sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount: 7n, token: network.baseToken, network: network.network });
			await expect(ledger.vote([competitor])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' });
		});

		test('concurrent adds of one staple apply it once', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			const { node } = await startNode(0);
			advanceClock(1000);
			const send = await sendBlock({ from: user, previous: headOf(network.genesis, user), to: requireAt(network.users, 1), amount: 5n, token: network.baseToken, network: network.network });
			const staple = await confirmedStaple([send], network.representatives);

			const outcomes = await Promise.allSettled([node.ledger.add(staple), node.ledger.add(staple)]);

			expect(settledValues(outcomes).map(blocksHashesOf)).toEqual([blocksHashesOf([staple])]);
			expect(settledReasons(outcomes)).toEqual([expect.objectContaining({ code: 'LEDGER_BLOCK_ALREADY_EXISTS' })]);
			expect(await node.ledger.getBalance(user, network.baseToken)).toBe(395n);
			expect(blocksHashesOf(await node.ledger.getHistory(user, null))).toEqual(blocksHashesOf([staple, network.genesis]));
			// Each applied block enters the checksum by XOR, so a second application would cancel the first.
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, staple]));
		});

		switch (driver.sharing.kind) {
			case 'process-local':
				break;
			case 'shared':
				defineCrossProcessCases(startNetwork, driver.sharing);
				break;
			default:
				assertNever(driver.sharing);
		}
	});
}

/*
 * Two instances on one store stand for two processes of one representative,
 * each with its own connections and its own Ledger for the same key. A
 * barrier holds both attempts after their reads and before their writes, with
 * both transactions open, so the race happens on every run rather than when
 * the timing allows.
 */
function defineCrossProcessCases(startNetwork: FixtureFactory, sharing: Extract<StoreSharing, { kind: 'shared' }>): void {
	test('two processes voting on competing blocks sign one vote, and the other is refused after a retry', async function() {
		const { network, storage, ledger } = await startNetwork();
		const sibling = await sharing.openSibling(storage);
		const representative = requireAt(network.representatives, 0);
		const other = network.createLedger(sibling, representative);
		const user = requireAt(network.users, 0);
		await ledger.add(network.genesis);
		const genesisHead = headOf(network.genesis, user);
		const [mine, theirs] = await Promise.all([5n, 7n].map(function(amount) {
			return(sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount, token: network.baseToken, network: network.network }));
		}));
		if (mine === undefined || theirs === undefined) {
			throw(new Error('two competing blocks expected'));
		}
		const attempts = new WriteAttempts([storage, sibling]);
		const barrier = new Barrier(2);
		barrier.holdBefore(storage, 'addPendingVote');
		barrier.holdBefore(sibling, 'addPendingVote');

		const outcomes = await Promise.allSettled([ledger.vote([mine]), other.vote([theirs])]);

		const votes = settledValues(outcomes);
		expect(votes).toHaveLength(1);
		expect(settledReasons(outcomes)).toEqual([expect.objectContaining({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' })]);
		// The refused attempt's retry fails its check, before it would write. A retry the database aborts again only adds attempts.
		expect(barrier.arrivals).toBeGreaterThanOrEqual(2);
		expect(attempts.count).toBeGreaterThanOrEqual(3);
		for (const reader of [ledger, other]) {
			const found = await reader.getVotesFromMultiplePrevious([genesisHead], 'both', representative);
			expect(identitiesOf(found[genesisHead.toString()])).toEqual(identitiesOf(votes));
		}
		expect(await orphanedSideRowsOf(storage)).toBe(0);
	});

	test('two processes adding one staple apply it once, and the other finds it applied after a retry', async function() {
		const { network, storage, ledger } = await startNetwork();
		const sibling = await sharing.openSibling(storage);
		const other = network.createLedger(sibling, requireAt(network.representatives, 0));
		const user = requireAt(network.users, 0);
		await ledger.add(network.genesis);
		advanceClock(1000);
		const send = await sendBlock({ from: user, previous: headOf(network.genesis, user), to: requireAt(network.users, 1), amount: 5n, token: network.baseToken, network: network.network });
		const staple = await confirmedStaple([send], network.representatives);
		const attempts = new WriteAttempts([storage, sibling]);
		const barrier = new Barrier(2);
		barrier.holdBefore(storage, 'persistConfirmedStaple');
		barrier.holdBefore(sibling, 'persistConfirmedStaple');

		const outcomes = await Promise.allSettled([ledger.add(staple), other.add(staple)]);

		expect(settledValues(outcomes).map(blocksHashesOf)).toEqual([blocksHashesOf([staple])]);
		expect(settledReasons(outcomes)).toEqual([expect.objectContaining({ code: 'LEDGER_BLOCK_ALREADY_EXISTS' })]);
		// The retry finds the staple's blocks applied before it would persist them. A retry the database aborts again only adds attempts.
		expect(barrier.arrivals).toBeGreaterThanOrEqual(2);
		expect(attempts.count).toBeGreaterThanOrEqual(3);
		for (const reader of [ledger, other]) {
			expect(await reader.getBalance(user, network.baseToken)).toBe(395n);
			expect(blocksHashesOf(await reader.getHistory(user, null))).toEqual(blocksHashesOf([staple, network.genesis]));
		}
	});

	test('two processes applying staples that name one new account both apply', async function() {
		const { network, storage, ledger } = await startNetwork();
		const sibling = await sharing.openSibling(storage);
		const other = network.createLedger(sibling, requireAt(network.representatives, 0));
		const newcomer = newcomerAccount();
		await ledger.add(network.genesis);
		advanceClock(1000);
		const staples = await Promise.all([0, 1].map(async function(index) {
			const from = requireAt(network.users, index);
			const send = await sendBlock({ from, previous: headOf(network.genesis, from), to: newcomer, amount: BigInt(index + 5), token: network.baseToken, network: network.network });
			return(await confirmedStaple([send], network.representatives));
		}));
		const attempts = new WriteAttempts([storage, sibling]);
		const barrier = new Barrier(2);
		barrier.holdBefore(storage, 'persistConfirmedStaple');
		barrier.holdBefore(sibling, 'persistConfirmedStaple');

		const outcomes = await Promise.allSettled([ledger.add(requireAt(staples, 0)), other.add(requireAt(staples, 1))]);

		expect(settledReasons(outcomes)).toEqual([]);
		// One of the two attempts conflicts with the other's new account and persists again on its retry. A retry the database aborts again only adds attempts.
		expect(barrier.arrivals).toBeGreaterThanOrEqual(3);
		expect(attempts.count).toBeGreaterThanOrEqual(3);
		for (const reader of [ledger, other]) {
			expect(await reader.getBalance(newcomer, network.baseToken)).toBe(11n);
			expect(blocksHashesOf(await reader.getHistory(newcomer, null)).sort()).toEqual(blocksHashesOf(staples).sort());
		}
	});

	test('serials taken by two processes during overlapping attempts are all distinct and never issued again', async function() {
		const { storage } = await startNetwork();
		const sibling = await sharing.openSibling(storage);
		const instances = [storage, sibling];
		const transactions = await Promise.all(instances.map(function(instance) {
			return(instance.beginTransaction({ identifier: 'suite-serials', readOnly: false }));
		}));

		const taken = await Promise.all(instances.flatMap(function(instance, index) {
			const transaction = requireAt(transactions, index);
			return(Array.from({ length: SERIALS_PER_PROCESS }, function() {
				return(instance.getNextSerialNumber(transaction));
			}));
		}));
		await Promise.all(instances.map(function(instance, index) {
			return(instance.abortTransaction(requireAt(transactions, index)));
		}));
		const later = await Promise.all(instances.map(function(instance) {
			return(instance.getNextSerialNumber());
		}));

		expect(new Set([...taken, ...later]).size).toBe(taken.length + later.length);
		const latestTaken = taken.reduce(function(latest, serial) {
			if (serial > latest) {
				return(serial);
			}
			return(latest);
		});
		for (const serial of later) {
			expect(serial > latestTaken).toBe(true);
		}
	});
}
