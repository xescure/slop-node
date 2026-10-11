import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Vote, VoteBlockHash, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../../upstream/internals.js';
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
import type { NetworkFixture } from './support.js';
import type { DriverUnderTest } from './types.js';

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

function sendFrom(network: TestNetwork, user: number, previous: BlockHash, amount: bigint, idempotent?: string): Promise<Block> {
	const from = requireAt(network.users, user);
	const to = requireAt(network.users, (user + 1) % network.users.length);
	return(sendBlock({ from, previous, to, amount, token: network.baseToken, network: network.network, idempotent }));
}

function sendFromGenesis(network: TestNetwork, user: number, amount: bigint, idempotent?: string): Promise<Block> {
	return(sendFrom(network, user, headOf(network.genesis, requireAt(network.users, user)), amount, idempotent));
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

			// Upstream's loop reads the time before its first batch, so a limit spent by then would run none and report nothing left [Keeta TS] index.js:67852-67861.
			expect(await node.ledger.gc(-1)).toBe(false);

			expect(hashOf(await node.ledger.getHeadBlock(user, 'main'))).toBe(hashOf(second));
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
			// Further back than the minute by which upstream takes a vote to be from the future [Keeta TS] index.js:80373-80375, 80653.
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
	});
}
