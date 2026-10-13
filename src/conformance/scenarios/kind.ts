import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import { feeBlock } from '../../testing/blocks.js';
import { toDecimal } from '../case.js';
import { scenario } from '../record.js';
import type { CaseRecorder, RecordingOptions, Scenario } from '../record.js';
import { HOUR, send } from './support.js';

/*
 * Which kind of vote a request asks for, and the checks on the votes and
 * quote that come with it.
 * [Keeta TS] index.js:70073-70287
 */

// Every representative weighs exactly a quarter of the total.
const QUARTERS = [250n, 250n, 250n, 250n];

const FLAT_FEE = 5n;

// Every representative charges the flat fee in the base token, paid to itself.
const CHARGING: RecordingOptions = { fee: { type: 'flat', amount: toDecimal(FLAT_FEE) } };

/** A fee block after `previous` from user `from`, paying each listed representative the flat fee. */
function payFees(recorder: CaseRecorder, from: number, previous: BlockHash, representatives: readonly number[]): Promise<Block> {
	return(feeBlock({
		from: recorder.user(from),
		previous,
		network: recorder.network.network,
		payments: representatives.map(function(representative) {
			return({ to: recorder.representative(representative), token: recorder.network.baseToken, amount: FLAT_FEE });
		})
	}));
}

export const kindScenarios: readonly Scenario[] = [
	scenario('V1', 'a request without other votes gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		await recorder.vote(0, [block]);
	}),
	scenario('V2', 'a request with the temporary votes of every representative gets a permanent vote', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		await recorder.vote(0, [block], temporary);
	}),
	scenario('V3', 'an hour later, a representative that has not voted refuses the bare block but gives a recovery vote against permanent votes', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		const permanent = [await recorder.vote(0, [block], temporary), await recorder.vote(1, [block], temporary)];
		recorder.advance(HOUR);
		await recorder.vote(2, [block]);
		await recorder.vote(2, [block], permanent);
	}),
	scenario('V3b', 'a recovery vote carries no fee, while a normal temporary vote carries a zero fee', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		const permanent = [await recorder.vote(0, [block], temporary), await recorder.vote(1, [block], temporary)];
		recorder.advance(HOUR);
		await recorder.vote(2, [await send(recorder, 2)]);
		await recorder.vote(2, [block], permanent);
	}),
	scenario('V3c', 'a recovery vote on blocks that end in a fee block skips the fee checks', CHARGING, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		const fee = await payFees(recorder, 0, block.hash, [0, 1]);
		const permanent = [await recorder.vote(0, [block, fee], temporary), await recorder.vote(1, [block, fee], temporary)];
		recorder.advance(HOUR);
		await recorder.vote(2, [block, fee], permanent);
	}),
	scenario('V4', 'a recovery vote is refused when the permanent votes weigh exactly a quarter of the total', { representativeWeights: QUARTERS }, async function(recorder) {
		await recorder.addGenesis(0, 1, 2, 3);
		const block = await send(recorder, 1);
		const temporary = [await recorder.vote(1, [block]), await recorder.vote(2, [block]), await recorder.vote(3, [block])];
		const permanent = await recorder.vote(1, [block], temporary);
		await recorder.vote(0, [block], [permanent]);
	}),
	scenario('V4b', 'a recovery vote is given when the permanent votes weigh three quarters of the total', { representativeWeights: QUARTERS }, async function(recorder) {
		await recorder.addGenesis(0, 1, 2, 3);
		const block = await send(recorder, 1);
		const temporary = [await recorder.vote(1, [block]), await recorder.vote(2, [block]), await recorder.vote(3, [block])];
		const permanent = [
			await recorder.vote(1, [block], temporary),
			await recorder.vote(2, [block], temporary),
			await recorder.vote(3, [block], temporary)
		];
		await recorder.vote(0, [block], permanent);
	}),
	scenario('V5', 'an empty list of other votes takes the recovery path with no weight', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		await recorder.vote(0, [block], []);
	}),
	scenario('V6', 'a request without blocks is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, []);
	}),
	scenario('V6b', 'a request whose first block is a fee block is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const fee = await payFees(recorder, 0, recorder.genesisHead(recorder.user(0)), [0]);
		await recorder.vote(0, [fee]);
	}),
	scenario('V6c', 'a quote on no blocks is given', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.quote(0, []);
	}),
	scenario('P1', 'a permanent request with only other representatives\' temporary votes is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		await recorder.vote(0, [block], temporary);
	}),
	scenario('P2', 'a permanent request that offers this node\'s own permanent vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const ours = await recorder.vote(0, [block]);
		const theirs = [await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		const permanent = await recorder.vote(0, [block], [ours, ...theirs]);
		await recorder.vote(0, [block], [permanent, ...theirs]);
	}),
	scenario('P3', 'a recovery request that includes this node\'s own permanent vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		const permanent = [await recorder.vote(0, [block], temporary), await recorder.vote(1, [block], temporary)];
		await recorder.vote(0, [block], permanent);
	}),
	scenario('P4', 'a request that offers the same vote twice is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const ours = await recorder.vote(0, [block]);
		const theirs = await recorder.vote(1, [block]);
		await recorder.vote(0, [block], [ours, theirs, theirs]);
	}),
	scenario('P5', 'a request that offers two votes of one issuer is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		const theirPermanent = await recorder.vote(1, [block], temporary);
		await recorder.vote(0, [block], [...temporary, theirPermanent]);
	}),
	scenario('P6', 'a request whose other votes cover other blocks is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const other = await send(recorder, 1);
		const ours = await recorder.vote(0, [block]);
		const theirs = await recorder.vote(1, [other]);
		await recorder.vote(0, [block], [ours, theirs]);
	}),
	scenario('P7', 'a request that offers a quote as a supporting vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const quote = await recorder.quote(1, [block]);
		const ours = await recorder.vote(0, [block]);
		await recorder.vote(0, [block], [ours, quote]);
	}),
	scenario('P8', 'a permanent request that comes with a quote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const quote = await recorder.quote(0, [block]);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		await recorder.vote(0, [block], temporary, quote);
	}),
	scenario('P9', 'a quote from another issuer, on other blocks or on another number of blocks is refused', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const quote = await recorder.quote(0, [block]);
		await recorder.vote(1, [block], undefined, quote);
		await recorder.vote(0, [await send(recorder, 1)], undefined, quote);
		await recorder.vote(0, [block, await send(recorder, 0, { previous: block.hash })], undefined, quote);
	}),
	scenario('P9c', 'a request with a matching quote and no other votes gets a temporary vote', CHARGING, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		const quote = await recorder.quote(0, [block]);
		await recorder.vote(0, [block], undefined, quote);
	})
];
