import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockJSONOperationTOKEN_ADMIN_SUPPLY } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import { receiveBlock, sendBlock, tokenSupplyBlock } from '../../testing/blocks.js';
import { scenario } from '../record.js';
import type { CaseRecorder, Scenario } from '../record.js';
import { MAXIMUM_SUPPLY, NEGATIVE_AMOUNTS_REFUSED_FROM, chainsOf, confirmed, issueToken, send } from './support.js';
import type { PublishedToken } from './support.js';

/*
 * Whether balances and supplies stay in range: each account's balance of
 * each token may not fall below zero at any point of the request, taken in
 * block order, a RECEIVE needs what was sent to it earlier in the request,
 * and a token's supply has a maximum.
 * [Keeta TS] index.js:67133-67138, 67502-67530, 70084-70093
 */

const lib = KeetaNet.lib;

/** User 0 owns a token with the supply given, added on node 0 together with genesis. */
async function tokenWithSupply(recorder: CaseRecorder, supply: bigint): Promise<PublishedToken> {
	await recorder.addGenesis(0);
	const chains = chainsOf(recorder);
	const { token, blocks } = await issueToken(recorder, chains, recorder.user(0), { supply, defaultPermission: ['ACCESS'] });
	await recorder.add(0, await confirmed(recorder, blocks));
	return({ token, chains });
}

/** The token's owner mints or burns supply, after the token's last block. */
function adjustSupply(recorder: CaseRecorder, { token, chains }: PublishedToken, amount: bigint, method: BlockJSONOperationTOKEN_ADMIN_SUPPLY['method']): Promise<Block> {
	return(tokenSupplyBlock({ owner: recorder.user(0), token, amount, method, previous: chains.previous(token), network: recorder.network.network }));
}

/** User 1, after its genesis head, requires that user 0 sent it, earlier in the request, at least the amount given, or exactly that amount. */
function receiveFromUser0(recorder: CaseRecorder, amount: bigint, exact: boolean): Promise<Block> {
	const account = recorder.user(1);
	return(receiveBlock({ account, previous: recorder.genesisHead(account), network: recorder.network.network, from: recorder.user(0), token: recorder.network.baseToken, amount, exact }));
}

export const balanceScenarios: readonly Scenario[] = [
	scenario('B1', 'a send of one more than the balance is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { amount: 401n })]);
	}),
	scenario('B2', 'a send of exactly the balance gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { amount: 400n })]);
	}),
	scenario('B3', 'an account may spend what an earlier block of the request sends it', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { amount: 100n }), await send(recorder, 1, { amount: 350n })]);
	}),
	scenario('B4', 'the same blocks in the other order are refused: the spend comes before its funding', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 1, { amount: 350n }), await send(recorder, 0, { amount: 100n })]);
	}),
	scenario('B5', 'two blocks of one account that together spend more than its balance are refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const first = await send(recorder, 0, { amount: 300n });
		await recorder.vote(0, [first, await send(recorder, 0, { amount: 101n, previous: first.hash })]);
	}),
	scenario('B6', 'a receive of more than was sent to the account in the request is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const sent = await send(recorder, 0, { amount: 10n });
		const received = await receiveFromUser0(recorder, 11n, false);
		await recorder.vote(0, [sent, received]);
	}),
	scenario('B6b', 'an exact receive of exactly what was sent gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const sent = await send(recorder, 0, { amount: 10n });
		const received = await receiveFromUser0(recorder, 10n, true);
		await recorder.vote(0, [sent, received]);
	}),
	scenario('B6c', 'a receive counts only what was sent before it in the request', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const sent = await send(recorder, 0, { amount: 10n });
		const received = await receiveFromUser0(recorder, 10n, true);
		await recorder.vote(0, [received, sent]);
	}),
	scenario('B7', 'a send of nothing gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { amount: 0n })]);
	}),
	/*
	 * The literal row is a negative amount after the cutoff, which no block
	 * can carry: building or parsing it fails with BLOCK_AMOUNT_BELOW_ZERO
	 * [Keeta TS] index.js:67139-67148. Before the cutoff such a block exists,
	 * and the ledger refuses it with a check of its own, made before the
	 * block's age is checked.
	 * [Keeta TS] index.js:69947-69957
	 */
	scenario('B8', 'a negative amount, in a block dated before the cutoff that still admits one, is refused by the ledger\'s operation check', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { amount: -1n, date: new Date(NEGATIVE_AMOUNTS_REFUSED_FROM.getTime() - 1) })]);
	}),
	scenario('T5', 'burning more than the token holds unallocated is refused, though the supply covers it; burning exactly that is given', {}, async function(recorder) {
		const published = await tokenWithSupply(recorder, 100n);
		const { token, chains } = published;
		const allocation = chains.append(await sendBlock({ from: token, signer: recorder.user(0), to: recorder.user(0), amount: 60n, token, previous: chains.previous(token), network: recorder.network.network }));
		await recorder.add(0, await confirmed(recorder, [allocation]));
		await recorder.vote(0, [await adjustSupply(recorder, published, 41n, lib.Block.AdjustMethod.SUBTRACT)]);
		await recorder.vote(0, [await adjustSupply(recorder, published, 40n, lib.Block.AdjustMethod.SUBTRACT)]);
	}),
	scenario('T6', 'a mint that takes the supply past its maximum is refused', {}, async function(recorder) {
		const published = await tokenWithSupply(recorder, MAXIMUM_SUPPLY);
		await recorder.vote(0, [await adjustSupply(recorder, published, 1n, lib.Block.AdjustMethod.ADD)]);
	}),
	scenario('T7', 'a token created with the maximum supply gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const { blocks } = await issueToken(recorder, chainsOf(recorder), recorder.user(0), { supply: MAXIMUM_SUPPLY, defaultPermission: ['ACCESS'] });
		await recorder.vote(0, [...blocks]);
	}),
	scenario('EO16', 'an overspend and a mint past the maximum supply are refused for the supply, which is checked before any balance', {}, async function(recorder) {
		const published = await tokenWithSupply(recorder, MAXIMUM_SUPPLY);
		const overspend = await send(recorder, 0, { amount: 401n, previous: published.chains.previous(recorder.user(0)) });
		await recorder.vote(0, [overspend, await adjustSupply(recorder, published, 1n, lib.Block.AdjustMethod.ADD)]);
	}),
	/*
	 * Each account's balance of each token is checked for falling negative
	 * before its receives are.
	 * [Keeta TS] index.js:70084-70093
	 */
	scenario('EO17', 'an account whose receive is not met and that overspends is refused for the balance', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const received = await receiveFromUser0(recorder, 11n, false);
		await recorder.vote(0, [received, await send(recorder, 1, { amount: 301n, previous: received.hash })]);
	})
];
