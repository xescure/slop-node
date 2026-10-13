import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteQuote } from '@keetanetwork/keetanet-client/lib/vote.js';
import { MemoryLedgerStorage } from '../../ledger/storage/memory/driver.js';
import { createTokenBlock, feeBlock, operationsBlock, sendBlock } from '../../testing/blocks.js';
import { TEST_NETWORK_SEEDS } from '../../testing/network.js';
import type { TestFeePolicy } from '../../testing/network.js';
import { toCaseAccount, toDecimal } from '../case.js';
import type { CaseFeeAmount, CaseFeePolicy } from '../case.js';
import { DEFAULT_WEIGHTS, scenario } from '../record.js';
import type { CaseRecorder, RecordingOptions, Scenario, StepHandle } from '../record.js';
import { BLOCK_WINDOW, TEMPORARY_VALIDITY, VOTE_SLOP, confirmed, extraUserKey, idempotentKey, send } from './support.js';

/*
 * What a node charges, and how a permanent request pays it. Each temporary
 * vote carries its node's fee: a vote with a zero option makes its fee
 * optional, any other fee is required. A permanent request that holds
 * temporary votes with required fees must end in a fee block; a fee block
 * anywhere else is an ordinary block. The fee block's operations must number
 * the votes with required fees, or those and the optional ones, and every
 * such vote must find among them some SEND that matches one of its options
 * exactly in amount, token and payee. The match is not exclusive: one SEND
 * can serve several votes, so only the count limits a fee block. Only a
 * permanent request is checked, and only one with a fee block validates its
 * ledger outcome again.
 * [Keeta TS] index.js:70109-70248, 70360-70366, 71248-71262
 */

const lib = KeetaNet.lib;

const FLAT_FEE = 5n;

// A fee option in another token, dearer than the flat fee in the base token.
const TOKEN_FEE = 7n;

// The fee a quote carried before its node's fee changed, dearer than the flat fee.
const EARLIER_QUOTED_FEE = 9n;

/*
 * A key outside the default network's users. Its opening block creates the
 * fee token, so the token's address follows from the key alone and a node's
 * fee policy can name it before the case starts.
 * [Keeta TS] index.js:63854-63879
 */
const TOKEN_ISSUER = extraUserKey(DEFAULT_WEIGHTS.length, 0);

const FEE_TOKEN: TokenAddress = TOKEN_ISSUER.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);

// Where collected fees go when nodes name a payee: user 2.
const COLLECTOR = lib.Account.fromSeed(TEST_NETWORK_SEEDS.user, 2);

function flat(amount: bigint): CaseFeePolicy {
	return({ type: 'flat', amount: toDecimal(amount) });
}

// Every representative charges the flat fee in the base token, paid to itself.
const CHARGING: RecordingOptions = { fee: flat(FLAT_FEE) };

// Every representative offers to waive its fee or take the flat one.
const OPTIONAL: RecordingOptions = { fee: { type: 'choices', choices: [{ amount: toDecimal(0n) }, { amount: toDecimal(FLAT_FEE) }] } };

const TOKEN_CHOICE: CaseFeeAmount = { amount: toDecimal(TOKEN_FEE), token: toCaseAccount(FEE_TOKEN) };

// Every representative takes the flat fee in the base token or the dearer one in the fee token.
const TWO_TOKENS: RecordingOptions = { fee: { type: 'choices', choices: [{ amount: toDecimal(FLAT_FEE) }, TOKEN_CHOICE] } };

// Every representative charges the flat fee, paid to the collector.
const COLLECTED: RecordingOptions = { fee: { type: 'flat', amount: toDecimal(FLAT_FEE), payTo: toCaseAccount(COLLECTOR) } };

// Representative 0 charges nothing, which makes its zero fee optional; the others charge the flat fee.
const MIXED: RecordingOptions = {
	nodes: [
		{ representative: 0, fee: { type: 'free' }, mode: 'read-write' },
		{ representative: 1, fee: flat(FLAT_FEE), mode: 'read-write' },
		{ representative: 2, fee: flat(FLAT_FEE), mode: 'read-write' }
	]
};

type Payment = {
	readonly to: GenericAccount;
	readonly amount?: bigint;
	readonly token?: TokenAddress;
};

