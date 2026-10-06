import { scenario } from '../record.js';
import type { Scenario } from '../record.js';
import { BLOCK_WINDOW, MINUTE, TEMPORARY_VALIDITY, VOTE_SLOP, send } from './support.js';

/*
 * What the clock decides: a temporary vote or quote needs a block dated
 * within five minutes of now either way, a permanent or recovery vote does
 * not, and vote bytes parse only within their validity, give or take a
 * minute.
 * [Keeta TS] index.js:70185-70207, 80373-80381, 80641-80653
 */

// A permanent vote issued at the start of a case is valid until this moment.
// [Keeta TS] index.js:81528-81530
const PERMANENT_UNTIL = new Date(Date.UTC(3027, 0, 31, 0, 0, 0));

export const clockScenarios: readonly Scenario[] = [
	scenario('C1', 'a block dated exactly five minutes ago gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		recorder.advance(BLOCK_WINDOW);
		await recorder.vote(0, [block]);
	}),
	scenario('C2', 'a block dated five minutes and a millisecond ago is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		recorder.advance(BLOCK_WINDOW + 1);
		await recorder.vote(0, [block]);
	}),
	scenario('C3', 'a block dated exactly five minutes ahead gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { date: new Date(Date.now() + BLOCK_WINDOW) })]);
	}),
	scenario('C4', 'a block dated five minutes and a millisecond ahead is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { date: new Date(Date.now() + BLOCK_WINDOW + 1) })]);
	}),
	scenario('C5', 'a permanent request on a block too old for a temporary vote gets a permanent vote', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		recorder.advance(4 * MINUTE);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		recorder.advance(TEMPORARY_VALIDITY);
		await recorder.vote(2, [block]);
		await recorder.vote(0, [block], temporary);
	}),
	scenario('C6', 'a quote shares the block window: exactly five minutes is quoted, a millisecond more is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		recorder.advance(BLOCK_WINDOW);
		await recorder.quote(0, [block]);
		recorder.advance(1);
		await recorder.quote(0, [block]);
	}),
	scenario('C7', 'a temporary vote is valid for five minutes and a permanent one until the end of January a thousand years on, each with a minute of slop', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const start = Date.now();
		const ours = await recorder.vote(0, [block]);
		const permanent = await recorder.vote(0, [block], [ours, await recorder.vote(1, [block])]);
		const probes = [{ offered: ours, end: start + TEMPORARY_VALIDITY }, { offered: permanent, end: PERMANENT_UNTIL.getTime() }];
		for (const { offered, end } of probes) {
			/*
			 * Permanence is decided when bytes are parsed, by a validity that
			 * ends more than a hundred years after the moment, so near its end
			 * the permanent vote parses as temporary and the request is a
			 * permanent one that lacks rep2's own vote.
			 * [Keeta TS] index.js:80379
			 */
			recorder.moveTo(new Date(end + VOTE_SLOP));
			await recorder.vote(2, [block], [offered]);
			recorder.advance(1);
			await recorder.vote(2, [block], [offered]);
		}
	}),
	/*
	 * The literal row hands vote() objects that have since expired, which a
	 * case cannot express: it parses every reference at the step's moment.
	 * Within the parse slop the same rule shows: vote() checks no other
	 * vote's expiry itself.
	 * [Keeta TS] index.js:69094-69144
	 */
	scenario('C8', 'a permanent request with other votes past their validity but within the parse slop gets a permanent vote', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		recorder.advance(TEMPORARY_VALIDITY + VOTE_SLOP);
		await recorder.vote(0, [block], temporary);
	}),
	scenario('C9', 'the bytes of a temporary vote seven minutes old do not parse', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		recorder.advance(7 * MINUTE);
		await recorder.vote(0, [block], temporary);
	}),
	scenario('C10', 'the bytes of a vote issued a minute ahead parse, and a millisecond further ahead do not', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const start = new Date();
		const ours = await recorder.vote(0, [block]);
		recorder.advance(VOTE_SLOP);
		const inSlop = await recorder.vote(1, [block]);
		recorder.advance(1);
		const ahead = await recorder.vote(2, [block]);
		recorder.moveTo(start);
		await recorder.vote(0, [block], [ours, ahead]);
		await recorder.vote(0, [block], [ours, inSlop]);
	}),
	scenario('C11', 'a second request for a block is refused while this node\'s temporary vote is valid, and given once it has expired with its minute of slop', {}, async function(recorder) {
		await recorder.addGenesis(0);
		// Dated ahead, so the block is still fresh once the vote has expired.
		const block = await send(recorder, 0, { date: new Date(Date.now() + BLOCK_WINDOW) });
		await recorder.vote(0, [block]);
		await recorder.vote(0, [block]);
		recorder.advance(TEMPORARY_VALIDITY);
		await recorder.vote(0, [block]);
		recorder.advance(VOTE_SLOP + 1);
		await recorder.vote(0, [block]);
	}),
	scenario('C11-D4', 'storage contract D4: this node\'s temporary side vote keeps refusing a competing request until a minute past its validity', { basis: 'contract' }, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0, { date: new Date(Date.now() + BLOCK_WINDOW) });
		await recorder.vote(0, [block]);
		/*
		 * Ledger.vote never checks the expiry of the votes it reads for a
		 * previous; the contract has side reads skip a temporary vote only
		 * once the moment is past its validity by the slop parsing allows.
		 * [Keeta TS] index.js:69282-69304
		 */
		recorder.advance(TEMPORARY_VALIDITY + VOTE_SLOP);
		await recorder.vote(0, [block]);
		recorder.advance(1);
		await recorder.vote(0, [block]);
	}),
	scenario('EO3', 'a permanent request without this node\'s temporary vote is refused for that, however old its block', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const theirs = [await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		recorder.advance(BLOCK_WINDOW + VOTE_SLOP);
		await recorder.vote(0, [block]);
		await recorder.vote(0, [block], theirs);
	}),
	scenario('EO4', 'a stale block that overspends is refused for its balance before its age', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const overspend = await send(recorder, 0, { amount: 401n });
		recorder.advance(BLOCK_WINDOW + 1);
		await recorder.vote(0, [overspend]);
	}),
	scenario('EO5', 'a stale block whose sibling holds this node\'s permanent vote is refused for the sibling before its age', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const sibling = await send(recorder, 0, { amount: 2n });
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		await recorder.vote(0, [block], temporary);
		recorder.advance(BLOCK_WINDOW + 1);
		await recorder.vote(0, [sibling]);
	}),
	scenario('EO6', 'the other votes parse before the quote: a vote from the future is reported before an expired quote', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		// Dated ahead, so the block is still fresh when the vote from the future is issued.
		const block = await send(recorder, 0, { date: new Date(Date.now() + 4 * MINUTE) });
		const quote = await recorder.quote(0, [block]);
		const parsedAt = Date.now() + TEMPORARY_VALIDITY + VOTE_SLOP + 1;
		recorder.moveTo(new Date(parsedAt + VOTE_SLOP + 1));
		const ahead = await recorder.vote(1, [block]);
		recorder.moveTo(new Date(parsedAt));
		await recorder.vote(0, [block], undefined, quote);
		await recorder.vote(0, [block], [ahead], quote);
	})
];
