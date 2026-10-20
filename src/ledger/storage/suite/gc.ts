import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Vote, VoteBlockHash, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../../upstream/internals.js';
import { assertNever } from '../../../util/assert-never.js';
import { createLedgerError } from '../errors.js';
import { confirmedStaple, feeBlock, manageCertificateBlock, modifyPermissionsBlock, sendBlock } from '../../../testing/blocks.js';
import { advanceClock } from '../../../testing/network.js';
import type { TestLedgerOptions, TestNetwork } from '../../../testing/network.js';
import type { LedgerDriverTransaction, LedgerStorageDriverBase } from '../base.js';
import {
	ChainCursor,
	DEFAULT_REPLAY_WINDOW_MILLISECONDS,
	DEFAULT_WEIGHTS,
	RecordingLog,
	TESTING_KEY,
	advancePastExpiry,
	afterPersisting,
	blocksHashesOf,
	certificateFor,
	checksumOf,
	failAfterPersisting,
	hashOf,
	headOf,
	identitiesOf,
	ledgerChecksumOf,
	orphanedSideRowsOf,
	readStorage,
	readStorageAt,
	requireAt,
	slowPersisting,
	useFixtures,
	writeStorage
} from './support.js';
import type { FixtureFactory, NetworkFixture } from './support.js';
import type { DriverUnderTest, StoreSharing } from './types.js';

const lib = KeetaNet.lib;

const FEE_AMOUNT = 1n;

// Every representative charges the same fee, paid to itself.
const FLAT_FEE: TestLedgerOptions = { fee: { kind: 'flat', amount: FEE_AMOUNT } };

// Our representative is outweighed: the other two confirm staples without it.
const OUTVOTED_WEIGHTS: readonly bigint[] = [100n, 400n, 500n];

const LONE_IDEMPOTENT = btoa('lone-order');

const ABANDONED_IDEMPOTENT = btoa('abandoned-order');

/** Our temporary and permanent votes on a send plus the fee block that pays every voter. */
type OurPermanentVote = {
	readonly send: Block;
	readonly fee: Block;
	readonly ourTemporary: Vote;
	readonly ourPermanent: Vote;
};

type SideRows = {
	readonly votes: string[] | null;
	readonly block: string | null;
};

function compareByHash(left: VoteStaple, right: VoteStaple): number {
	return(Number(left.blocksHash.toString() > right.blocksHash.toString()) - Number(left.blocksHash.toString() < right.blocksHash.toString()));
}

function sortedByHash(staples: readonly VoteStaple[]): VoteStaple[] {
	return([...staples].sort(compareByHash));
}

function sendFrom(network: TestNetwork, user: number, previous: BlockHash, amount: bigint, idempotent?: string): Promise<Block> {
	const from = requireAt(network.users, user);
	const to = requireAt(network.users, (user + 1) % network.users.length);
	return(sendBlock({ from, previous, to, amount, token: network.baseToken, network: network.network, idempotent }));
}

function sendFromGenesis(network: TestNetwork, user: number, amount: bigint, idempotent?: string): Promise<Block> {
	return(sendFrom(network, user, headOf(network.genesis, requireAt(network.users, user)), amount, idempotent));
}

/** A user's send from genesis, and the staple of a send after it, which waits on it. */
type Waiting = {
	readonly first: Block;
	readonly staple: VoteStaple;
};

/*
 * A waiting staple for each of the first users, deferred as it arrives
 * before the send it follows, in the order gc lists them: by their hashes,
 * and deferred in that order.
 */
async function deferredSeconds(network: TestNetwork, ledger: Ledger, users: number): Promise<Waiting[]> {
	const waiting = await Promise.all(Array.from({ length: users }, async function(_unused, user): Promise<Waiting> {
		const first = await sendFromGenesis(network, user, 5n);
		return({ first, staple: await confirmedStaple([await sendFrom(network, user, first.hash, 7n)], network.representatives) });
	}));
	waiting.sort(function(left, right): number {
		return(compareByHash(left.staple, right.staple));
	});
	for (const { staple } of waiting) {
		expect(await ledger.add(staple)).toEqual([]);
	}
	return(waiting);
}

/*
 * Adds the sends the staples wait on, with each replay of them held back, so
 * that they stay deferred for gc to retry whatever the replay window.
 */
async function releaseHeldBack(network: TestNetwork, storage: LedgerStorageDriverBase, ledger: Ledger, waiting: readonly Waiting[]): Promise<void> {
	const restore = afterPersisting(storage, waiting.map(function({ staple }): VoteStaple {
		return(staple);
	}), function(blocksHash): void {
		throw(new Error(`replay of ${blocksHash} held back`));
	});
	try {
		for (const { first } of waiting) {
			await ledger.add(await confirmedStaple([first], network.representatives));
		}
	} finally {
		restore();
	}
}

async function appliedOf(ledger: Ledger, waiting: readonly Waiting[]): Promise<number> {
	let applied = 0;
	for (const { staple } of waiting) {
		if (await ledger.getBlock(requireAt(staple.blocks, 0).hash, 'main') !== null) {
			applied++;
		}
	}
	return(applied);
}

function gcBatchOf(storage: LedgerStorageDriverBase, limit: number): Promise<boolean> {
	return(writeStorage(storage, function(transaction) {
		return(storage._Testing(TESTING_KEY).gcBatch(transaction, limit));
	}));
}

/** Records each retry of the staples, which then fails. */
function failingRetries(storage: LedgerStorageDriverBase, staples: readonly VoteStaple[]): { readonly retried: string[]; readonly restore: () => void } {
	const retried: string[] = [];
	const restore = afterPersisting(storage, staples, function(blocksHash): void {
		retried.push(blocksHash);
		throw(new Error(`injected failure after persisting ${blocksHash}`));
	});
	return({ retried, restore });
}

/*
 * Every representative with a ledger votes temporarily; ours then votes
 * permanently on the send plus a fee block paying each of them.
 */
async function voteOursPermanent(network: TestNetwork, ours: Ledger, peers: readonly Ledger[]): Promise<OurPermanentVote> {
	const send = await sendFromGenesis(network, 0, 5n);
	const ourTemporary = await ours.vote([send]);
	const temporary = [ourTemporary];
	for (const peer of peers) {
		temporary.push(await peer.vote([send]));
	}
	const fee = await feeBlock({
		from: requireAt(network.users, 0),
		previous: send.hash,
		network: network.network,
		payments: network.representatives.slice(0, temporary.length).map(function(to: Account) {
			return({ to, token: network.baseToken, amount: FEE_AMOUNT });
		})
	});
	const ourPermanent = await ours.vote([send, fee], temporary);
	return({ send, fee, ourTemporary, ourPermanent });
}

type CertificateChain = {
	readonly entity: Account;
	readonly grant: Block;
	readonly after: Block;
	readonly triggerStaple: VoteStaple;
	readonly grantStaple: VoteStaple;
	readonly afterStaple: VoteStaple;
	readonly heldStaple: VoteStaple;
};

/*
 * A grant to a certificate the node lacks fails until the holder adds it
 * (D15), so the grant stays deferred past its trigger, with a send waiting on
 * it; the holder then adds the certificate, which releases the grant to gc.
 */
async function grantReleasedByCertificate(network: TestNetwork, ledger: Ledger): Promise<CertificateChain> {
	const entity = requireAt(network.users, 0);
	const holder = requireAt(network.users, 1);
	const cursor = new ChainCursor(network.genesis);
	const certificate = await certificateFor(holder, 11);
	const trigger = cursor.append(await sendFrom(network, 0, headOf(network.genesis, entity), 1n));
	const grant = cursor.append(await modifyPermissionsBlock({
		account: entity,
		previous: cursor.previous(entity),
		network: network.network,
		principal: { usingCertificate: true, certificateHash: certificate.hash(), certificateAccount: holder },
		method: lib.Block.AdjustMethod.ADD,
		permissions: new lib.Permissions(['ACCESS'])
	}));
	const after = cursor.append(await sendFrom(network, 0, grant.hash, 2n));
	const [triggerStaple, grantStaple, afterStaple] = await Promise.all([trigger, grant, after].map(function(block) {
		return(confirmedStaple([block], network.representatives));
	}));
	if (triggerStaple === undefined || grantStaple === undefined || afterStaple === undefined) {
		throw(new Error('three staples expected'));
	}
	expect(await ledger.add(afterStaple)).toEqual([]);
	expect(await ledger.add(grantStaple)).toEqual([]);
	// The grant's replay fails, so it stays deferred, and the send after it keeps waiting on it.
	expect(blocksHashesOf(await ledger.add(triggerStaple))).toEqual(blocksHashesOf([triggerStaple]));
	const heldStaple = await confirmedStaple([cursor.append(await manageCertificateBlock({ account: holder, previous: cursor.previous(holder), network: network.network, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate }))], network.representatives);
	await ledger.add(heldStaple);
	return({ entity, grant, after, triggerStaple, grantStaple, afterStaple, heldStaple });
}