/** The flat fee in the base token to each listed representative, in the order listed. */
function feesTo(recorder: CaseRecorder, representatives: readonly number[], amount: bigint = FLAT_FEE): Payment[] {
	return(representatives.map(function(representative): Payment {
		return({ to: recorder.representative(representative), amount });
	}));
}

/** User 0's fee block after the block, making the payments in order. */
function feeAfter(recorder: CaseRecorder, block: Block, payments: readonly Payment[]): Promise<Block> {
	const { baseToken } = recorder.network;
	return(feeBlock({
		from: recorder.user(0),
		previous: block.hash,
		network: recorder.network.network,
		payments: payments.map(function({ to, amount = FLAT_FEE, token = baseToken }) {
			return({ to, amount, token });
		})
	}));
}

/** Every listed representative gives its temporary vote on the blocks. */
async function temporaryVotes(recorder: CaseRecorder, blocks: readonly Block[], representatives: readonly number[] = [0, 1, 2]): Promise<StepHandle[]> {
	const votes: StepHandle[] = [];
	for (const representative of representatives) {
		votes.push(await recorder.vote(representative, blocks));
	}
	return(votes);
}

/**
 * The usual shape: every representative votes for user 0's send, then
 * representative 0 is asked for its permanent vote on the send followed by
 * a fee block making the payments, or by nothing.
 */
async function payAndRequest(recorder: CaseRecorder, payments: readonly Payment[] | null, sendAmount = 1n): Promise<void> {
	await recorder.addGenesis(0, 1, 2);
	const block = await send(recorder, 0, { amount: sendAmount });
	const temporary = await temporaryVotes(recorder, [block]);
	const blocks = [block];
	if (payments !== null) {
		blocks.push(await feeAfter(recorder, block, payments));
	}
	await recorder.vote(0, blocks, temporary);
}

/** A quote by representative 0's key on a ledger of its own outside the case, with another fee policy. */
async function quoteElsewhere(recorder: CaseRecorder, fee: TestFeePolicy, blocks: readonly Block[]): Promise<VoteQuote> {
	const ledger = recorder.network.createLedger(new MemoryLedgerStorage(), recorder.representative(0), { fee });
	await ledger.add(recorder.network.genesis);
	return(await ledger.quote([...blocks]));
}

/*
 * The fee token's issuer creates it in its opening block, mints a supply
 * and gives it all to user 0; every node adds that. User 0's own chain is
 * left alone, so its next block still follows its genesis head.
 */
async function issueFeeToken(recorder: CaseRecorder): Promise<void> {
	const { network } = recorder.network;
	const supply = 3n * TOKEN_FEE;
	const { block: created, token } = await createTokenBlock({ owner: TOKEN_ISSUER, previous: null, network });
	if (!token.comparePublicKey(FEE_TOKEN)) {
		throw(new Error('the fee token is not the issuer\'s first identifier'));
	}
	const opening = await operationsBlock({
		account: token,
		signer: TOKEN_ISSUER,
		previous: null,
		network,
		operations: [
			{ type: lib.Block.OperationType.SET_INFO, name: 'FEE', description: '', metadata: '', defaultPermission: new lib.Permissions(['ACCESS']) },
			{ type: lib.Block.OperationType.TOKEN_ADMIN_SUPPLY, method: lib.Block.AdjustMethod.ADD, amount: supply }
		]
	});
	const handed = await sendBlock({ from: token, signer: TOKEN_ISSUER, to: recorder.user(0), amount: supply, token, previous: opening.hash, network });
	const staple = await confirmed(recorder, [created, opening, handed]);
	for (const representative of [0, 1, 2]) {
		await recorder.add(representative, staple);
	}
}

/** The two-token shape: every representative votes for user 0's send once user 0 holds the fee token. */
async function payInTokens(recorder: CaseRecorder, payments: readonly Payment[]): Promise<void> {
	await recorder.addGenesis(0, 1, 2);
	await issueFeeToken(recorder);
	const block = await send(recorder, 0);
	const temporary = await temporaryVotes(recorder, [block]);
	await recorder.vote(0, [block, await feeAfter(recorder, block, payments)], temporary);
}

