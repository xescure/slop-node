import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger, LedgerSelector } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { Vote, VoteBlockHash, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { advanceClock } from '../../../testing/network.js';
import type { TestLedgerOptions, TestNetwork } from '../../../testing/network.js';
import { confirmedStaple, feeBlock, sendBlock, setRepresentativeBlock } from '../../../testing/blocks.js';
import type { LedgerStorageDriverBase } from '../base.js';
import { DEFAULT_WEIGHTS, advancePastExpiry, advanceToExpiryEdge, blockHashesOf, blocksHashesOf, chainLengthOf, hashOf, headOf, identitiesOf, readStorage, requireAt, useFixtures } from './support.js';
import type { FixtureFactory } from './support.js';
import type { DriverUnderTest, SuiteCase } from './types.js';

const lib = KeetaNet.lib;

const NEWCOMER_SEED = '2e8c4a6f0b1d3957e2c4a6b8d0f1e3c5a7b9d1f3e5c7a9b0d2f4e6a8c0b2d4f6';

const FEE_AMOUNT = 1n;

// Lands in upstream's settlement-time bucket for 901 to 1000 ms.
const SETTLEMENT_MILLISECONDS = 1000;

type SelectedVotes = {
	readonly main: string[] | null;
	readonly side: string[] | null;
	readonly both: string[] | null;
};

/** Our ledger's and one peer's votes on one send and the fee block that pays both. */
type PermanentRound = {
	readonly send: Block;
	readonly fee: Block;
	readonly ourTemporary: Vote;
	readonly ourPermanent: Vote;
	readonly temporary: Vote[];
	readonly staple: VoteStaple;
};

// Every representative charges the same fee, paid to itself.
const FLAT_FEE: TestLedgerOptions = { fee: { kind: 'flat', amount: FEE_AMOUNT } };

function newcomerAccount(): Account {
	return(lib.Account.fromSeed(NEWCOMER_SEED, 0));
}

function sendFromFirstUser(network: TestNetwork, previous: BlockHash, amount: bigint, idempotent?: string): Promise<Block> {
	return(sendBlock({ from: requireAt(network.users, 0), previous, to: requireAt(network.users, 1), amount, token: network.baseToken, network: network.network, idempotent }));
}

/*
 * Both representatives vote temporarily on a send, then permanently on the
 * send plus the fee block that pays each of them.
 */
async function voteThroughPermanent(network: TestNetwork, ours: Ledger, peer: Ledger): Promise<PermanentRound> {
	const user = requireAt(network.users, 0);
	const send = await sendFromFirstUser(network, headOf(network.genesis, user), 5n);
	const ourTemporary = await ours.vote([send]);
	const temporary = [ourTemporary, await peer.vote([send])];
	const fee = await feeBlock({
		from: user,
		previous: send.hash,
		network: network.network,
		payments: network.representatives.slice(0, 2).map(function(to) {
			return({ to, token: network.baseToken, amount: FEE_AMOUNT });
		})
	});
	const ourPermanent = await ours.vote([send, fee], temporary);
	const permanent = [ourPermanent, await peer.vote([send, fee], temporary)];
	return({ send, fee, ourTemporary, ourPermanent, temporary, staple: lib.Vote.Staple.fromVotesAndBlocks(permanent, [send, fee]) });
}

// Ledger.getVotes accepts only main or side, so every selector is read from storage.
function votesOn(storage: LedgerStorageDriverBase, hash: BlockHash): Promise<SelectedVotes> {
	return(readStorage(storage, async function(transaction) {
		return({
			main: identitiesOf(await storage.getVotes(transaction, hash, 'main')),
			side: identitiesOf(await storage.getVotes(transaction, hash, 'side')),
			both: identitiesOf(await storage.getVotes(transaction, hash, 'both'))
		});
	}));
}

async function stapleOf(ledger: Ledger, blocksHash: VoteBlockHash, from: LedgerSelector): Promise<{ readonly blocks: string[]; readonly votes: string[] | null } | null> {
	const staple = (await ledger.getVoteStaples([blocksHash], from)).get(blocksHash);
	if (staple === undefined) {
		throw(new Error(`no entry for staple ${blocksHash.toString()}`));
	}
	if (staple === null) {
		return(null);
	}
	return({ blocks: blockHashesOf([staple]), votes: identitiesOf(staple.votes) });
}

async function successorVotes(ledger: Ledger, previous: readonly BlockHash[], from: LedgerSelector, issuer: Account): Promise<{ [hash: string]: string[] | null }> {
	const found = await ledger.getVotesFromMultiplePrevious([...previous], from, issuer);
	return(Object.fromEntries(previous.map(function(hash) {
		return([hash.toString(), identitiesOf(found[hash.toString()])]);
	})));
}

/** Kept as data, so that the suite's meta-test can also run them against a deliberately broken driver. */
export const voteLifecycleCases: readonly SuiteCase[] = [
	{
		name: 'a temporary vote is stored on the side ledger and is not a head',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const representative = requireAt(network.representatives, 0);
			const newcomer = newcomerAccount();
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendFromFirstUser(network, genesisHead, 5n);
			const opening = await setRepresentativeBlock({ account: newcomer, representative, previous: null, network: network.network });

			const sendVote = await ledger.vote([send]);
			const openingVote = await ledger.vote([opening]);

			expect(sendVote.$permanent).toBe(false);
			expect(openingVote.$permanent).toBe(false);
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual([sendVote.$uid]);
			expect(await ledger.getVotes(send.hash, 'main')).toBeNull();
			expect(hashOf(await ledger.getBlock(send.hash, 'side'))).toBe(hashOf(send));
			expect(hashOf(await ledger.getBlock(send.hash, 'both'))).toBe(hashOf(send));
			expect(await ledger.getBlock(send.hash, 'main')).toBeNull();
			expect(hashOf(await ledger.getBlockFromPrevious(genesisHead, 'side'))).toBe(hashOf(send));
			expect(hashOf(await ledger.getBlockFromPrevious(opening.previous, 'side'))).toBe(hashOf(opening));
			expect(hashOf(await ledger.getBlockFromPrevious(genesisHead, 'both'))).toBe(hashOf(send));
			expect(await ledger.getBlockFromPrevious(genesisHead, 'main')).toBeNull();
			expect(await successorVotes(ledger, [genesisHead, opening.previous], 'side', representative)).toEqual({
				[genesisHead.toString()]: [sendVote.$uid],
				[opening.previous.toString()]: [openingVote.$uid]
			});
			expect(await successorVotes(ledger, [genesisHead], 'side', requireAt(network.representatives, 1))).toEqual({ [genesisHead.toString()]: null });
			expect(await stapleOf(ledger, sendVote.blocksHash, 'side')).toEqual({ blocks: [hashOf(send)], votes: [sendVote.$uid] });
			expect(await stapleOf(ledger, sendVote.blocksHash, 'main')).toBeNull();

			// A block we only voted on never becomes a head, under any selector.
			expect(hashOf(await ledger.getHeadBlock(user, 'both'))).toBe(hashOf(genesisHead));
			expect(hashOf(await ledger.getHeadBlock(user, 'main'))).toBe(hashOf(genesisHead));
			expect(await ledger.getHeadBlock(newcomer, 'both')).toBeNull();
			expect(await ledger.getHeadBlocks([user, newcomer], 'side')).toEqual({
				[user.publicKeyString.get()]: null,
				[newcomer.publicKeyString.get()]: null
			});
			const heights = await ledger.getAccountsBlockHeightInfo([{ account: user }, { account: newcomer }]);
			expect(heights[user.publicKeyString.get()]).toEqual({ blockHash: genesisHead, height: chainLengthOf(network.genesis, user) - 1n });
			expect(heights[newcomer.publicKeyString.get()]).toBeNull();
			expect(await ledger.getBalance(user, network.baseToken)).toBe(400n);
			expect(await ledger.getAccountRep(newcomer)).toBeNull();
		}
	},
	{
		name: 'a permanent vote with a fee block joins the temporary vote',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, ledger, startPeer } = await startNetwork(DEFAULT_WEIGHTS, FLAT_FEE);
			await ledger.add(network.genesis);
			const peer = await startPeer(1, FLAT_FEE);
			const user = requireAt(network.users, 0);
			const genesisHead = headOf(network.genesis, user);

			const { send, fee, ourTemporary, ourPermanent } = await voteThroughPermanent(network, ledger, peer);

			expect(ourPermanent.$permanent).toBe(true);
			expect(ourPermanent.serial > ourTemporary.serial).toBe(true);
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual(identitiesOf([ourTemporary, ourPermanent]));
			expect(identitiesOf(await ledger.getVotes(fee.hash, 'side'))).toEqual([ourPermanent.$uid]);
			expect(hashOf(await ledger.getBlock(fee.hash, 'side'))).toBe(hashOf(fee));
			expect(await stapleOf(ledger, ourTemporary.blocksHash, 'side')).toEqual({ blocks: [hashOf(send)], votes: [ourTemporary.$uid] });
			expect(await stapleOf(ledger, ourPermanent.blocksHash, 'side')).toEqual({ blocks: [hashOf(send), hashOf(fee)], votes: [ourPermanent.$uid] });
			expect(await successorVotes(ledger, [genesisHead, send.hash], 'side', requireAt(network.representatives, 0))).toEqual({
				[genesisHead.toString()]: identitiesOf([ourTemporary, ourPermanent]),
				[send.hash.toString()]: [ourPermanent.$uid]
			});
			expect(hashOf(await ledger.getHeadBlock(user, 'both'))).toBe(hashOf(genesisHead));
			expect(await ledger.getBlock(send.hash, 'main')).toBeNull();
			expect(await ledger.getBalance(user, network.baseToken)).toBe(400n);

			// Our temporary vote expires, but the permanent one never does.
			advancePastExpiry(ourTemporary);
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual([ourPermanent.$uid]);
			const competitor = await sendFromFirstUser(network, genesisHead, 9n);
			await expect(ledger.vote([competitor])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS', shouldRetry: false });
		}
	},
	{
		name: 'without a fee block the permanent vote shares its staple with the temporary vote',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, ledger, startPeer } = await startNetwork();
			await ledger.add(network.genesis);
			const peer = await startPeer(1);
			const user = requireAt(network.users, 0);
			const send = await sendFromFirstUser(network, headOf(network.genesis, user), 5n);
			const temporary = [await ledger.vote([send]), await peer.vote([send])];
			const ourTemporary = requireAt(temporary, 0);

			const ourPermanent = await ledger.vote([send], temporary);

			expect(ourPermanent.blocksHash.toString()).toBe(ourTemporary.blocksHash.toString());
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual(identitiesOf([ourTemporary, ourPermanent]));
			// A staple holds votes of one permanence, and the permanent one wins.
			expect(await stapleOf(ledger, ourPermanent.blocksHash, 'side')).toEqual({ blocks: [hashOf(send)], votes: [ourPermanent.$uid] });
		}
	},
	{
		name: 'publishing promotes the staple and deletes side copies of promoted rows',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, startNode, startPeer } = await startNetwork();
			const user = requireAt(network.users, 0);
			const genesisHead = headOf(network.genesis, user);
			const { node } = await startNode(0, FLAT_FEE);
			const ours = node.ledger;
			const peer = await startPeer(1, FLAT_FEE);
			const { send, fee, ourTemporary, ourPermanent, staple } = await voteThroughPermanent(network, ours, peer);
			advanceClock(SETTLEMENT_MILLISECONDS);

			expect(blocksHashesOf(await ours.add(staple))).toEqual(blocksHashesOf([staple]));

			expect(hashOf(await ours.getBlock(send.hash, 'main'))).toBe(hashOf(send));
			expect(hashOf(await ours.getBlock(fee.hash, 'main'))).toBe(hashOf(fee));
			expect(hashOf(await ours.getHeadBlock(user, 'both'))).toBe(hashOf(fee));
			expect(identitiesOf(await ours.getVotes(send.hash, 'main'))).toEqual(identitiesOf(staple.votes));
			expect(await ours.getBalance(user, network.baseToken)).toBe(393n);
			expect(await ours.getBalance(requireAt(network.representatives, 0), network.baseToken)).toBe(FEE_AMOUNT);
			expect(await ours.getBalance(requireAt(network.representatives, 1), network.baseToken)).toBe(FEE_AMOUNT);

			// The blocks and our permanent vote now live on main only.
			expect(await ours.getBlock(send.hash, 'side')).toBeNull();
			expect(await ours.getBlock(fee.hash, 'side')).toBeNull();
			expect(await ours.getBlockFromPrevious(genesisHead, 'side')).toBeNull();
			expect(await ours.getBlockFromPrevious(send.hash, 'side')).toBeNull();
			expect(await ours.getVotes(fee.hash, 'side')).toBeNull();
			expect(await stapleOf(ours, ourPermanent.blocksHash, 'side')).toBeNull();
			expect(await stapleOf(ours, ourPermanent.blocksHash, 'both')).toEqual({ blocks: [hashOf(send), hashOf(fee)], votes: identitiesOf(staple.votes) });
			expect(hashOf(await ours.getBlockFromPrevious(genesisHead, 'both'))).toBe(hashOf(send));
			// Our temporary vote is not part of the staple and stays until it expires.
			expect(identitiesOf(await ours.getVotes(send.hash, 'side'))).toEqual([ourTemporary.$uid]);

			// Upstream measured settlement from our temporary vote while applying the staple.
			expect(await node.stats.get('ledger', 'settlementTime@1000ms')).toBe(1);

			const next = await sendFromFirstUser(network, fee.hash, 1n);
			expect((await ours.vote([next])).$permanent).toBe(false);
		}
	},
	{
		name: 'a competing vote is refused while our temporary vote is live',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendFromFirstUser(network, genesisHead, 5n);
			const competitor = await sendFromFirstUser(network, genesisHead, 7n);

			const vote = await ledger.vote([send]);

			await expect(ledger.vote([competitor])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS', shouldRetry: false });
			await expect(ledger.vote([send])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS', shouldRetry: false });
			expect(await ledger.getBlock(competitor.hash, 'side')).toBeNull();
			expect(await ledger.getVotes(competitor.hash, 'side')).toBeNull();
			expect(hashOf(await ledger.getBlockFromPrevious(genesisHead, 'side'))).toBe(hashOf(send));
			expect(await successorVotes(ledger, [genesisHead], 'both', requireAt(network.representatives, 0))).toEqual({ [genesisHead.toString()]: [vote.$uid] });
		}
	},
	{
		name: 'after expiry a competing vote is allowed',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendFromFirstUser(network, genesisHead, 5n);
			const vote = await ledger.vote([send]);

			advanceToExpiryEdge(vote);
			const competitor = await sendFromFirstUser(network, genesisHead, 7n);
			await expect(ledger.vote([competitor])).rejects.toMatchObject({ code: 'LEDGER_SUCCESSOR_VOTE_EXISTS' });

			advanceClock(1);
			const competing = await ledger.vote([competitor]);

			expect(competing.$permanent).toBe(false);
			expect(await ledger.getVotes(send.hash, 'side')).toBeNull();
			expect(await ledger.getBlock(send.hash, 'side')).toBeNull();
			expect(await stapleOf(ledger, vote.blocksHash, 'side')).toBeNull();
			expect(identitiesOf(await ledger.getVotes(competitor.hash, 'side'))).toEqual([competing.$uid]);
			expect(hashOf(await ledger.getBlockFromPrevious(genesisHead, 'side'))).toBe(hashOf(competitor));
			expect(hashOf(await ledger.getBlockFromPrevious(genesisHead, 'both'))).toBe(hashOf(competitor));
			expect(await successorVotes(ledger, [genesisHead], 'both', requireAt(network.representatives, 0))).toEqual({ [genesisHead.toString()]: [competing.$uid] });
		}
	},
	{
		name: 'getVotes selectors: side returns all live side votes, both prefers main, absent gives null',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, storage, ledger, startPeer } = await startNetwork(DEFAULT_WEIGHTS, FLAT_FEE);
			await ledger.add(network.genesis);
			const peer = await startPeer(1, FLAT_FEE);
			const other = requireAt(network.users, 1);
			const absent = await sendBlock({ from: other, previous: headOf(network.genesis, other), to: requireAt(network.users, 0), amount: 1n, token: network.baseToken, network: network.network });
			const { send, ourTemporary, ourPermanent, staple } = await voteThroughPermanent(network, ledger, peer);
			const nowhere = { main: null, side: null, both: null };
			const pending = identitiesOf([ourTemporary, ourPermanent]);

			expect(await votesOn(storage, send.hash)).toEqual({ main: null, side: pending, both: pending });
			expect(await votesOn(storage, absent.hash)).toEqual(nowhere);

			await ledger.add(staple);
			const confirmed = identitiesOf(staple.votes);
			expect(await votesOn(storage, send.hash)).toEqual({ main: confirmed, side: [ourTemporary.$uid], both: confirmed });

			advancePastExpiry(ourTemporary);
			expect(await votesOn(storage, send.hash)).toEqual({ main: confirmed, side: null, both: confirmed });
			expect(await votesOn(storage, absent.hash)).toEqual(nowhere);
		}
	},
	{
		name: 'side idempotent keys are visible under both and lose to main',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const idempotent = btoa('order-1');
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const held = await sendFromFirstUser(network, genesisHead, 1n, idempotent);
			const competing = await sendFromFirstUser(network, genesisHead, 2n, idempotent);
			const holderOf = async function(from: LedgerSelector): Promise<string | null> {
				return(hashOf(await ledger.getIdempotentBlockHash(user, idempotent, from)));
			};

			const vote = await ledger.vote([held]);

			expect(await holderOf('side')).toBe(hashOf(held));
			expect(await holderOf('both')).toBe(hashOf(held));
			expect(await holderOf('main')).toBeNull();
			expect(hashOf(await ledger.getBlockFromIdempotent(user, idempotent, 'both'))).toBe(hashOf(held));
			expect(await ledger.getIdempotentBlockHash(user, idempotent, 'side', held.hash)).toBeNull();
			await expect(ledger.vote([competing])).rejects.toMatchObject({ code: 'LEDGER_IDEMPOTENT_KEY_EXISTS' });

			// The network confirms the competing block all the same.
			await ledger.add(await confirmedStaple([competing], network.representatives));
			expect(await holderOf('main')).toBe(hashOf(competing));
			expect(await holderOf('both')).toBe(hashOf(competing));
			expect(await holderOf('side')).toBe(hashOf(held));
			expect(hashOf(await ledger.getBlockFromIdempotent(user, idempotent, 'both'))).toBe(hashOf(competing));

			advancePastExpiry(vote);
			expect(await holderOf('side')).toBeNull();
			expect(await holderOf('both')).toBe(hashOf(competing));
		}
	},
	{
		name: 'quote consumes a serial and stores nothing on the side ledger',
		async run(startNetwork: FixtureFactory): Promise<void> {
			const { network, ledger } = await startNetwork(DEFAULT_WEIGHTS, FLAT_FEE);
			const user = requireAt(network.users, 0);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendFromFirstUser(network, genesisHead, 5n);

			const quote = await ledger.quote([send]);

			expect(await ledger.getVotes(send.hash, 'side')).toBeNull();
			expect(await ledger.getBlock(send.hash, 'side')).toBeNull();
			expect(await ledger.getBlockFromPrevious(genesisHead, 'side')).toBeNull();
			expect(await successorVotes(ledger, [genesisHead], 'both', requireAt(network.representatives, 0))).toEqual({ [genesisHead.toString()]: null });
			expect(await stapleOf(ledger, quote.blocksHash, 'side')).toBeNull();

			const vote = await ledger.vote([send], undefined, quote);

			expect(vote.serial > quote.serial).toBe(true);
			expect(identitiesOf(await ledger.getVotes(send.hash, 'side'))).toEqual([vote.$uid]);
		}
	}
];

export function defineVoteCases(driver: DriverUnderTest): void {
	describe('vote lifecycle', function() {
		const startNetwork = useFixtures(driver);
		for (const suiteCase of voteLifecycleCases) {
			test(suiteCase.name, function() {
				return(suiteCase.run(startNetwork));
			});
		}
	});
}
