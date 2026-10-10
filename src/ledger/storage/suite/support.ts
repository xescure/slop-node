import { afterEach, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Node } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { Vote, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { advanceClock, createTestNetwork, freezeClock } from '../../../testing/network.js';
import type { TestLedgerOptions, TestNetwork } from '../../../testing/network.js';
import { nodeLedgerChecksum } from '../base.js';
import type { LedgerDriverTransaction, LedgerStorageDriverBase } from '../base.js';
import { voteExpirySlopMilliseconds } from '../expiry.js';
import { toStapleKey } from '../keys.js';
import type { StapleKey } from '../keys.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

export const GENESIS_MOMENT: Date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
// The key the driver base's test hooks answer to.
export const TESTING_KEY = 'ba48dff1-fc9c-4834-abc0-68434c8dc29b';
export const DEFAULT_WEIGHTS: readonly bigint[] = [400n, 300n, 300n];
// Upstream's documented default for LedgerConfig.heapProcessWindowMs, which a ledger without one replays for.
export const DEFAULT_REPLAY_WINDOW_MILLISECONDS = 5000;

export type NetworkFixture = {
	readonly network: TestNetwork;
	readonly storage: LedgerStorageDriverBase;
	readonly ledger: Ledger;
	/** Another representative's ledger on a driver of its own, with genesis added. */
	readonly startPeer: (representative: number, options?: TestLedgerOptions) => Promise<Ledger>;
	/** A node for a representative on a driver of its own, with genesis added. */
	readonly startNode: (representative: number, options?: TestLedgerOptions) => Promise<NodeFixture>;
};

export type NodeFixture = {
	readonly node: Node;
	readonly storage: LedgerStorageDriverBase;
};

export type FixtureFactory = (weights?: readonly bigint[], ledgerOptions?: TestLedgerOptions) => Promise<NetworkFixture>;

/*
 * Registers cleanup for every storage instance a case creates, so a failing
 * case still releases its driver and restores the real clock.
 */
export function useFixtures(driver: DriverUnderTest): FixtureFactory {
	const created: LedgerStorageDriverBase[] = [];

	afterEach(async function() {
		vi.useRealTimers();
		const toDestroy = created.splice(0);
		for (const storage of toDestroy) {
			await driver.destroy(storage);
		}
	});

	async function createStorage(): Promise<LedgerStorageDriverBase> {
		const storage = await driver.create();
		created.push(storage);
		return(storage);
	}

	return(async function(weights = DEFAULT_WEIGHTS, ledgerOptions = {}) {
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: weights });
		const storage = await createStorage();
		const ledger = network.createLedger(storage, requireAt(network.representatives, 0), ledgerOptions);
		return({
			network,
			storage,
			ledger,
			async startPeer(representative, options = {}) {
				const peer = network.createLedger(await createStorage(), requireAt(network.representatives, representative), options);
				await peer.add(network.genesis);
				return(peer);
			},
			async startNode(representative, options = {}) {
				const nodeStorage = await createStorage();
				const node = network.createNode(nodeStorage, requireAt(network.representatives, representative), options);
				await node.ledger.add(network.genesis);
				return({ node, storage: nodeStorage });
			}
		});
	});
}

export function requireAt<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) {
		throw(new Error(`missing element ${String(index)}`));
	}
	return(value);
}

export function headOf(staple: VoteStaple, account: GenericAccount): BlockHash {
	const head = staple.blocks.filter(function(block): boolean {
		return(block.account.comparePublicKey(account));
	}).at(-1);
	if (head === undefined) {
		throw(new Error(`no block for ${account.publicKeyString.get()}`));
	}
	return(head.hash);
}

export function chainLengthOf(staple: VoteStaple, account: GenericAccount): bigint {
	return(BigInt(staple.blocks.filter(function(block): boolean {
		return(block.account.comparePublicKey(account));
	}).length));
}

export function publicKeysOf(accounts: readonly (Account | GenericAccount)[]): string[] {
	return(accounts.map(function(account): string {
		return(account.publicKeyString.get());
	}));
}

/** Runs storage reads in a transaction of their own, which is then abandoned. */
export function readStorage<Result>(storage: LedgerStorageDriverBase, read: (transaction: LedgerDriverTransaction) => Promise<Result>): Promise<Result> {
	return(readStorageAt(storage, new Date(), read));
}

