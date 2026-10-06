import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import { feeBlock, setRepresentativeBlock } from '../../testing/blocks.js';
import { toDecimal } from '../case.js';
import { scenario } from '../record.js';
import type { CaseRecorder, RecordingOptions, Scenario } from '../record.js';
import { TEMPORARY_VALIDITY, VOTE_SLOP, confirmed, idempotentKey, send } from './support.js';
import type { SendOptions } from './support.js';

/*
 * What a node checks of each block in a request before it reads any state:
 * at most one fee block, the node's network and subnet, an idempotent key
 * used once per account, and each previous used once. Only then are the
 * keys looked up in storage, before the heads. An idempotent key is the
 * account and the key together, and the lookup leaves out the block's own
 * hash.
 * [Keeta TS] index.js:68920-68951, 69252-69259, 70096-70170
 */

const DEV_NETWORK = KeetaNet.Client.Config.NetworkIDs.dev;

const SUBNET = 5n;

// The one node runs on the subnet.
const ON_SUBNET: RecordingOptions = { nodes: [{ representative: 0, fee: { type: 'free' }, mode: 'read-write', subnet: toDecimal(SUBNET) }] };

// The longest idempotent key a block may carry. [Keeta TS] index.js:61334
const LONGEST_KEY = idempotentKey('k'.repeat(36));

const KEY = idempotentKey('order-1');

/** User 0 sends one unit with the key, after its genesis head unless stated. */
function keyed(recorder: CaseRecorder, options: SendOptions = {}): Promise<Block> {
	return(send(recorder, 0, { idempotent: KEY, ...options }));
}

/** Every representative confirms the block, and node 0 adds it. */
async function published(recorder: CaseRecorder, block: Block): Promise<Block> {
	await recorder.add(0, await confirmed(recorder, [block]));
	return(block);
}

/** User 0's opening block, which delegates to representative 0; voted on by a ledger that holds nothing. */
function opening(recorder: CaseRecorder, subnet?: bigint): Promise<Block> {
	const account = recorder.user(0);
	return(setRepresentativeBlock({ account, representative: recorder.representative(0), previous: null, network: recorder.network.network, subnet }));
}