/*
 * A staple whose idempotent key an earlier block took: released by its
 * trigger, it fails on every retry. A zero window leaves it waiting.
 */
async function releasedButFailing({ network, ledger }: Pick<NetworkFixture, 'network' | 'ledger'>): Promise<VoteStaple> {
	const idempotent = btoa('taken-order');
	await ledger.add(network.genesis);
	const keyed = await sendFromGenesis(network, 0, 1n, idempotent);
	const trigger = await sendFrom(network, 0, keyed.hash, 2n);
	const reused = await confirmedStaple([await sendFrom(network, 0, trigger.hash, 4n, idempotent)], network.representatives);
	expect(await ledger.add(reused)).toEqual([]);
	await ledger.add(await confirmedStaple([keyed], network.representatives));
	await ledger.add(await confirmedStaple([trigger], network.representatives));
	return(reused);
}

async function sideRowsOf(transaction: LedgerDriverTransaction, storage: LedgerStorageDriverBase, block: Block): Promise<SideRows> {
	return({
		votes: identitiesOf(await storage.getVotes(transaction, block.hash, 'side')),
		block: hashOf(await storage.getBlock(transaction, block.hash, 'side'))
	});
}

async function sideStapleVotes(storage: LedgerStorageDriverBase, transaction: LedgerDriverTransaction, blocksHash: VoteBlockHash): Promise<string[] | null> {
	const staple = (await storage.getVoteStaples(transaction, [blocksHash], 'side')).get(blocksHash);
	if (staple === undefined) {
		throw(new Error(`no entry for staple ${blocksHash.toString()}`));
	}
	return(identitiesOf(staple?.votes));
}

function deferredWaitingOn(storage: LedgerStorageDriverBase, hash: BlockHash): Promise<string[]> {
	return(readStorage(storage, async function(transaction) {
		return(blocksHashesOf(await storage._Testing(TESTING_KEY).deferredStaplesWaitingOn(transaction, [hash])));
	}));
}

