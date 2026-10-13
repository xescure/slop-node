import * as KeetaNet from '@keetanetwork/keetanet-client';
import { feeBlock } from '../../testing/blocks.js';
import type { CaseLedgerMode, CaseNode } from '../case.js';
import { scenario } from '../record.js';
import type { CaseRecorder, RecordingOptions, Scenario } from '../record.js';
import { confirmed, send } from './support.js';

/*
 * What a node's write mode and key allow. Only a read-write node with a key
 * votes or quotes; a read-only node adds nothing, and a bootstrap-only one
 * only what it is given to bootstrap from. A vote checks its blocks are
 * present, then the key, then the mode; a quote checks its blocks, then the
 * mode, then the key; an add checks the mode before anything in the staple.
 * [Keeta TS] index.js:70048-70060, 70392-70427, 71207-71212
 */

const DEV_NETWORK = KeetaNet.Client.Config.NetworkIDs.dev;

function node(representative: number | null, mode: CaseLedgerMode): CaseNode {
	return({ representative, fee: { type: 'free' }, mode });
}

function only(representative: number | null, mode: CaseLedgerMode): RecordingOptions {
	return({ nodes: [node(representative, mode)] });
}

/** The node adds genesis, then votes on user 0's send and quotes it. */
async function addVoteQuote(recorder: CaseRecorder): Promise<void> {
	await recorder.addGenesis(0);
	const block = await send(recorder, 0);
	await recorder.vote(0, [block]);
	await recorder.quote(0, [block]);
}

export const modeScenarios: readonly Scenario[] = [
	scenario('W1', 'a read-write node adds, votes and quotes', only(0, 'read-write'), addVoteQuote),
	scenario('W2', 'a no-voting node adds, and refuses to vote or quote', only(0, 'no-voting'), addVoteQuote),
	scenario('W3', 'a bootstrap-only node adds only what it bootstraps from, and refuses to vote or quote', only(0, 'bootstrap-only'), async function(recorder) {
		await recorder.add(0, recorder.network.genesis);
		await recorder.add(0, recorder.network.genesis, 'bootstrap');
		const block = await send(recorder, 0);
		await recorder.vote(0, [block]);
		await recorder.quote(0, [block]);
	}),
	scenario('W4', 'a read-only node adds nothing, even to bootstrap, and refuses to vote or quote', only(0, 'read-only'), async function(recorder) {
		await recorder.add(0, recorder.network.genesis);
		await recorder.add(0, recorder.network.genesis, 'bootstrap');
		const block = await send(recorder, 0);
		await recorder.vote(0, [block]);
		await recorder.quote(0, [block]);
	}),
	scenario('W5', 'a node without a key adds, and refuses to vote or quote', only(null, 'read-write'), addVoteQuote),
	scenario('EO27', 'a no-voting node refuses a vote without blocks, or led by a fee block, for its blocks before its mode', only(0, 'no-voting'), async function(recorder) {
		await recorder.vote(0, []);
		const pay = { to: recorder.representative(0), token: recorder.network.baseToken, amount: 1n };
		await recorder.vote(0, [await feeBlock({ from: recorder.user(0), previous: recorder.genesisHead(recorder.user(0)), network: recorder.network.network, payments: [pay] })]);
	}),
	scenario('EO28', 'a no-voting node without a key refuses a vote for the key and a quote for the mode', only(null, 'no-voting'), async function(recorder) {
		const block = await send(recorder, 0);
		await recorder.vote(0, [block]);
		await recorder.quote(0, [block]);
	}),
	scenario('EO29', 'a no-voting node refuses a quote on a block of another network for the network before its mode', only(0, 'no-voting'), async function(recorder) {
		await recorder.quote(0, [await send(recorder, 0, { network: DEV_NETWORK })]);
		await recorder.quote(0, [await send(recorder, 0)]);
	}),
	scenario('EO30', 'a staple of another network given to bootstrap from is refused for the mode by a read-only node, and for the network by a bootstrap-only one', { nodes: [node(0, 'read-only'), node(1, 'bootstrap-only')] }, async function(recorder) {
		const staple = await confirmed(recorder, [await send(recorder, 0, { network: DEV_NETWORK })]);
		await recorder.add(0, staple, 'bootstrap');
		await recorder.add(1, staple, 'bootstrap');
	})
];
