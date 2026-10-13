import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import { scenario } from '../record.js';
import type { CaseRecorder, Scenario } from '../record.js';
import { confirmed, genesisBlocksOf, send, sendFrom } from './support.js';

/*
 * Which blocks may follow an account's chain: each block in a request needs
 * a fresh previous, the first of each account's blocks must follow the
 * account's head, and a node votes for one successor of a previous at a
 * time. NOT_OPENING and NOT_SUCCESSOR name every account the request's head
 * check covered.
 * [Keeta TS] index.js:70296-70341, 71132-71206
 */

/** User 0's genesis block before its head, so a block after it is no successor. */
function beforeHead(recorder: CaseRecorder): Block {
	const [funding] = genesisBlocksOf(recorder, recorder.user(0));
	if (funding === undefined) {
		throw(new Error('genesis gave user 0 no blocks'));
	}
	return(funding);
}

/** Two blocks of user 0 after its genesis head that compete as its successor. */
async function competing(recorder: CaseRecorder): Promise<readonly [Block, Block]> {
	return([await send(recorder, 0), await send(recorder, 0, { amount: 2n })]);
}

export const conflictScenarios: readonly Scenario[] = [
	scenario('K1', 'a block competing with one this node gave a temporary vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const [block, competitor] = await competing(recorder);
		await recorder.vote(0, [block]);
		await recorder.vote(0, [competitor]);
	}),
	scenario('K1b', 'another representative votes for the competing block', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const [block, competitor] = await competing(recorder);
		await recorder.vote(0, [block]);
		await recorder.vote(1, [competitor]);
	}),
	scenario('K1c', 'a block competing with one this node gave a permanent vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const [block, competitor] = await competing(recorder);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		await recorder.vote(0, [block], temporary);
		await recorder.vote(0, [competitor]);
	}),
	scenario('K1d', 'a second permanent request for a block this node gave a permanent vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		await recorder.vote(0, [block], temporary);
		await recorder.vote(0, [block], temporary);
	}),
	scenario('K1e', 'a block competing with one already added is no successor, even while this node holds a vote for the added one', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const [block, competitor] = await competing(recorder);
		await recorder.vote(0, [block]);
		await recorder.add(0, await confirmed(recorder, [block]));
		await recorder.vote(0, [competitor]);
	}),
	scenario('K1f', 'a permanent request replaces this node\'s temporary vote on the same block', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		await recorder.vote(0, [block], temporary);
	}),
	scenario('K2', 'two blocks with one previous in a request are refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [...await competing(recorder)]);
	}),
	scenario('K3', 'a block after an earlier block than the head is no successor, naming every account checked', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const successor = await send(recorder, 1);
		const stale = await send(recorder, 0, { previous: beforeHead(recorder).hash });
		await recorder.vote(0, [successor, stale]);
	}),
	scenario('K4', 'a block with a previous on an account without blocks is not opening, naming every account checked', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const successor = await send(recorder, 1);
		const unopened = await sendFrom(recorder, recorder.representative(1), { previous: beforeHead(recorder).hash });
		await recorder.vote(0, [successor, unopened]);
	}),
	scenario('K5', 'an opening block on an account with blocks is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { previous: null })]);
	}),
	scenario('K5b', 'an opening block on an account that has only received funds gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const funding = await send(recorder, 0, { to: recorder.representative(1), amount: 5n });
		await recorder.add(0, await confirmed(recorder, [funding]));
		await recorder.vote(0, [await sendFrom(recorder, recorder.representative(1), { previous: null })]);
	}),
	scenario('K6', 'a chain of two blocks of one account in a request gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const first = await send(recorder, 0);
		await recorder.vote(0, [first, await send(recorder, 0, { previous: first.hash })]);
	}),
	scenario('K6b', 'a chain given in reverse order is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const first = await send(recorder, 0);
		await recorder.vote(0, [await send(recorder, 0, { previous: first.hash }), first]);
	}),
	scenario('K6c', 'a block whose previous is another account\'s block in the request is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const first = await send(recorder, 0);
		await recorder.vote(0, [first, await send(recorder, 1, { previous: first.hash })]);
	}),
	scenario('K7', 'a staple added twice is refused the second time', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const staple = await confirmed(recorder, [await send(recorder, 0)]);
		await recorder.add(0, staple);
		await recorder.add(0, staple);
	}),
	scenario('K8', 'a block already added is no successor', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		await recorder.add(0, await confirmed(recorder, [block]));
		await recorder.vote(0, [block]);
	}),
	scenario('EO7', 'an empty list of other votes is refused as missing blocks when there are no blocks', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [], []);
	}),
	scenario('EO8', 'an empty list of other votes is refused for its weight before the head is checked', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		await recorder.add(0, await confirmed(recorder, [block]));
		await recorder.vote(0, [block], []);
	}),
	scenario('EO9', 'two blocks after an earlier block than the head are refused for sharing it before the head is checked', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const { hash } = beforeHead(recorder);
		await recorder.vote(0, [await send(recorder, 0, { previous: hash }), await send(recorder, 0, { previous: hash, amount: 2n })]);
	}),
	scenario('EO10', 'an overspending block competing with one this node voted for is refused for the competition before its balance', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0)]);
		await recorder.vote(0, [await send(recorder, 0, { amount: 401n })]);
	}),
	scenario('EO11', 'heads are checked in the order of the request, so the first failing account decides the refusal', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const stale = await send(recorder, 0, { previous: beforeHead(recorder).hash });
		const unopened = await sendFrom(recorder, recorder.representative(1), { previous: recorder.genesisHead(recorder.user(1)) });
		await recorder.vote(0, [stale, unopened]);
		await recorder.vote(0, [unopened, stale]);
	})
];