export function defineGcCases(driver: DriverUnderTest): void {
	describe('gc', function() {
		const startNetwork = useFixtures(driver);

		test('gc removes expired side votes and their unreferenced blocks but keeps permanent ones', async function() {
			const { network, storage, ledger, startPeer } = await startNetwork(DEFAULT_WEIGHTS, FLAT_FEE);
			await ledger.add(network.genesis);
			const peer = await startPeer(1, FLAT_FEE);
			const votedAt = new Date();
			const { send, fee, ourTemporary, ourPermanent } = await voteOursPermanent(network, ledger, [peer]);
			const lone = await sendFromGenesis(network, 1, 3n, LONE_IDEMPOTENT);
			const loneVote = await ledger.vote([lone]);
			if (lone.idempotent === undefined) {
				throw(new Error('the lone block carries an idempotent key'));
			}
			const loneKey = LedgerInternals.IdempotentKey.fromAccountAndIdempotent(lone.account, lone.idempotent);
			// Reading as of the vote shows what is stored, expired or not.
			const storedAtVote = function() {
				return(readStorageAt(storage, votedAt, async function(transaction) {
					return({
						send: await sideRowsOf(transaction, storage, send),
						fee: await sideRowsOf(transaction, storage, fee),
						lone: await sideRowsOf(transaction, storage, lone),
						loneKeyHolder: hashOf(await storage.getIdempotentBlockHash(transaction, loneKey, 'side')),
						temporaryStaple: await sideStapleVotes(storage, transaction, ourTemporary.blocksHash)
					});
				}));
			};
			advancePastExpiry(loneVote);
			expect(await storedAtVote()).toEqual({
				send: { votes: identitiesOf([ourTemporary, ourPermanent]), block: hashOf(send) },
				fee: { votes: [ourPermanent.$uid], block: hashOf(fee) },
				lone: { votes: [loneVote.$uid], block: hashOf(lone) },
				loneKeyHolder: hashOf(lone),
				temporaryStaple: [ourTemporary.$uid]
			});
			// An expired vote that gc has not yet collected still covers its blocks.
			expect(await orphanedSideRowsOf(storage)).toBe(0);

			expect(await ledger.gc()).toBe(false);
			expect(await orphanedSideRowsOf(storage)).toBe(0);

			// The permanent vote keeps the send's side block; the lone block lost its only vote.
			expect(await storedAtVote()).toEqual({
				send: { votes: [ourPermanent.$uid], block: hashOf(send) },
				fee: { votes: [ourPermanent.$uid], block: hashOf(fee) },
				lone: { votes: null, block: null },
				loneKeyHolder: null,
				temporaryStaple: null
			});
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual([ourPermanent.$uid]);
			const competitor = await sendFromGenesis(network, 0, 9n);
			await expect(ledger.vote([competitor])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' });
			expect(await ledger.gc()).toBe(false);
			expect(identitiesOf(await ledger.getVotes(fee.hash, 'side'))).toEqual([ourPermanent.$uid]);
		});

		test('gc removes side votes whose blocks were all confirmed under another staple', async function() {
			const { network, storage, ledger, startPeer } = await startNetwork(OUTVOTED_WEIGHTS, FLAT_FEE);
			await ledger.add(network.genesis);
			const peers = [await startPeer(1, FLAT_FEE), await startPeer(2, FLAT_FEE)];
			const { send, fee, ourTemporary, ourPermanent } = await voteOursPermanent(network, ledger, peers);
			// The others confirm exactly our blocks without our vote.
			const published = await confirmedStaple([send, fee], network.representatives.slice(1));
			await ledger.add(published);
			const sideAfterPublish = function() {
				return(readStorage(storage, async function(transaction) {
					return({
						send: identitiesOf(await storage.getVotes(transaction, send.hash, 'side')),
						fee: identitiesOf(await storage.getVotes(transaction, fee.hash, 'side')),
						staple: await sideStapleVotes(storage, transaction, ourPermanent.blocksHash)
					});
				}));
			};
			expect(await sideAfterPublish()).toEqual({
				send: identitiesOf([ourTemporary, ourPermanent]),
				fee: [ourPermanent.$uid],
				staple: [ourPermanent.$uid]
			});

			expect(await ledger.gc()).toBe(false);

			expect(await sideAfterPublish()).toEqual({ send: null, fee: null, staple: null });
			expect(await orphanedSideRowsOf(storage)).toBe(0);
			expect(identitiesOf(await ledger.getVotes(fee.hash, 'main'))).toEqual(identitiesOf(published.votes));
			expect(hashOf(await ledger.getHeadBlock(requireAt(network.users, 0), 'main'))).toBe(hashOf(fee));
		});

		test('gc removes side votes whose staple can no longer be published', async function() {
			const { network, storage, ledger, startPeer } = await startNetwork(OUTVOTED_WEIGHTS, FLAT_FEE);
			await ledger.add(network.genesis);
			const peers = [await startPeer(1, FLAT_FEE), await startPeer(2, FLAT_FEE)];
			const { send, fee, ourPermanent } = await voteOursPermanent(network, ledger, peers);
			// The others confirm our send with a fee block of their own.
			const otherFee = await feeBlock({
				from: requireAt(network.users, 0),
				previous: send.hash,
				network: network.network,
				payments: network.representatives.slice(1).map(function(to: Account) {
					return({ to, token: network.baseToken, amount: FEE_AMOUNT });
				})
			});
			await ledger.add(await confirmedStaple([send, otherFee], network.representatives.slice(1)));
			expect(await readStorage(storage, async function(transaction) {
				return(await sideRowsOf(transaction, storage, fee));
			})).toEqual({ votes: [ourPermanent.$uid], block: hashOf(fee) });

			expect(await ledger.gc()).toBe(false);

			expect(await readStorage(storage, async function(transaction) {
				return({
					fee: await sideRowsOf(transaction, storage, fee),
					successor: hashOf(await storage.getBlockFromPrevious(transaction, send.hash, 'side')),
					staple: await sideStapleVotes(storage, transaction, ourPermanent.blocksHash)
				});
			})).toEqual({ fee: { votes: null, block: null }, successor: null, staple: null });
			expect(await orphanedSideRowsOf(storage)).toBe(0);
			expect(hashOf(await ledger.getBlockFromPrevious(send.hash, 'main'))).toBe(hashOf(otherFee));
		});

		test('gc removes our votes on a competitor of a confirmed block and frees its idempotent key', async function() {
			const { network, storage, ledger, startPeer } = await startNetwork(OUTVOTED_WEIGHTS);
			await ledger.add(network.genesis);
			const peers = [await startPeer(1), await startPeer(2)];
			const abandoned = await sendFromGenesis(network, 0, 5n, ABANDONED_IDEMPOTENT);
			const votedAt = new Date();
			const ourTemporary = await ledger.vote([abandoned]);
			const temporary = [ourTemporary];
			for (const peer of peers) {
				temporary.push(await peer.vote([abandoned]));
			}
			// The client collects our permanent vote and then abandons the staple.
			const ourPermanent = await ledger.vote([abandoned], temporary);
			advancePastExpiry(ourTemporary);
			// Once their temporary votes have expired, the others confirm a competitor without us.
			const competitor = await sendFromGenesis(network, 0, 9n);
			await ledger.add(await confirmedStaple([competitor], network.representatives.slice(1)));
			const reusing = await sendFrom(network, 0, competitor.hash, 1n, ABANDONED_IDEMPOTENT);
			const storedAtVote = function() {
				return(readStorageAt(storage, votedAt, async function(transaction) {
					return(await sideRowsOf(transaction, storage, abandoned));
				}));
			};
			expect(await storedAtVote()).toEqual({ votes: identitiesOf([ourTemporary, ourPermanent]), block: hashOf(abandoned) });
			await expect(ledger.vote([reusing])).rejects.toMatchObject({ code: 'LEDGER_IDEMPOTENT_KEY_EXISTS' });

			expect(await ledger.gc()).toBe(false);

			expect(await storedAtVote()).toEqual({ votes: null, block: null });
			expect(await orphanedSideRowsOf(storage)).toBe(0);
			expect((await ledger.vote([reusing])).$permanent).toBe(false);
		});

		test('gc keeps our permanent vote when an expired vote of ours on a competitor remains', async function() {
			const { network, ledger, startPeer } = await startNetwork();
			await ledger.add(network.genesis);
			const peer = await startPeer(1);
			const competitor = await sendFromGenesis(network, 0, 7n);
			advancePastExpiry(await ledger.vote([competitor]));
			const send = await sendFromGenesis(network, 0, 5n);
			const temporary = [await ledger.vote([send]), await peer.vote([send])];
			const ourPermanent = await ledger.vote([send], temporary);

			expect(await ledger.gc()).toBe(false);

			// A pending competitor is not a confirmed successor, so our votes still guard the previous.
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual(identitiesOf([requireAt(temporary, 0), ourPermanent]));
			const third = await sendFromGenesis(network, 0, 9n);
			await expect(ledger.vote([third])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' });
		});

		test('gc keeps our permanent vote when a deferred staple holds a competitor', async function() {
			const { network, ledger, startPeer } = await startNetwork();
			await ledger.add(network.genesis);
			const peer = await startPeer(1);
			const send = await sendFromGenesis(network, 0, 5n);
			const temporary = [await ledger.vote([send]), await peer.vote([send])];
			const ourPermanent = await ledger.vote([send], temporary);
			// The competitor is confirmed beside a block whose previous this node lacks, so the staple waits.
			const competitor = await sendFromGenesis(network, 0, 7n);
			const missing = await sendFromGenesis(network, 1, 1n);
			const waiting = await sendFrom(network, 1, missing.hash, 2n);
			expect(await ledger.add(await confirmedStaple([competitor, waiting], network.representatives))).toEqual([]);

			expect(await ledger.gc()).toBe(false);

			// A deferred competitor is not a confirmed successor, so our votes still guard the previous.
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual(identitiesOf([requireAt(temporary, 0), ourPermanent]));
			const third = await sendFromGenesis(network, 0, 9n);
			await expect(ledger.vote([third])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' });
		});

		test('gc retries deferred staples whose previous is now on main', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			// A zero window leaves every waiter in the heap, as an exhausted window would.
			const { node } = await startNode(0, { heapProcessWindowMs: 0 });
			const first = await sendFromGenesis(network, 0, 5n);
			const second = await sendFrom(network, 0, first.hash, 7n);
			const firstStaple = await confirmedStaple([first], network.representatives);
			const secondStaple = await confirmedStaple([second], network.representatives);
			expect(await node.ledger.add(secondStaple)).toEqual([]);
			expect(blocksHashesOf(await node.ledger.add(firstStaple))).toEqual(blocksHashesOf([firstStaple]));
			expect(await node.ledger.getBalance(user, network.baseToken)).toBe(395n);
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, firstStaple]));

			expect(await node.ledger.gc()).toBe(false);

			expect(await node.ledger.getBalance(user, network.baseToken)).toBe(388n);
			expect(hashOf(await node.ledger.getHeadBlock(user, 'main'))).toBe(hashOf(second));
			// The checksum counts each block once, whichever path applied it.
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, firstStaple, secondStaple]));
			expect(await node.ledger.gc()).toBe(false);
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, firstStaple, secondStaple]));
			await expect(node.ledger.add(secondStaple)).rejects.toMatchObject({ code: 'LEDGER_BLOCK_ALREADY_EXISTS' });
		});

		test('a gc batch retries the released staples it listed only until the replay window is spent, applying one at least, and says more remain', async function() {
			const { network, startNode } = await startNetwork();
			// A zero window is spent before the batch begins.
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const firsts = [await sendFromGenesis(network, 0, 5n), await sendFromGenesis(network, 1, 5n)];
			const seconds = await Promise.all(firsts.map(function(first, user) {
				return(sendFrom(network, user, first.hash, 7n));
			}));
			for (const second of seconds) {
				expect(await node.ledger.add(await confirmedStaple([second], network.representatives))).toEqual([]);
			}
			for (const first of firsts) {
				await node.ledger.add(await confirmedStaple([first], network.representatives));
			}
			const appliedSeconds = async function(): Promise<number> {
				let applied = 0;
				for (const second of seconds) {
					if (await node.ledger.getBlock(second.hash, 'main') !== null) {
						applied++;
					}
				}
				return(applied);
			};
			const batch = function(): Promise<boolean> {
				return(writeStorage(storage, function(transaction) {
					return(storage._Testing(TESTING_KEY).gcBatch(transaction, 100));
				}));
			};

			expect(await batch()).toBe(true);
			expect(await appliedSeconds()).toBe(1);
			expect(await batch()).toBe(false);
			expect(await appliedSeconds()).toBe(2);
		});

		test('gc runs one batch at least however short its time, and reports whether more remains', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			const { node } = await startNode(0, { heapProcessWindowMs: 0 });
			const first = await sendFromGenesis(network, 0, 5n);
			const second = await sendFrom(network, 0, first.hash, 7n);
			expect(await node.ledger.add(await confirmedStaple([second], network.representatives))).toEqual([]);
			await node.ledger.add(await confirmedStaple([first], network.representatives));

			// Upstream's loop reads the time before its first batch, so a limit spent by then would run none and report nothing left [Keeta TS] index.js:68888-68897.
			expect(await node.ledger.gc(-1)).toBe(false);

			expect(hashOf(await node.ledger.getHeadBlock(user, 'main'))).toBe(hashOf(second));
		});

		test('a released staple whose retry fails keeps no gc going, however short its time: the next is applied, and gc reports nothing left', async function() {
			const { network, startNode } = await startNetwork();
			// A zero window is spent before any batch begins, and a limit below zero spends each gc after one batch.
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const firsts = [await sendFromGenesis(network, 0, 5n), await sendFromGenesis(network, 1, 5n)];
			const seconds = await Promise.all(firsts.map(async function(first, user) {
				return(await confirmedStaple([await sendFrom(network, user, first.hash, 7n)], network.representatives));
			}));
			// The one listed first fails: first by hash, and deferred first.
			const [failing, applying] = sortedByHash(seconds);
			if (failing === undefined || applying === undefined) {
				throw(new Error('two staples expected'));
			}
			for (const staple of [failing, applying]) {
				expect(await node.ledger.add(staple)).toEqual([]);
			}
			for (const first of firsts) {
				await node.ledger.add(await confirmedStaple([first], network.representatives));
			}
			failAfterPersisting(storage, failing);

			const reported: boolean[] = [];
			for (let call = 0; call < 5 && reported.at(-1) !== false; call++) {
				reported.push(await node.ledger.gc(-1));
			}

			expect(reported.at(-1)).toBe(false);
			expect(reported.length).toBeLessThanOrEqual(3);
			expect(hashOf(await node.ledger.getBlock(requireAt(applying.blocks, 0).hash, 'main'))).toBe(hashOf(requireAt(applying.blocks, 0)));
			expect(await node.ledger.getBlock(requireAt(failing.blocks, 0).hash, 'main')).toBeNull();
		});

		test('released staples whose retries fail, listed ahead of a whole batch, keep no later batch from the staple after them', async function() {
			const { network, startNode } = await startNetwork();
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const firsts = await Promise.all(network.users.map(function(_user, index) {
				return(sendFromGenesis(network, index, 5n));
			}));
			const seconds = await Promise.all(firsts.map(async function(first, user) {
				return(await confirmedStaple([await sendFrom(network, user, first.hash, 7n)], network.representatives));
			}));
			// The two listed first fail, and fill a batch of two: first by hash, and deferred first.
			const [firstFailing, secondFailing, applying] = sortedByHash(seconds);
			if (firstFailing === undefined || secondFailing === undefined || applying === undefined) {
				throw(new Error('three staples expected'));
			}
			for (const staple of [firstFailing, secondFailing, applying]) {
				expect(await node.ledger.add(staple)).toEqual([]);
			}
			for (const first of firsts) {
				await node.ledger.add(await confirmedStaple([first], network.representatives));
			}
			afterPersisting(storage, [firstFailing, secondFailing], function(blocksHash): void {
				throw(new Error(`injected failure after persisting ${blocksHash}`));
			});
			const batch = function(): Promise<boolean> {
				return(writeStorage(storage, function(transaction) {
					return(storage._Testing(TESTING_KEY).gcBatch(transaction, 2));
				}));
			};

			const reported: boolean[] = [];
			for (let call = 0; call < 6 && reported.at(-1) !== false; call++) {
				reported.push(await batch());
			}

			expect(reported.at(-1)).toBe(false);
			expect(hashOf(await node.ledger.getBlock(requireAt(applying.blocks, 0).hash, 'main'))).toBe(hashOf(requireAt(applying.blocks, 0)));
			expect(await node.ledger.getBlock(requireAt(firstFailing.blocks, 0).hash, 'main')).toBeNull();
			expect(await node.ledger.getBlock(requireAt(secondFailing.blocks, 0).hash, 'main')).toBeNull();
		});

		test('a released staple whose retry failed is retried once the ledger has applied a staple since, however long ago it failed, and gc reports nothing left meanwhile', async function() {
			const { network, startNode } = await startNetwork();
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const first = await sendFromGenesis(network, 0, 5n);
			const second = await sendFrom(network, 0, first.hash, 7n);
			const secondStaple = await confirmedStaple([second], network.representatives);
			expect(await node.ledger.add(secondStaple)).toEqual([]);
			await node.ledger.add(await confirmedStaple([first], network.representatives));
			const restore = failAfterPersisting(storage, secondStaple);
			expect(await node.ledger.gc()).toBe(false);
			restore();

			expect(await node.ledger.gc()).toBe(false);
			expect(await node.ledger.getBlock(second.hash, 'main')).toBeNull();
			advanceClock(24 * 60 * 60 * 1000);
			expect(await node.ledger.gc()).toBe(false);
			expect(await node.ledger.getBlock(second.hash, 'main')).toBeNull();
			await node.ledger.add(await confirmedStaple([await sendFromGenesis(network, 1, 5n)], network.representatives));
			expect(await node.ledger.gc()).toBe(false);
			expect(hashOf(await node.ledger.getBlock(second.hash, 'main'))).toBe(hashOf(second));
		});

		test('a released staple whose retry fails with an error that asks for the transaction to run again is retried by the next gc, not left until a staple is applied', async function() {
			const { network, startNode } = await startNetwork();
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const first = await sendFromGenesis(network, 0, 5n);
			const second = await sendFrom(network, 0, first.hash, 7n);
			const secondStaple = await confirmedStaple([second], network.representatives);
			expect(await node.ledger.add(secondStaple)).toEqual([]);
			await node.ledger.add(await confirmedStaple([first], network.representatives));
			const restore = afterPersisting(storage, [secondStaple], function(blocksHash): void {
				throw(createLedgerError('LEDGER_TRANSACTION_ABORTED', `injected conflict after persisting ${blocksHash}`, { retry: true }));
			});
			// The gc ends at the failure, and says the staple remains.
			expect(await node.ledger.gc()).toBe(true);
			expect(await node.ledger.getBlock(second.hash, 'main')).toBeNull();
			restore();

			expect(await node.ledger.gc()).toBe(false);
			expect(hashOf(await node.ledger.getBlock(second.hash, 'main'))).toBe(hashOf(second));
		});

		/*
		 * On Postgres the conflict dooms the transaction, so every staple the
		 * gc applied in it after the failure would be rolled back at its commit.
		 */
		test('a released staple whose retry fails with an error that asks for the transaction to run again ends the gc, which retries no other staple in that transaction', async function() {
			const { network, startNode } = await startNetwork();
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const firsts = [await sendFromGenesis(network, 0, 5n), await sendFromGenesis(network, 1, 5n)];
			const seconds = [await sendFrom(network, 0, requireAt(firsts, 0).hash, 7n), await sendFrom(network, 1, requireAt(firsts, 1).hash, 7n)];
			const waiting = await Promise.all(seconds.map(function(second) {
				return(confirmedStaple([second], network.representatives));
			}));
			for (const staple of waiting) {
				expect(await node.ledger.add(staple)).toEqual([]);
			}
			for (const first of firsts) {
				await node.ledger.add(await confirmedStaple([first], network.representatives));
			}
			const retried: string[] = [];
			afterPersisting(storage, waiting, function(blocksHash): void {
				retried.push(blocksHash);
				if (retried.length === 1) {
					throw(createLedgerError('LEDGER_TRANSACTION_ABORTED', `injected conflict after persisting ${blocksHash}`, { retry: true }));
				}
			});

			expect(await node.ledger.gc()).toBe(true);
			expect(retried).toHaveLength(1);

			expect(await node.ledger.gc()).toBe(false);
			expect(new Set(retried)).toEqual(new Set(waiting.map(function(staple): string {
				return(staple.blocksHash.toString());
			})));
			for (const second of seconds) {
				expect(hashOf(await node.ledger.getBlock(second.hash, 'main'))).toBe(hashOf(second));
			}
		});

		test('a released staple whose retry fails with an error that asks for the transaction to run again every time is recorded as failed after the third, and keeps no gc going', async function() {
			const { network, startNode } = await startNetwork();
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const first = await sendFromGenesis(network, 0, 5n);
			const second = await sendFrom(network, 0, first.hash, 7n);
			const secondStaple = await confirmedStaple([second], network.representatives);
			expect(await node.ledger.add(secondStaple)).toEqual([]);
			await node.ledger.add(await confirmedStaple([first], network.representatives));
			let attempts = 0;
			afterPersisting(storage, [secondStaple], function(blocksHash): void {
				attempts++;
				throw(createLedgerError('LEDGER_TRANSACTION_ABORTED', `injected conflict after persisting ${blocksHash}`, { retry: true }));
			});

			const remaining: boolean[] = [];
			for (let call = 0; call < 5; call++) {
				remaining.push(await node.ledger.gc());
			}

			// Retried by each of the first three gcs, the first two of which end at it saying it remains, then left until a staple is applied.
			expect(remaining).toEqual([true, true, false, false, false]);
			expect(attempts).toBe(3);
			expect(await node.ledger.getBlock(second.hash, 'main')).toBeNull();
			await node.ledger.add(await confirmedStaple([await sendFromGenesis(network, 1, 5n)], network.representatives));
			// Due again, its retry fails again, which ends that gc.
			expect(await node.ledger.gc()).toBe(true);
			expect(attempts).toBe(4);
		});

		/*
		 * Each failing retry spends the window and moves the clock on past
		 * any time a gc could wait out, so only the order gc lists released
		 * staples in decides whether the applicable one is ever reached.
		 */
		test('a gc of no time runs one batch, and reports that more remain', async function() {
			// A zero window ends a batch after one retry, and the frozen clock spends no time.
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			await ledger.add(network.genesis);
			const waiting = await deferredSeconds(network, ledger, 2);
			await releaseHeldBack(network, storage, ledger, waiting);

			expect(await ledger.gc(0)).toBe(true);

			expect(await appliedOf(ledger, waiting)).toBe(1);
		});

		test('a gc batch with time left retries every released staple it lists, up to its limit', async function() {
			const { network, storage, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const waiting = await deferredSeconds(network, ledger, 3);
			await releaseHeldBack(network, storage, ledger, waiting);

			expect(await gcBatchOf(storage, 2)).toBe(true);
			expect(await appliedOf(ledger, waiting)).toBe(2);
			expect(await gcBatchOf(storage, 2)).toBe(false);
			expect(await appliedOf(ledger, waiting)).toBe(3);
		});

		test('a gc that ends at a failure the transaction is to run again for collects no side vote in it', async function() {
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			await ledger.add(network.genesis);
			const votedAt = new Date();
			const lone = await sendFromGenesis(network, 1, 3n);
			const loneVote = await ledger.vote([lone]);
			const [waiting] = await deferredSeconds(network, ledger, 1);
			if (waiting === undefined) {
				throw(new Error('a waiting staple expected'));
			}
			await releaseHeldBack(network, storage, ledger, [waiting]);
			const restore = afterPersisting(storage, [waiting.staple], function(blocksHash): void {
				throw(createLedgerError('LEDGER_TRANSACTION_ABORTED', `injected conflict after persisting ${blocksHash}`, { retry: true }));
			});
			advancePastExpiry(loneVote);
			const loneRows = function(): Promise<SideRows> {
				return(readStorageAt(storage, votedAt, function(transaction) {
					return(sideRowsOf(transaction, storage, lone));
				}));
			};

			expect(await ledger.gc()).toBe(true);
			expect(await loneRows()).toEqual({ votes: [loneVote.$uid], block: hashOf(lone) });
			restore();
			expect(await ledger.gc()).toBe(false);
			expect(await loneRows()).toEqual({ votes: null, block: null });
		});

		test('a gc retries a failed staple once, though a staple it applies after makes the failure due again, and a later gc retries it', async function() {
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			await ledger.add(network.genesis);
			const waiting = await deferredSeconds(network, ledger, 2);
			const [failing, applying] = waiting;
			if (failing === undefined || applying === undefined) {
				throw(new Error('two waiting staples expected'));
			}
			await releaseHeldBack(network, storage, ledger, waiting);
			const { retried, restore } = failingRetries(storage, [failing.staple]);

			// One staple a batch: the failing one, listed first, then the other.
			expect(await writeStorage(storage, async function(transaction) {
				const hooks = storage._Testing(TESTING_KEY);
				return([await hooks.gcBatch(transaction, 1), await hooks.gcBatch(transaction, 1), await hooks.gcBatch(transaction, 1)]);
			})).toEqual([true, false, false]);
			expect(retried).toHaveLength(1);
			expect(await appliedOf(ledger, [failing, applying])).toBe(1);
			// Passed over, the failure stays on record, so the staple is not taken for one that never failed.
			expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [failing.staple.blocksHash.toString()], askedToRunAgain: [] });

			restore();
			expect(await ledger.gc()).toBe(false);
			expect(await appliedOf(ledger, [failing])).toBe(1);
			expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [], askedToRunAgain: [] });
		});

		test('a batch the staples that never failed fill retries no failed one, and a failure not yet due takes no place from one that is', async function() {
			const { network, storage, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const [notDue, due] = await deferredSeconds(network, ledger, 2);
			if (notDue === undefined || due === undefined) {
				throw(new Error('two waiting staples expected'));
			}
			const { retried } = failingRetries(storage, [notDue.staple, due.staple]);
			const [notDueKey, dueKey] = [notDue, due].map(function({ staple }): string {
				return(staple.blocksHash.toString());
			});
			// The replay that releasing a staple runs fails as well, and is no retry of gc's.
			const release = async function({ first }: Waiting): Promise<void> {
				const before = retried.length;
				await ledger.add(await confirmedStaple([first], network.representatives));
				retried.splice(before);
			};

			// Released first, the one that is to be due fails first.
			await release(due);
			expect(await gcBatchOf(storage, 1)).toBe(false);
			// The add that releases the other makes the first failure due.
			await release(notDue);
			expect(await gcBatchOf(storage, 1)).toBe(true);
			expect(retried).toEqual([dueKey, notDueKey]);
			// Listed after it, and failed after the last staple applied, the other is not due.
			expect(await gcBatchOf(storage, 1)).toBe(false);
			expect(retried).toEqual([dueKey, notDueKey, dueKey]);
		});

		test('released staples whose retries failed are retried again oldest failure first, as of their last failure', async function() {
			const { network, storage, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const waiting = await deferredSeconds(network, ledger, 2);
			await releaseHeldBack(network, storage, ledger, waiting);
			const { retried } = failingRetries(storage, waiting.map(function({ staple }): VoteStaple {
				return(staple);
			}));
			const [firstKey, secondKey] = waiting.map(function({ staple }): string {
				return(staple.blocksHash.toString());
			});
			const unrelated = await sendFromGenesis(network, 2, 5n);
			const applyUnrelated = async function(block: Block): Promise<void> {
				expect(blocksHashesOf(await ledger.add(await confirmedStaple([block], network.representatives)))).toHaveLength(1);
			};

			expect(await gcBatchOf(storage, 2)).toBe(false);
			expect(retried).toEqual([firstKey, secondKey]);
			await applyUnrelated(unrelated);
			expect(await gcBatchOf(storage, 1)).toBe(true);
			expect(retried).toEqual([firstKey, secondKey, firstKey]);
			await applyUnrelated(await sendFrom(network, 2, unrelated.hash, 3n));
			expect(await gcBatchOf(storage, 1)).toBe(true);
			expect(retried).toEqual([firstKey, secondKey, firstKey, secondKey]);
		});

		test('a gc batch drops a staple that an earlier retry in it kills, reporting it once, as dropped, and keeps no record of its failures', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork([100n, 100n, 100n, 100n], { log });
			await ledger.add(network.genesis);
			const trigger = await sendFromGenesis(network, 0, 1n);
			// Each fork's second block extends a chain nothing else touches.
			const forks = sortedByHash(await Promise.all([1, 2].map(async function(user) {
				return(await confirmedStaple([await sendFrom(network, 0, trigger.hash, BigInt(user) + 4n), await sendFromGenesis(network, user, 1n)], network.representatives));
			})));
			const [applying, killed] = forks;
			if (applying === undefined || killed === undefined) {
				throw(new Error('two forks expected'));
			}
			for (const fork of forks) {
				expect(await ledger.add(fork)).toEqual([]);
			}
			const { restore } = failingRetries(storage, forks);
			await ledger.add(await confirmedStaple([trigger], network.representatives));
			expect(await gcBatchOf(storage, 2)).toBe(false);
			expect(storage._Testing(TESTING_KEY).retryRecords().failed).toHaveLength(2);
			// A staple applied since makes both failures due.
			await ledger.add(await confirmedStaple([await sendFromGenesis(network, 3, 5n)], network.representatives));
			restore();
			log.errors.splice(0);

			expect(await gcBatchOf(storage, 2)).toBe(false);

			expect(hashOf(await ledger.getBlock(requireAt(applying.blocks, 0).hash, 'main'))).toBe(hashOf(requireAt(applying.blocks, 0)));
			expect(await ledger.getBlock(requireAt(killed.blocks, 0).hash, 'main')).toBeNull();
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual([]);
			expect(log.errorsMentioning(killed)).toEqual([`ledger network integrity alarm: dropped deferred staple ${killed.blocksHash.toString()}, which conflicts with confirmed history and can never apply`]);
			expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [], askedToRunAgain: [] });
		});

		test('nothing is kept of a failed retry once an add applies its staple, or gc drops it as dead', async function() {
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			await ledger.add(network.genesis);
			const waiting = await deferredSeconds(network, ledger, 2);
			const [added, killed] = waiting;
			if (added === undefined || killed === undefined) {
				throw(new Error('two waiting staples expected'));
			}
			await releaseHeldBack(network, storage, ledger, waiting);
			const { restore } = failingRetries(storage, [added.staple, killed.staple]);
			expect(await ledger.gc()).toBe(false);
			expect(storage._Testing(TESTING_KEY).retryRecords().failed).toHaveLength(2);
			restore();

			expect(blocksHashesOf(await ledger.add(added.staple))).toEqual(blocksHashesOf([added.staple]));
			const killedKey = killed.staple.blocksHash.toString();
			expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [killedKey], askedToRunAgain: [] });
			// Due again since the add, its retry meets a failure the transaction is to run again for.
			const restoreConflict = afterPersisting(storage, [killed.staple], function(blocksHash): void {
				throw(createLedgerError('LEDGER_TRANSACTION_ABORTED', `injected conflict after persisting ${blocksHash}`, { retry: true }));
			});
			expect(await ledger.gc()).toBe(true);
			expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [killedKey], askedToRunAgain: [killedKey] });
			restoreConflict();
			const killer = network.users.findIndex(function(user): boolean {
				return(user.comparePublicKey(killed.first.account));
			});
			await ledger.add(await confirmedStaple([await sendFrom(network, killer, killed.first.hash, 9n)], network.representatives));
			expect(await ledger.gc()).toBe(false);
			expect(await deferredWaitingOn(storage, killed.first.hash)).toEqual([]);
			expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [], askedToRunAgain: [] });
		});

		test('a retry that fails with an error that asks for the transaction to run again is warned of, and nothing of it is kept once its staple applies', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0, log });
			await ledger.add(network.genesis);
			const [waiting] = await deferredSeconds(network, ledger, 1);
			if (waiting === undefined) {
				throw(new Error('a waiting staple expected'));
			}
			await releaseHeldBack(network, storage, ledger, [waiting]);
			// The zero window warns of the replay it leaves.
			log.warnings.splice(0);
			const key = waiting.staple.blocksHash.toString();
			const restore = afterPersisting(storage, [waiting.staple], function(blocksHash): void {
				throw(createLedgerError('LEDGER_TRANSACTION_ABORTED', `injected conflict after persisting ${blocksHash}`, { retry: true }));
			});

			expect(await ledger.gc()).toBe(true);
			const warnings = log.warningsMentioning(waiting.staple);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(`ledger retrying deferred staple ${key} met a failure the transaction is to run again for; it stays deferred, the gc ends here, and the next gc retries it`);
			expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [], askedToRunAgain: [key] });
			restore();
			expect(await ledger.gc()).toBe(false);
			expect(await appliedOf(ledger, [waiting])).toBe(1);
			expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [], askedToRunAgain: [] });
		});

		test.each([2, 4])('%i released staples whose slow retries fail, ahead of an applicable one, hold it back one gc each at most, and gc ends once each was retried after the last staple applied', async function(failing) {
			const { network, startNode } = await startNetwork(Array.from({ length: failing + 1 }, function(): bigint {
				return(100n);
			}));
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const firsts = await Promise.all(network.users.map(function(_user, index) {
				return(sendFromGenesis(network, index, 5n));
			}));
			const seconds = sortedByHash(await Promise.all(firsts.map(async function(first, user) {
				return(await confirmedStaple([await sendFrom(network, user, first.hash, 7n)], network.representatives));
			})));
			const applying = requireAt(seconds, failing);
			for (const staple of seconds) {
				expect(await node.ledger.add(staple)).toEqual([]);
			}
			for (const first of firsts) {
				await node.ledger.add(await confirmedStaple([first], network.representatives));
			}
			afterPersisting(storage, seconds.slice(0, failing), function(blocksHash): void {
				advanceClock(61_000);
				throw(new Error(`injected slow failure after persisting ${blocksHash}`));
			});

			const reported: boolean[] = [];
			let appliedIn: number | undefined;
			for (let call = 1; call <= 3 * failing + 3 && reported.at(-1) !== false; call++) {
				reported.push(await node.ledger.gc(2000));
				if (appliedIn === undefined && await node.ledger.getBlock(requireAt(applying.blocks, 0).hash, 'main') !== null) {
					appliedIn = call;
				}
			}

			// The applicable staple is listed after the failing ones, so it is reached only once each has failed once.
			expect(appliedIn).toBe(failing + 1);
			expect(reported.at(-1)).toBe(false);
		});

		test('a gc retry that fails after its write leaves nothing behind and stays deferred', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			// A zero window leaves every waiter in the heap, as an exhausted window would.
			const { node, storage } = await startNode(0, { heapProcessWindowMs: 0 });
			const first = await sendFromGenesis(network, 0, 5n);
			const second = await sendFrom(network, 0, first.hash, 7n);
			const firstStaple = await confirmedStaple([first], network.representatives);
			const secondStaple = await confirmedStaple([second], network.representatives);
			expect(await node.ledger.add(secondStaple)).toEqual([]);
			expect(blocksHashesOf(await node.ledger.add(firstStaple))).toEqual(blocksHashesOf([firstStaple]));
			failAfterPersisting(storage, secondStaple);

			expect(await node.ledger.gc()).toBe(false);

			expect(await node.ledger.getBlock(second.hash, 'main')).toBeNull();
			expect(hashOf(await node.ledger.getHeadBlock(user, 'main'))).toBe(hashOf(first));
			expect(await node.ledger.getBalance(user, network.baseToken)).toBe(395n);
			expect(await deferredWaitingOn(storage, first.hash)).toEqual(blocksHashesOf([secondStaple]));
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, firstStaple]));
		});

		test('gc counts a deferred chain its retry releases in the checksum', async function() {
			const { network, startNode } = await startNetwork();
			const { node } = await startNode(0);
			const { entity, after, triggerStaple, grantStaple, afterStaple, heldStaple } = await grantReleasedByCertificate(network, node.ledger);
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, triggerStaple, heldStaple]));

			// One retry applies the grant, and the default window replays the send waiting on it.
			expect(await node.ledger.gc()).toBe(false);

			expect(hashOf(await node.ledger.getHeadBlock(entity, 'main'))).toBe(hashOf(after));
			expect(await node.ledger.getBalance(entity, network.baseToken)).toBe(397n);
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, triggerStaple, heldStaple, grantStaple, afterStaple]));
		});

		test('a gc retry replays what its staple releases in the same batch', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { log });
			await ledger.add(network.genesis);
			const { entity, after } = await grantReleasedByCertificate(network, ledger);

			expect(await writeStorage(storage, function(transaction) {
				return(storage._Testing(TESTING_KEY).gcBatch(transaction, 1));
			})).toBe(false);

			expect(hashOf(await ledger.getHeadBlock(entity, 'main'))).toBe(hashOf(after));
			expect(log.warnings).toEqual([]);
		});

		test('a gc retry replays what it releases until the default window is spent, and a later batch applies the rest', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { log });
			await ledger.add(network.genesis);
			const { entity, after, grantStaple, afterStaple } = await grantReleasedByCertificate(network, ledger);
			slowPersisting(storage, [grantStaple], DEFAULT_REPLAY_WINDOW_MILLISECONDS);

			expect(await ledger.gc()).toBe(false);

			expect(log.warningsMentioning(afterStaple)).toHaveLength(1);
			expect(hashOf(await ledger.getHeadBlock(entity, 'main'))).toBe(hashOf(after));
			expect(log.errorsMentioning(afterStaple)).toEqual([]);
		});

		test('a gc batch retries a failing staple once, and logs each failure', async function() {
			const log = new RecordingLog();
			const fixture = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0, log });
			const { storage } = fixture;
			const failing = await releasedButFailing(fixture);

			expect(await writeStorage(storage, async function(transaction) {
				const hooks = storage._Testing(TESTING_KEY);
				return([await hooks.gcBatch(transaction, 1), await hooks.gcBatch(transaction, 1)]);
			})).toEqual([false, false]);

			expect(log.errorsMentioning(failing).map(function(line): string {
				return(line.slice(0, line.indexOf('it stays deferred')));
			})).toEqual([`ledger retrying deferred staple ${failing.blocksHash.toString()} failed; `]);
			expect(await deferredWaitingOn(storage, requireAt(failing.blocks, 0).previous)).toEqual(blocksHashesOf([failing]));
		});

		test('a failing gc retry needs no log to stay deferred', async function() {
			const fixture = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			const failing = await releasedButFailing(fixture);

			expect(await fixture.ledger.gc()).toBe(false);

			expect(await deferredWaitingOn(fixture.storage, requireAt(failing.blocks, 0).previous)).toEqual(blocksHashesOf([failing]));
		});

		test('a gc retry passes over a staple only part of whose awaited blocks have arrived', async function() {
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			await ledger.add(network.genesis);
			const [firstMissing, secondMissing, thirdMissing] = await Promise.all([0, 1, 2].map(function(user) {
				return(sendFromGenesis(network, user, 1n));
			}));
			if (firstMissing === undefined || secondMissing === undefined || thirdMissing === undefined) {
				throw(new Error('three blocks expected'));
			}
			const partial = await confirmedStaple([await sendFrom(network, 0, firstMissing.hash, 2n), await sendFrom(network, 1, secondMissing.hash, 2n)], network.representatives);
			const released = await sendFrom(network, 2, thirdMissing.hash, 2n);
			const releasedStaple = await confirmedStaple([released], network.representatives);
			for (const staple of [partial, releasedStaple]) {
				expect(await ledger.add(staple)).toEqual([]);
			}
			for (const block of [firstMissing, thirdMissing]) {
				await ledger.add(await confirmedStaple([block], network.representatives));
			}

			expect(await writeStorage(storage, function(transaction) {
				return(storage._Testing(TESTING_KEY).gcBatch(transaction, 1));
			})).toBe(false);

			expect(hashOf(await ledger.getHeadBlock(requireAt(network.users, 2), 'main'))).toBe(hashOf(released));
			expect(await deferredWaitingOn(storage, secondMissing.hash)).toEqual(blocksHashesOf([partial]));
		});

		test('gc drops a staple that a retry in the same batch kills, though only one of its blocks competes', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0, log });
			await ledger.add(network.genesis);
			const trigger = await sendFromGenesis(network, 0, 1n);
			// Each fork's second block extends a chain nothing else touches.
			const forks = await Promise.all([1, 2].map(async function(user) {
				return(await confirmedStaple([await sendFrom(network, 0, trigger.hash, BigInt(user) + 4n), await sendFromGenesis(network, user, 1n)], network.representatives));
			}));
			for (const fork of forks) {
				expect(await ledger.add(fork)).toEqual([]);
			}
			await ledger.add(await confirmedStaple([trigger], network.representatives));

			expect(await ledger.gc()).toBe(false);

			const dropped = [];
			for (const fork of forks) {
				if (await ledger.getBlock(requireAt(fork.blocks, 0).hash, 'main') === null) {
					dropped.push(fork);
				}
			}
			expect(dropped).toHaveLength(1);
			expect(dropped.map(function(fork): string[] {
				return(log.errorsMentioning(fork));
			})).toEqual([[`ledger network integrity alarm: dropped deferred staple ${dropped[0]?.blocksHash.toString() ?? ''}, which conflicts with confirmed history and can never apply`]]);
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual([]);
		});

		test('a gc batch drops at most its limit of dead staples, and says more remain', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0, log });
			await ledger.add(network.genesis);
			await ledger.add(await confirmedStaple([await sendFromGenesis(network, 0, 5n)], network.representatives));
			// Each competes with the confirmed send, and waits on a block this node lacks.
			const dead = await Promise.all([1, 2].map(async function(user) {
				const missing = await sendFromGenesis(network, user, 1n);
				return(await confirmedStaple([await sendFromGenesis(network, 0, BigInt(user) + 6n), await sendFrom(network, user, missing.hash, 2n)], network.representatives));
			}));
			for (const staple of dead) {
				expect(await ledger.add(staple)).toEqual([]);
			}
			const reported = function(): number {
				return(dead.filter(function(staple): boolean {
					return(log.errorsMentioning(staple).length > 0);
				}).length);
			};

			expect(await writeStorage(storage, async function(transaction) {
				const hooks = storage._Testing(TESTING_KEY);
				const first = await hooks.gcBatch(transaction, 1);
				const reportedByFirst = reported();
				return([first, reportedByFirst, await hooks.gcBatch(transaction, 1), reported()]);
			})).toEqual([true, 1, false, 2]);
		});

		test('a gc batch collects at most its limit of obsolete side votes', async function() {
			const { network, storage, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const votedAt = new Date();
			const expiring = [await ledger.vote([await sendFromGenesis(network, 1, 1n)]), await ledger.vote([await sendFromGenesis(network, 2, 1n)])];
			advancePastExpiry(requireAt(expiring, 1));
			const batchOfOne = function(): Promise<boolean> {
				return(writeStorage(storage, function(transaction) {
					return(storage._Testing(TESTING_KEY).gcBatch(transaction, 1));
				}));
			};
			const storedAtVote = function(): Promise<number> {
				return(readStorageAt(storage, votedAt, async function(transaction) {
					let stored = 0;
					for (const vote of expiring) {
						if (await storage.getVotes(transaction, requireAt(vote.blocks, 0), 'side') !== null) {
							stored++;
						}
					}
					return(stored);
				}));
			};

			expect(await batchOfOne()).toBe(true);
			expect(await storedAtVote()).toBe(1);
			expect(await batchOfOne()).toBe(false);
			expect(await storedAtVote()).toBe(0);
		});

		test('gc collects our vote on a staple once the previous of any one of its blocks has a confirmed successor', async function() {
			const { network, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const contested = await sendFromGenesis(network, 0, 5n);
			const uncontested = await sendFromGenesis(network, 1, 5n);
			await ledger.vote([contested, uncontested]);
			await ledger.add(await confirmedStaple([await sendFromGenesis(network, 0, 7n)], network.representatives));

			expect(await ledger.gc()).toBe(false);

			expect(await ledger.getVotes(uncontested.hash, 'side')).toBeNull();
			expect(await ledger.getBlock(uncontested.hash, 'side')).toBeNull();
		});

		test('gc drops deferred staples that can never apply and reports each once', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0, log });
			await ledger.add(network.genesis);
			// Two forks wait on one trigger; once one of them applies, the other never can.
			const trigger = await sendFromGenesis(network, 0, 1n);
			const forks = await Promise.all([5n, 7n].map(async function(amount) {
				return(await confirmedStaple([await sendFrom(network, 0, trigger.hash, amount)], network.representatives));
			}));
			for (const fork of forks) {
				expect(await ledger.add(fork)).toEqual([]);
			}
			// This staple waits on a missing block, and one of its blocks is then confirmed in another staple.
			const shared = await sendFromGenesis(network, 1, 3n);
			const missing = await sendFromGenesis(network, 2, 1n);
			const overlapping = await confirmedStaple([shared, await sendFrom(network, 2, missing.hash, 2n)], network.representatives);
			expect(await ledger.add(overlapping)).toEqual([]);
			await ledger.add(await confirmedStaple([shared], network.representatives));
			await ledger.add(await confirmedStaple([trigger], network.representatives));

			expect(await ledger.gc()).toBe(false);
			expect(await ledger.gc()).toBe(false);

			const applied: VoteStaple[] = [];
			const dropped: VoteStaple[] = [];
			for (const fork of forks) {
				if (await ledger.getBlock(requireAt(fork.blocks, 0).hash, 'main') === null) {
					dropped.push(fork);
				} else {
					applied.push(fork);
				}
			}
			expect([applied.length, dropped.length]).toEqual([1, 1]);
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual([]);
			expect(await deferredWaitingOn(storage, missing.hash)).toEqual([]);
			expect([...dropped, overlapping].map(function(staple): number {
				return(log.errorsMentioning(staple).length);
			})).toEqual([1, 1]);
			expect(applied.flatMap(function(staple): string[] {
				return(log.errorsMentioning(staple));
			})).toEqual([]);
			// The missing block now releases nothing.
			const missingStaple = await confirmedStaple([missing], network.representatives);
			expect(blocksHashesOf(await ledger.add(missingStaple))).toEqual(blocksHashesOf([missingStaple]));
		});

		test('gc drops a staple deferred after the previous of one of its blocks was confirmed', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0, log });
			await ledger.add(network.genesis);
			await ledger.add(await confirmedStaple([await sendFromGenesis(network, 0, 5n)], network.representatives));
			// Its competitor arrives with a block whose previous is missing, so it is deferred, though it can never apply.
			const missing = await sendFromGenesis(network, 1, 1n);
			const late = await confirmedStaple([await sendFromGenesis(network, 0, 7n), await sendFrom(network, 1, missing.hash, 2n)], network.representatives);
			expect(await ledger.add(late)).toEqual([]);
			expect(await deferredWaitingOn(storage, missing.hash)).toEqual(blocksHashesOf([late]));

			expect(await ledger.gc()).toBe(false);

			expect(await deferredWaitingOn(storage, missing.hash)).toEqual([]);
			expect(log.errorsMentioning(late)).toHaveLength(1);
		});

		test('gc reads a deferred staple back as of its votes, though the clock has since gone back past them', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0, log });
			await ledger.add(network.genesis);
			await ledger.add(await confirmedStaple([await sendFromGenesis(network, 0, 5n)], network.representatives));
			const missing = await sendFromGenesis(network, 1, 1n);
			const late = await confirmedStaple([await sendFromGenesis(network, 0, 7n), await sendFrom(network, 1, missing.hash, 2n)], network.representatives);
			expect(await ledger.add(late)).toEqual([]);
			// Further back than the minute by which upstream takes a vote to be from the future [Keeta TS] index.js:81525-81527, 81805.
			advanceClock(-10 * 60 * 1000);

			expect(await ledger.gc()).toBe(false);

			expect(await deferredWaitingOn(storage, missing.hash)).toEqual([]);
			expect(log.errorsMentioning(late)).toHaveLength(1);
		});

		test('a deferred staple that is not dead survives gc and a partial release, then applies', async function() {
			const log = new RecordingLog();
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { log });
			await ledger.add(network.genesis);
			// Our pending vote makes a block of the staple a side successor of its previous, which is not a confirmed one.
			const voted = await sendFromGenesis(network, 0, 5n);
			await ledger.vote([voted]);
			const missing = await sendFromGenesis(network, 1, 1n);
			const released = await sendFromGenesis(network, 2, 1n);
			const blocks = [voted, await sendFrom(network, 1, missing.hash, 2n), await sendFrom(network, 2, released.hash, 3n)];
			const waiting = await confirmedStaple(blocks, network.representatives);
			expect(await ledger.add(waiting)).toEqual([]);
			// One of the two awaited blocks arrives, which releases the staple only in part.
			const releasedStaple = await confirmedStaple([released], network.representatives);
			expect(blocksHashesOf(await ledger.add(releasedStaple))).toEqual(blocksHashesOf([releasedStaple]));

			expect(await ledger.gc()).toBe(false);

			expect(await deferredWaitingOn(storage, missing.hash)).toEqual(blocksHashesOf([waiting]));
			const missingStaple = await confirmedStaple([missing], network.representatives);
			expect(blocksHashesOf(await ledger.add(missingStaple))).toEqual(blocksHashesOf([missingStaple, waiting]));
			expect(await Promise.all(network.users.map(async function(user) {
				return(hashOf(await ledger.getHeadBlock(user, 'main')));
			}))).toEqual(blocks.map(hashOf));
			expect(log.errorsMentioning(waiting)).toEqual([]);
		});

		test('gc reports whether more work remains', async function() {
			const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			// Two forks wait on one trigger; once it applies, only one of them can.
			const trigger = await sendFromGenesis(network, 0, 1n);
			const forks = await Promise.all([5n, 7n].map(async function(amount) {
				return({ amount, staple: await confirmedStaple([await sendFrom(network, 0, trigger.hash, amount)], network.representatives) });
			}));
			for (const { staple } of forks) {
				expect(await ledger.add(staple)).toEqual([]);
			}
			expect(blocksHashesOf(await ledger.add(await confirmedStaple([trigger], network.representatives)))).toHaveLength(1);
			const batchesOfOne = function(count: number): Promise<boolean[]> {
				return(writeStorage(storage, async function(transaction) {
					const progress: boolean[] = [];
					for (let batch = 0; batch < count; batch++) {
						progress.push(await storage._Testing(TESTING_KEY).gcBatch(transaction, 1));
					}
					return(progress);
				}));
			};

			// The second fork is still to be retried after the first batch; the second batch drops it, because it can never apply.
			expect(await batchesOfOne(3)).toEqual([true, false, false]);
			const balance = await ledger.getBalance(user, network.baseToken);
			const applied = forks.find(function({ amount }): boolean {
				return(balance === 400n - 1n - amount);
			});
			const loser = forks.find(function(fork): boolean {
				return(fork !== applied);
			});
			if (applied === undefined || loser === undefined) {
				throw(new Error('exactly one fork should have applied'));
			}
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual([]);

			const votedAt = new Date();
			const expiring = [await ledger.vote([await sendFromGenesis(network, 1, 1n)]), await ledger.vote([await sendFromGenesis(network, 2, 1n)])];
			advancePastExpiry(requireAt(expiring, 1));
			expect(await batchesOfOne(3)).toEqual([true, false, false]);
			expect(await readStorageAt(storage, votedAt, async function(transaction) {
				return(await Promise.all(expiring.map(async function(vote) {
					return(identitiesOf(await storage.getVotes(transaction, requireAt(vote.blocks, 0), 'side')));
				})));
			})).toEqual([null, null]);

			expect(await ledger.gc()).toBe(false);
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual([]);
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

/* Two instances on one store stand for two processes of one representative, each with its own Ledger. */
function defineCrossProcessCases(startNetwork: FixtureFactory, sharing: Extract<StoreSharing, { kind: 'shared' }>): void {
	test('a failed staple that another process has since applied is forgotten once due, and takes no place from a failure that is', async function() {
		const { network, storage, ledger } = await startNetwork(DEFAULT_WEIGHTS, { heapProcessWindowMs: 0 });
		const other = network.createLedger(await sharing.openSibling(storage), requireAt(network.representatives, 0));
		await ledger.add(network.genesis);
		const waiting = await deferredSeconds(network, ledger, 2);
		const [appliedElsewhere, failing] = waiting;
		if (appliedElsewhere === undefined || failing === undefined) {
			throw(new Error('two waiting staples expected'));
		}
		await releaseHeldBack(network, storage, ledger, waiting);
		const both = failingRetries(storage, [appliedElsewhere.staple, failing.staple]);
		expect(await ledger.gc()).toBe(false);
		expect(both.retried).toHaveLength(2);
		both.restore();
		expect(blocksHashesOf(await other.add(appliedElsewhere.staple))).toEqual(blocksHashesOf([appliedElsewhere.staple]));
		// A staple this process applies makes both failures due, the one applied elsewhere first.
		await ledger.add(await confirmedStaple([await sendFromGenesis(network, 2, 5n)], network.representatives));
		const { retried } = failingRetries(storage, [failing.staple]);

		expect(await gcBatchOf(storage, 1)).toBe(true);
		expect(retried).toEqual([]);
		expect(await gcBatchOf(storage, 1)).toBe(false);
		expect(retried).toEqual([failing.staple.blocksHash.toString()]);
		expect(storage._Testing(TESTING_KEY).retryRecords()).toEqual({ failed: [failing.staple.blocksHash.toString()], askedToRunAgain: [] });
	});
}
