import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Vote, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { confirmedStaple, setRepresentativeBlock } from '../../testing/blocks.js';
import { scenario } from '../record.js';
import type { CaseRecorder, Scenario } from '../record.js';
import { TEMPORARY_VALIDITY, send } from './support.js';

/*
 * Whether votes weigh enough: a permanent vote and an added staple need more
 * than two thirds of the delegated weight, counted per distinct issuer, and
 * while nothing is delegated only the trusted root's vote counts.
 * [Keeta TS] index.js:70776-70795, 70425-70436
 */

const lib = KeetaNet.lib;

// Every representative weighs exactly a quarter of the total.
const QUARTERS = [250n, 250n, 250n, 250n];

// A total of 32, whose two thirds round down to 21, so 22 are needed: representative 0 alone falls one short.
const ROUNDING = [21n, 1n, 10n];

/** A vote signed outside any ledger, with the validity given; a null end makes it permanent. */
function signedVote(signer: Account, blocks: readonly Block[], serial: bigint, validTo: Date | null, validFrom?: Date): Promise<Vote> {
	return(new lib.Vote.Builder(signer, [...blocks]).seal(serial, validTo, validFrom));
}

/** A staple whose votes are not checked against each other until its bytes are parsed. */
function uncheckedStaple(votes: readonly Vote[], blocks: readonly Block[]): VoteStaple {
	return(lib.Vote.Staple.fromVotesAndBlocks([...votes], [...blocks], { lazy: true }));
}

function representatives(recorder: CaseRecorder, ...indexes: readonly number[]): Account[] {
	return(indexes.map(function(index): Account {
		return(recorder.representative(index));
	}));
}

/** The end of a temporary vote issued now. */
function temporaryUntil(): Date {
	return(new Date(Date.now() + TEMPORARY_VALIDITY));
}