export const networkScenarios: readonly Scenario[] = [
	scenario('N1', 'a vote on a block of another network is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { network: DEV_NETWORK })]);
	}),
	scenario('N6', 'a quote on a block of another network is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.quote(0, [await send(recorder, 0, { network: DEV_NETWORK })]);
	}),
	scenario('N2', 'a staple of a block of another network is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.add(0, await confirmed(recorder, [await send(recorder, 0, { network: DEV_NETWORK })]));
	}),
	scenario('N2b', 'a node on a subnet refuses a staple of blocks without one', ON_SUBNET, async function(recorder) {
		await recorder.addGenesis(0);
	}),
	scenario('N3', 'a node on a subnet refuses a vote on a block without one', ON_SUBNET, async function(recorder) {
		await recorder.vote(0, [await opening(recorder)]);
	}),
	scenario('N4', 'a node on a subnet gives a temporary vote on a block of the same subnet', ON_SUBNET, async function(recorder) {
		await recorder.vote(0, [await opening(recorder, SUBNET)]);
	}),
	scenario('N5', 'a node without a subnet refuses a vote on a block with one', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { subnet: SUBNET })]);
	}),
	scenario('I1', 'a block with the idempotent key of a published block of its account is refused, naming both blocks', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const first = await published(recorder, await keyed(recorder));
		await recorder.vote(0, [await keyed(recorder, { previous: first.hash })]);
	}),
	scenario('I2', 'two blocks of one account with one idempotent key in a request are refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const first = await keyed(recorder);
		await recorder.vote(0, [first, await keyed(recorder, { previous: first.hash, amount: 2n })]);
	}),
	/*
	 * Ledger itself never claims a key on the side: our drivers do, when
	 * they store the node's temporary vote, so that a pending block's key
	 * refuses others while the vote is unexpired.
	 */
	scenario('I3', 'storage contract D6 and D12: a block with the idempotent key of a block we voted for is refused for the key the side ledger claims for it, before the competition, which alone refuses a block without it', { basis: 'contract' }, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await keyed(recorder)]);
		await recorder.vote(0, [await keyed(recorder, { amount: 2n })]);
		await recorder.vote(0, [await send(recorder, 0, { amount: 3n })]);
	}),
	scenario('I3b', 'a permanent request for the block that holds an idempotent key on the side gets a permanent vote', {}, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await keyed(recorder);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		await recorder.vote(0, [block], temporary);
	}),
	scenario('I3-D12', 'storage contract D4 and D12: the idempotent key of a block we voted for refuses another block until a minute past the vote\'s validity', { basis: 'contract' }, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await keyed(recorder)]);
		recorder.advance(TEMPORARY_VALIDITY + VOTE_SLOP);
		await recorder.vote(0, [await keyed(recorder, { amount: 2n })]);
		recorder.advance(1);
		await recorder.vote(0, [await keyed(recorder, { amount: 3n })]);
	}),
	scenario('I3c-D12', 'storage contract D12: a key held on the main ledger is reported over our live side claim of it', { basis: 'contract' }, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await keyed(recorder)]);
		const winner = await published(recorder, await keyed(recorder, { amount: 2n }));
		await recorder.vote(0, [await keyed(recorder, { previous: winner.hash, amount: 3n })]);
	}),
	scenario('I4', 'the same idempotent key on another account gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await published(recorder, await keyed(recorder));
		await recorder.vote(0, [await send(recorder, 1, { idempotent: KEY })]);
	}),
	scenario('I5', 'an idempotent key of the greatest length gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { idempotent: LONGEST_KEY })]);
	}),
	scenario('I6', 'a published block with an idempotent key, voted on again, is no successor: its own key does not refuse it', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await published(recorder, await keyed(recorder))]);
	}),
	scenario('EO21', 'a second fee block of another network is refused as a second fee block', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		const pay = { to: recorder.representative(0), token: recorder.network.baseToken, amount: 1n };
		const first = await feeBlock({ from: recorder.user(0), previous: block.hash, network: recorder.network.network, payments: [pay] });
		const second = await feeBlock({ from: recorder.user(0), previous: first.hash, network: DEV_NETWORK, payments: [pay] });
		await recorder.vote(0, [block, first, second]);
	}),
	scenario('EO22', 'a block of another network and subnet is refused for the network', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await send(recorder, 0, { network: DEV_NETWORK, subnet: SUBNET })]);
	}),
	scenario('EO23', 'a block that repeats a key in the request and has a subnet is refused for the subnet', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const first = await keyed(recorder);
		await recorder.vote(0, [first, await keyed(recorder, { previous: first.hash, subnet: SUBNET })]);
	}),
	scenario('EO24', 'a block that repeats a key in the request and reuses a previous is refused for the key', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await keyed(recorder), await keyed(recorder, { amount: 2n })]);
	}),
	scenario('EO25', 'a block with a stored key and a later block of another network are refused for the network: every block is checked before any key is looked up', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const first = await published(recorder, await keyed(recorder));
		await recorder.vote(0, [await keyed(recorder, { previous: first.hash }), await send(recorder, 1, { network: DEV_NETWORK })]);
	}),
	scenario('EO31', 'a successor of a published block, carrying that block\'s idempotent key, is refused for the key though we voted for a competing successor', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const holder = await published(recorder, await keyed(recorder));
		await recorder.vote(0, [await send(recorder, 0, { previous: holder.hash })]);
		await recorder.vote(0, [await keyed(recorder, { previous: holder.hash, amount: 2n })]);
	}),
	scenario('EO26', 'a block with a stored key that is no successor is refused for the key before the head', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await published(recorder, await keyed(recorder));
		await recorder.vote(0, [await keyed(recorder, { amount: 2n })]);
	})
];