export const feeScenarios: readonly Scenario[] = [
	scenario('F0', 'a temporary vote carries its node\'s fee, and a zero fee when the node charges nothing', {
		nodes: [
			{ representative: 0, fee: flat(FLAT_FEE), mode: 'read-write' },
			{ representative: 1, fee: { type: 'free' }, mode: 'read-write' }
		]
	}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		await recorder.vote(0, [block]);
		await recorder.vote(1, [block]);
	}),
	scenario('F1', 'a permanent request whose temporary votes require fees is refused without a fee block', CHARGING, async function(recorder) {
		await payAndRequest(recorder, null);
	}),
	scenario('F2', 'a fee block paying each representative its fee gets a permanent vote without a fee, on one block more than the temporary votes', CHARGING, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [0, 1, 2]));
	}),
	scenario('F3', 'a fee block with fewer payments than the votes that require one is refused', CHARGING, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [0, 1]));
	}),
	scenario('F4', 'a fee paid one short is refused', CHARGING, async function(recorder) {
		await payAndRequest(recorder, [...feesTo(recorder, [0, 1]), ...feesTo(recorder, [2], FLAT_FEE - 1n)]);
	}),
	scenario('F4b', 'a fee paid one over is refused: the amount must match exactly', CHARGING, async function(recorder) {
		await payAndRequest(recorder, [...feesTo(recorder, [0, 1]), ...feesTo(recorder, [2], FLAT_FEE + 1n)]);
	}),
	/*
	 * The fee check runs before the outcome is validated again, so the other
	 * token need not exist.
	 * [Keeta TS] index.js:70215-70248, 70360-70366
	 */
	scenario('F5a', 'a fee paid in another token is refused', CHARGING, async function(recorder) {
		await payAndRequest(recorder, [...feesTo(recorder, [0, 1]), { to: recorder.representative(2), token: FEE_TOKEN }]);
	}),
	scenario('F5b', 'a fee paid to another account than the voter is refused', CHARGING, async function(recorder) {
		await payAndRequest(recorder, [...feesTo(recorder, [0, 1]), { to: recorder.user(1) }]);
	}),
	scenario('F5c', 'fees paid in another order than the votes get a permanent vote', CHARGING, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [2, 0, 1]));
	}),
	scenario('F6', 'a payer that can afford its send but not the fees as well is refused for its balance', CHARGING, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [0, 1, 2]), 400n);
	}),
	scenario('F7', 'two fee blocks are refused for that in a temporary request, and for their block count in a permanent one', CHARGING, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const first = await feeAfter(recorder, block, feesTo(recorder, [0, 1, 2]));
		const second = await feeAfter(recorder, first, feesTo(recorder, [0, 1, 2]));
		await recorder.vote(0, [block, first, second]);
		const temporary = await temporaryVotes(recorder, [block]);
		await recorder.vote(0, [block, first, second], temporary);
	}),
	scenario('F7b', 'a fee block that is not the last block of a permanent request is an ordinary block, so the request lacks the fee block its votes require', CHARGING, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const fee = await feeAfter(recorder, block, feesTo(recorder, [0, 1, 2]));
		const after = await send(recorder, 0, { previous: fee.hash, amount: 2n });
		const temporary = await temporaryVotes(recorder, [block, fee, after]);
		await recorder.vote(0, [block, fee, after], temporary);
	}),
	scenario('F9', 'fees with a zero option are optional: a permanent request without a fee block is given', OPTIONAL, async function(recorder) {
		await payAndRequest(recorder, null);
	}),
	scenario('F9b', 'optional fees paid to every representative, each matching an option, get a permanent vote', OPTIONAL, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [0, 1, 2]));
	}),
	scenario('F9c', 'optional fees paid to only some representatives are refused: a fee block pays all of them or only the required ones', OPTIONAL, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [0, 1]));
	}),
	scenario('F9d', 'optional fees paid to every representative in an amount no option names are refused', OPTIONAL, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [0, 1, 2], FLAT_FEE - 1n));
	}),
	scenario('F9e', 'with one free node, a fee block paying only the required fees gets a permanent vote', MIXED, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [1, 2]));
	}),
	scenario('F9f', 'with one free node, a fee block that also pays the free node must match its zero fee, and is refused for paying one', MIXED, async function(recorder) {
		await payAndRequest(recorder, [...feesTo(recorder, [1, 2]), ...feesTo(recorder, [0], 1n)]);
	}),
	scenario('F10', 'fees offered in two tokens may all be paid in the dearer token', TWO_TOKENS, async function(recorder) {
		await payInTokens(recorder, [0, 1, 2].map(function(representative): Payment {
			return({ to: recorder.representative(representative), amount: TOKEN_FEE, token: FEE_TOKEN });
		}));
	}),
	scenario('F10b', 'fees offered in two tokens may be paid in either token, chosen per representative', TWO_TOKENS, async function(recorder) {
		await payInTokens(recorder, [
			{ to: recorder.representative(0) },
			{ to: recorder.representative(1), amount: TOKEN_FEE, token: FEE_TOKEN },
			{ to: recorder.representative(2) }
		]);
	}),
	scenario('E3', 'fees with a payee are paid to the payee, once per vote', COLLECTED, async function(recorder) {
		await payAndRequest(recorder, [COLLECTOR, COLLECTOR, COLLECTOR].map(function(to): Payment {
			return({ to });
		}));
	}),
	scenario('E3c', 'fees with a payee need only some SEND matching each vote: a fee block of the right size with one SEND to the payee serves every vote', COLLECTED, async function(recorder) {
		await payAndRequest(recorder, [{ to: COLLECTOR }, { to: recorder.user(1) }, { to: recorder.user(1) }]);
	}),
	scenario('E3b', 'fees with a payee paid to the voters instead are refused', COLLECTED, async function(recorder) {
		await payAndRequest(recorder, feesTo(recorder, [0, 1, 2]));
	}),
	scenario('F11', 'a quote carries its node\'s fee and is valid for five minutes, with the minute of slop parsing allows', CHARGING, async function(recorder) {
		await recorder.addGenesis(0);
		// Dated ahead, so the block is still fresh once the quote is about to expire.
		const block = await send(recorder, 0, { date: new Date(Date.now() + BLOCK_WINDOW) });
		const quote = await recorder.quote(0, [block]);
		recorder.advance(TEMPORARY_VALIDITY + VOTE_SLOP);
		await recorder.vote(0, [block], undefined, quote);
		recorder.advance(1);
		await recorder.vote(0, [block], undefined, quote);
	}),
	/*
	 * A node's fee is fixed for a case, and a key runs one node, so the
	 * quote from before a fee change is one the same key signed on a ledger
	 * of its own that charges more. The node's own quote shows what it
	 * charges now.
	 * [Keeta TS] index.js:71248-71262
	 */
	scenario('F12', 'a vote on a quote carries the quote\'s fee, not the one its node charges now', CHARGING, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		await recorder.quote(0, [block]);
		const dearer = await quoteElsewhere(recorder, { kind: 'flat', amount: EARLIER_QUOTED_FEE }, [block]);
		await recorder.vote(0, [block], undefined, dearer);
	}),
	scenario('F13', 'a quote on a block that overspends is refused: a quote validates the outcome', CHARGING, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.quote(0, [await send(recorder, 0, { amount: 401n })]);
	}),
	scenario('QT1', 'a quote on a block that is no successor is given, though a vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const published = await send(recorder, 0);
		await recorder.add(0, await confirmed(recorder, [published]));
		const stale = await send(recorder, 0, { amount: 2n });
		await recorder.quote(0, [stale]);
		await recorder.vote(0, [stale]);
	}),
	scenario('QT1b', 'a quote on a block whose idempotent key a published block holds is given, though a vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const published = await send(recorder, 0, { idempotent: idempotentKey('paid') });
		await recorder.add(0, await confirmed(recorder, [published]));
		const repeated = await send(recorder, 0, { previous: published.hash, idempotent: idempotentKey('paid') });
		await recorder.quote(0, [repeated]);
		await recorder.vote(0, [repeated]);
	}),
	scenario('QT1c', 'a quote on a block competing with one this node voted for is given, though a vote is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0)]);
		const competing = await send(recorder, 0, { amount: 2n });
		await recorder.quote(0, [competing]);
		await recorder.vote(0, [competing]);
	}),
	scenario('EO19', 'a permanent request without this node\'s temporary vote and without the fee block its votes require is refused for the fee block', CHARGING, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		await recorder.vote(0, [block], await temporaryVotes(recorder, [block], [1, 2]));
	}),
	scenario('EO20', 'a fee one short paid by a payer that cannot afford its send and the fees is refused for the fee before the balance', CHARGING, async function(recorder) {
		await payAndRequest(recorder, [...feesTo(recorder, [0, 1]), ...feesTo(recorder, [2], FLAT_FEE - 1n)], 400n);
	})
];
