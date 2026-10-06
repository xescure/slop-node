import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Vote, VoteBlockHash } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../../upstream/internals.js';
import { confirmedStaple, feeBlock, manageCertificateBlock, modifyPermissionsBlock, sendBlock } from '../../../testing/blocks.js';
import type { TestLedgerOptions, TestNetwork } from '../../../testing/network.js';
import type { LedgerDriverTransaction, LedgerStorageDriverBase } from '../base.js';
import {
	ChainCursor,
	DEFAULT_WEIGHTS,
	TESTING_KEY,
	advancePastExpiry,
	blocksHashesOf,
	certificateFor,
	checksumOf,
	hashOf,
	headOf,
	identitiesOf,
	ledgerChecksumOf,
	readStorage,
	readStorageAt,
	requireAt,
	useFixtures,
	writeStorage
} from './support.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

const FEE_AMOUNT = 1n;

// Every representative charges the same fee, paid to itself.
const FLAT_FEE: TestLedgerOptions = { fee: { kind: 'flat', amount: FEE_AMOUNT } };

// Our representative is outweighed: the other two confirm staples without it.
const OUTVOTED_WEIGHTS: readonly bigint[] = [100n, 400n, 500n];

const LONE_IDEMPOTENT = btoa('lone-order');

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

			expect(await ledger.gc()).toBe(false);

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
			expect(hashOf(await ledger.getBlockFromPrevious(send.hash, 'main'))).toBe(hashOf(otherFee));
		});

		test('gc retries deferred staples whose previous is now on main', async function() {
			const { network, startNode } = await startNetwork();
			const user = requireAt(network.users, 0);
			// A zero window leaves every waiter in the heap, as an exhausted window would.
			const node = await startNode(0, { heapProcessWindowMs: 0 });
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

		test('gc counts a deferred chain its retry releases in the checksum', async function() {
			const { network, startNode } = await startNetwork();
			const entity = requireAt(network.users, 0);
			const holder = requireAt(network.users, 1);
			const cursor = new ChainCursor(network.genesis);
			const node = await startNode(0);
			const certificate = await certificateFor(holder, 11);
			const trigger = cursor.append(await sendFrom(network, 0, headOf(network.genesis, entity), 1n));
			// Granting to a certificate the node lacks fails until the holder adds it (D15).
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
			expect(await node.ledger.add(afterStaple)).toEqual([]);
			expect(await node.ledger.add(grantStaple)).toEqual([]);
			// The grant's replay fails, so it stays deferred, and the send after it keeps waiting on it.
			expect(blocksHashesOf(await node.ledger.add(triggerStaple))).toEqual(blocksHashesOf([triggerStaple]));
			const heldStaple = await confirmedStaple([cursor.append(await manageCertificateBlock({ account: holder, previous: cursor.previous(holder), network: network.network, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate }))], network.representatives);
			await node.ledger.add(heldStaple);
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, triggerStaple, heldStaple]));

			// One retry applies the grant, and the default window replays the send waiting on it.
			expect(await node.ledger.gc()).toBe(false);

			expect(hashOf(await node.ledger.getHeadBlock(entity, 'main'))).toBe(hashOf(after));
			expect(await node.ledger.getBalance(entity, network.baseToken)).toBe(397n);
			expect(await ledgerChecksumOf(node)).toBe(checksumOf([network.genesis, triggerStaple, heldStaple, grantStaple, afterStaple]));
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

			// The second fork is still to be retried after the first batch; its retry fails, and that is not work that remains.
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
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual(blocksHashesOf([loser.staple]));

			const votedAt = new Date();
			const expiring = [await ledger.vote([await sendFromGenesis(network, 1, 1n)]), await ledger.vote([await sendFromGenesis(network, 2, 1n)])];
			advancePastExpiry(requireAt(expiring, 1));
			expect(await batchesOfOne(3)).toEqual([true, false, false]);
			expect(await readStorageAt(storage, votedAt, async function(transaction) {
				return(await Promise.all(expiring.map(async function(vote) {
					return(identitiesOf(await storage.getVotes(transaction, requireAt(vote.blocks, 0), 'side')));
				})));
			})).toEqual([null, null]);

			// A fresh pass retries the failing fork once more, and still finishes.
			expect(await ledger.gc()).toBe(false);
			expect(await deferredWaitingOn(storage, trigger.hash)).toEqual(blocksHashesOf([loser.staple]));
		});
	});
}