/**
 * Reads as of an earlier moment. Liveness is judged at the transaction's
 * moment, so this shows whether an expired side row is still stored.
 */
export async function readStorageAt<Result>(storage: LedgerStorageDriverBase, moment: Date, read: (transaction: LedgerDriverTransaction) => Promise<Result>): Promise<Result> {
	const transaction = await storage.beginTransaction({ identifier: 'suite-read-storage', readOnly: true, moment });
	try {
		return(await read(transaction));
	} finally {
		await storage.abortTransaction(transaction);
	}
}

/** The side rows that no side vote accounts for; no read can see them, so only a count shows a leak. */
export function orphanedSideRowsOf(storage: LedgerStorageDriverBase): Promise<number> {
	return(readStorage(storage, function(transaction) {
		return(storage._Testing(TESTING_KEY).orphanedSideRows(transaction));
	}));
}

/** The staples the driver holds deferred until any of these blocks arrives, each once. */
export function deferredStaplesWaitingOnOf(storage: LedgerStorageDriverBase, blockHashes: readonly BlockHash[]): Promise<readonly VoteStaple[]> {
	return(readStorage(storage, function(transaction) {
		return(storage._Testing(TESTING_KEY).deferredStaplesWaitingOn(transaction, blockHashes));
	}));
}

/** Runs storage writes in a transaction of their own, committed when they succeed. */
export async function writeStorage<Result>(storage: LedgerStorageDriverBase, write: (transaction: LedgerDriverTransaction) => Promise<Result>): Promise<Result> {
	const transaction = await storage.beginTransaction({ identifier: 'suite-write-storage', readOnly: false });
	let result: Result;
	try {
		result = await write(transaction);
	} catch (error: unknown) {
		await storage.abortTransaction(transaction);
		throw(error);
	}
	await storage.commitTransaction(transaction);
	return(result);
}

/**
 * Runs the action just after the driver has written the staple, when the base
 * stops it waiting as a deferred staple. The base calls its primitives
 * through the instance, so a method set on the instance reaches every driver
 * without knowing its class. The function it returns puts the driver's own
 * primitive back.
 */
export function afterPersisting(storage: LedgerStorageDriverBase, staples: readonly VoteStaple[], action: (staple: StapleKey) => void): () => void {
	const removeDeferredStaple: unknown = Reflect.get(storage, 'removeDeferredStaple');
	if (typeof removeDeferredStaple !== 'function') {
		throw(new Error('the driver has no removeDeferredStaple primitive'));
	}
	const watched = new Set<StapleKey>(staples.map(function(staple): StapleKey {
		return(toStapleKey(staple.blocksHash));
	}));
	Reflect.set(storage, 'removeDeferredStaple', async function(transaction: LedgerDriverTransaction, blocksHash: StapleKey): Promise<void> {
		if (watched.has(blocksHash)) {
			action(blocksHash);
		}
		const removed: unknown = Reflect.apply(removeDeferredStaple, storage, [transaction, blocksHash]);
		await removed;
	});
	return(function(): void {
		Reflect.set(storage, 'removeDeferredStaple', removeDeferredStaple);
	});
}

/** Makes the driver fail just after it has written the staple, the way a lost connection could. */
export function failAfterPersisting(storage: LedgerStorageDriverBase, staple: VoteStaple): () => void {
	return(afterPersisting(storage, [staple], function(blocksHash): void {
		throw(new Error(`injected failure after persisting ${blocksHash}`));
	}));
}

/**
 * Moves the clock on by that much once, just after the driver has written the
 * first of the staples, as a slow write would.
 */
export function slowPersisting(storage: LedgerStorageDriverBase, staples: readonly VoteStaple[], milliseconds: number): () => void {
	let slowed = false;
	return(afterPersisting(storage, staples, function(): void {
		if (!slowed) {
			slowed = true;
			advanceClock(milliseconds);
		}
	}));
}

type Logger = NonNullable<TestLedgerOptions['log']>;

function linesMentioning(lines: readonly string[], staple: VoteStaple): string[] {
	const key = staple.blocksHash.toString();
	return(lines.filter(function(line): boolean {
		return(line.includes(key));
	}));
}

/** Keeps the warning and error lines a ledger logs, so a case can count them. */
export class RecordingLog implements Logger {
	readonly errors: string[] = [];
	readonly warnings: string[] = [];