export const quorumScenarios: readonly Scenario[] = [
	scenario('Q1', 'a permanent request backed by representatives weighing 60% is refused', {}, async function(recorder) {
		await recorder.addGenesis(1, 2);
		const block = await send(recorder, 1);
		const temporary = [await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		await recorder.vote(1, [block], temporary);
	}),
	scenario('Q2', 'a permanent request backed by representatives weighing 70% gets a permanent vote', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		await recorder.vote(0, [block], temporary);
	}),
	scenario('Q3', 'with equal thirds, two of three representatives are not enough and all three are', { representativeWeights: [1n, 1n, 1n] }, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const [first, second, third] = [await recorder.vote(0, [block]), await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		await recorder.vote(0, [block], [first, second]);
		await recorder.vote(0, [block], [first, second, third]);
	}),
	scenario('Q3b', 'two thirds of the weight round down before one is added: one short is refused, exactly enough is given', { representativeWeights: ROUNDING }, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block])];
		await recorder.vote(0, [block], temporary.slice(0, 1));
		await recorder.vote(0, [block], temporary);
	}),
	scenario('Q5', 'a staple with two votes of one issuer does not parse', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		const representative = recorder.representative(0);
		const votes = [await signedVote(representative, [block], 1n, null), await signedVote(representative, [block], 2n, null)];
		await recorder.add(0, uncheckedStaple(votes, [block]));
	}),
	scenario('Q6', 'a staple voted by representatives weighing 70% is added', {}, async function(recorder) {
		await recorder.addGenesis(2);
		const block = await send(recorder, 0);
		await recorder.add(2, await confirmedStaple([block], representatives(recorder, 0, 1)));
	}),
	scenario('Q7', 'a staple voted by representatives weighing 60% is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		await recorder.add(0, await confirmedStaple([block], representatives(recorder, 1, 2)));
	}),
	scenario('Q8', 'a staple of temporary votes is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		const validTo = temporaryUntil();
		const votes = await Promise.all(representatives(recorder, 0, 1, 2).map(function(representative): Promise<Vote> {
			return(signedVote(representative, [block], 1n, validTo));
		}));
		await recorder.add(0, lib.Vote.Staple.fromVotesAndBlocks(votes, [block]));
	}),
	scenario('Q9', 'a staple mixing temporary and permanent votes does not parse', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		const votes = [
			await signedVote(recorder.representative(0), [block], 1n, temporaryUntil()),
			await signedVote(recorder.representative(1), [block], 1n, null)
		];
		await recorder.add(0, uncheckedStaple(votes, [block]));
	}),
	scenario('Q10', 'while nothing is delegated, a staple needs the trusted root\'s vote, alone or among others', {}, async function(recorder) {
		const { genesis, trustedSigner } = recorder.network;
		await recorder.add(0, await confirmedStaple(genesis.blocks, representatives(recorder, 0)));
		await recorder.add(0, genesis);
		await recorder.add(1, await confirmedStaple(genesis.blocks, [trustedSigner, ...representatives(recorder, 0)]));
	}),
	scenario('Q11', 'while nothing is delegated, any staple the trusted root votes for is added', {}, async function(recorder) {
		const delegation = await setRepresentativeBlock({
			account: recorder.user(0),
			representative: recorder.representative(0),
			previous: null,
			network: recorder.network.network
		});
		await recorder.add(0, await confirmedStaple([delegation], [recorder.network.trustedSigner]));
	}),
	scenario('Q12', 'once weight is delegated, the trusted root\'s vote alone is not enough', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		await recorder.add(0, await confirmedStaple([block], [recorder.network.trustedSigner]));
	}),
	scenario('Q13', 'a staple whose votes are valid from before 1970 is refused for that before its weight is counted; from 1970 on its weight decides', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const block = await send(recorder, 0);
		for (const signers of [representatives(recorder, 1), representatives(recorder, 0, 1)]) {
			for (const validFrom of [new Date(-1), new Date(0)]) {
				const votes = await Promise.all(signers.map(function(signer): Promise<Vote> {
					return(signedVote(signer, [block], 1n, null, validFrom));
				}));
				await recorder.add(0, lib.Vote.Staple.fromVotesAndBlocks(votes, [block]));
			}
		}
	}),
	scenario('Q14', 'a staple with enough weight is added without a balance check, though votes on its block and on the next one are refused', {}, async function(recorder) {
		await recorder.addGenesis(1, 2);
		const overspend = await send(recorder, 0, { amount: 401n });
		await recorder.vote(1, [overspend]);
		await recorder.add(2, await confirmedStaple([overspend], representatives(recorder, 0, 1)));
		await recorder.vote(2, [await send(recorder, 0, { previous: overspend.hash })]);
	}),
	scenario('Q15', 'weight moves when a delegation is added: a representative too light alone becomes enough', {}, async function(recorder) {
		await recorder.addGenesis(1);
		const block = await send(recorder, 1);
		const temporary = await recorder.vote(1, [block]);
		await recorder.vote(1, [block], [temporary]);
		const delegation = await setRepresentativeBlock({
			account: recorder.user(0),
			representative: recorder.representative(1),
			previous: recorder.genesisHead(recorder.user(0)),
			network: recorder.network.network
		});
		await recorder.add(1, await confirmedStaple([delegation], representatives(recorder, 0, 1)));
		await recorder.vote(1, [block], [temporary]);
	}),
	scenario('Q16', 'a delegation that is voted on but not added moves no weight', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const block = await send(recorder, 1);
		const temporary = await recorder.vote(1, [block]);
		const delegation = await setRepresentativeBlock({
			account: recorder.user(0),
			representative: recorder.representative(1),
			previous: recorder.genesisHead(recorder.user(0)),
			network: recorder.network.network
		});
		await recorder.vote(0, [delegation]);
		await recorder.vote(1, [delegation]);
		await recorder.vote(1, [block], [temporary]);
	}),
	scenario('EO1', 'a recovery request that includes this node\'s own permanent vote is refused for that before its weight is counted', { representativeWeights: QUARTERS }, async function(recorder) {
		await recorder.addGenesis(0, 1, 2);
		const block = await send(recorder, 0);
		const temporary = [await recorder.vote(0, [block]), await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		const ours = await recorder.vote(0, [block], temporary);
		await recorder.vote(0, [block], [ours]);
	}),
	scenario('EO2', 'a permanent request on a block already added is refused as no successor before its weight is counted', {}, async function(recorder) {
		await recorder.addGenesis(1, 2);
		const block = await send(recorder, 1);
		const temporary = [await recorder.vote(1, [block]), await recorder.vote(2, [block])];
		await recorder.add(1, await confirmedStaple([block], representatives(recorder, 0, 1, 2)));
		await recorder.vote(1, [block], temporary);
	})
];