	log(..._input: unknown[]): void {
		// Only warnings and errors are kept.
	}

	debug(..._input: unknown[]): void {
		// Only warnings and errors are kept.
	}

	info(..._input: unknown[]): void {
		// Only warnings and errors are kept.
	}

	warn(...input: unknown[]): void {
		this.warnings.push(input.map(String).join(' '));
	}

	error(...input: unknown[]): void {
		this.errors.push(input.map(String).join(' '));
	}

	errorsMentioning(staple: VoteStaple): string[] {
		return(linesMentioning(this.errors, staple));
	}

	warningsMentioning(staple: VoteStaple): string[] {
		return(linesMentioning(this.warnings, staple));
	}
}

/** The checksum a node keeps over every block its ledger applied. */
export async function ledgerChecksumOf(node: Node): Promise<bigint> {
	return((await nodeLedgerChecksum(node)).checksum);
}

/** The checksum of exactly these staples' blocks, each counted once. */
export function checksumOf(staples: readonly VoteStaple[]): bigint {
	let checksum = 0n;
	for (const staple of staples) {
		for (const block of staple.blocks) {
			checksum ^= block.hash.toBigInt();
		}
	}
	return(checksum);
}

/**
 * Tracks each account's chain head while a case builds blocks, starting from
 * genesis; an account genesis never touched opens its chain.
 */
export class ChainCursor {
	readonly #genesis: VoteStaple;
	readonly #heads = new Map<string, BlockHash>();

	constructor(genesis: VoteStaple) {
		this.#genesis = genesis;
	}

	previous(account: GenericAccount): BlockHash | null {
		const key = account.publicKeyString.get();
		const head = this.#heads.get(key);
		if (head !== undefined) {
			return(head);
		}
		if (chainLengthOf(this.#genesis, account) === 0n) {
			return(null);
		}
		return(headOf(this.#genesis, account));
	}

	append<Built extends Block>(block: Built): Built {
		this.#heads.set(block.account.publicKeyString.get(), block.hash);
		return(block);
	}
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/** A certificate for the subject, signed by the issuer, valid for a day either side of genesis. */
export async function certificateIssuedBy(issuer: Account, subject: Account, serial: number, isCA: boolean): Promise<InstanceType<typeof KeetaNet.lib.Utils.Certificate.Certificate>> {
	return(await new lib.Utils.Certificate.CertificateBuilder({
		issuer,
		validFrom: new Date(GENESIS_MOMENT.getTime() - DAY_MILLISECONDS),
		validTo: new Date(GENESIS_MOMENT.getTime() + DAY_MILLISECONDS),
		serial,
		isCA
	}).build({ subjectPublicKey: subject }));
}

/** A self-signed certificate valid for a day either side of genesis. */
export function certificateFor(subject: Account, serial: number): Promise<InstanceType<typeof KeetaNet.lib.Utils.Certificate.Certificate>> {
	return(certificateIssuedBy(subject, subject, serial, true));
}

/** Moves the clock to the last moment the vote is still live. */
export function advanceToExpiryEdge(vote: Vote): void {
	advanceClock(vote.validityTo.getTime() + voteExpirySlopMilliseconds - Date.now());
}

export function advancePastExpiry(vote: Vote): void {
	advanceToExpiryEdge(vote);
	advanceClock(1);
}

/** Vote identities in a stable order, or null when there are no votes. */
export function identitiesOf(votes: readonly Vote[] | null | undefined): string[] | null {
	if (votes === null || votes === undefined) {
		return(null);
	}
	return(votes.map(function(vote): string {
		return(vote.$uid);
	}).sort());
}

export function hashOf(item: Block | BlockHash | null): string | null {
	if (item === null) {
		return(null);
	}
	if (lib.Block.isInstance(item)) {
		return(item.hash.toString());
	}
	return(item.toString());
}

export function blocksHashesOf(staples: readonly VoteStaple[]): string[] {
	return(staples.map(function(staple): string {
		return(staple.blocksHash.toString());
	}));
}

export function blockHashesOf(staples: readonly VoteStaple[]): string[] {
	return(staples.flatMap(function(staple): string[] {
		return(staple.blocks.map(function(block): string {
			return(block.hash.toString());
		}));
	}));
}
