import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Vote, VoteQuote, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { TEST_NETWORK_SEEDS, advanceClock, createTestNetwork, freezeClock } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { toBase64, toCaseSeed, toDecimal, toMoment } from './case.js';
import type { AddSource, Base64, CaseAction, CaseBasis, CaseFeePolicy, CaseLedgerMode, CaseNode, CaseStep, StapleReference, StepReference, VoteCase, VoteReference } from './case.js';
import { CaseRunner } from './runner.js';
import type { CaseSetup } from './runner.js';

const lib = KeetaNet.lib;

/** Every case starts at this moment, after the cutoff that rejects negative amounts. */
export const CASE_START: Date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

export const DEFAULT_WEIGHTS: readonly bigint[] = [400n, 300n, 300n];

export type ScenarioContext = {
	readonly createDriver: () => Promise<LedgerStorageDriverBase>;
};

/** Builds one case by running it through upstream's ledger and recording what happened. */
export type Scenario = {
	readonly id: string;
	readonly title: string;
	build(context: ScenarioContext): Promise<VoteCase>;
};

/**
 * Without explicit nodes, node i is representative i's, with the given fee
 * policy and write mode, so a scenario's actor is a representative index.
 */
export type RecordingOptions = {
	readonly representativeWeights?: readonly bigint[];
	readonly fee?: CaseFeePolicy;
	readonly mode?: CaseLedgerMode;
	readonly nodes?: readonly CaseNode[];
	/** Upstream unless an outcome also depends on a rule of the storage contract. */
	readonly basis?: CaseBasis;
};

/** A step whose produced bytes later steps may reference. */
export type StepHandle = StepReference;

/** A supporting vote or quote: one an earlier step produced, or one given literally. */
export type Supporting = StepHandle | Vote | VoteQuote;

function referenceTo(supporting: Supporting): VoteReference {
	if ('fromStep' in supporting) {
		return(supporting);
	}
	if (lib.Vote.Quote.isInstance(supporting)) {
		return({ type: 'literal', kind: 'quote', bytes: toBase64(supporting.toBytes()) });
	}
	return({ type: 'literal', kind: 'vote', bytes: toBase64(supporting.toBytes()) });
}

function encodeBlocks(blocks: readonly Block[]): Base64[] {
	return(blocks.map(function(block): Base64 {
		return(toBase64(block.toBytes()));
	}));
}

/**
 * Records a case step by step. Each action is first encoded the way the case
 * stores it and then executed from that encoding, exactly as a replay
 * executes it, so a case can only record what its own data reproduces. The
 * outcome becomes the step's expectation; nothing is written by hand.
 */
export class CaseRecorder {
	readonly network: TestNetwork;
	readonly #runner: CaseRunner;
	readonly #setup: CaseSetup;
	readonly #basis: CaseBasis;
	readonly #steps: CaseStep[] = [];
	// The first add step that carried each staple, so later adds reference it.
	readonly #staples = new Map<Base64, number>();

	private constructor(network: TestNetwork, setup: CaseSetup, basis: CaseBasis, runner: CaseRunner) {
		this.network = network;
		this.#setup = setup;
		this.#basis = basis;
		this.#runner = runner;
	}

	/** Freezes the clock at the start of the case. */
	static async start(context: ScenarioContext, options: RecordingOptions = {}): Promise<CaseRecorder> {
		const { representativeWeights = DEFAULT_WEIGHTS, fee = { type: 'free' }, mode = 'read-write', basis = 'upstream' } = options;
		const nodes = options.nodes ?? representativeWeights.map(function(_weight, representative): CaseNode {
			return({ representative, fee, mode });
		});
		const setup: CaseSetup = {
			network: {
				id: '0',
				seeds: {
					trustedRoot: toCaseSeed(TEST_NETWORK_SEEDS.trustedRoot),
					representative: toCaseSeed(TEST_NETWORK_SEEDS.representative),
					user: toCaseSeed(TEST_NETWORK_SEEDS.user)
				},
				representativeWeights: representativeWeights.map(toDecimal)
			},
			nodes
		};
		freezeClock(CASE_START);
		const network = await createTestNetwork({ representativeWeights, seeds: TEST_NETWORK_SEEDS });
		return(new CaseRecorder(network, setup, basis, new CaseRunner(setup, context.createDriver)));
	}

	representative(index: number): Account {
		const representative = this.network.representatives[index];
		if (representative === undefined) {
			throw(new Error(`there is no representative ${String(index)}`));
		}
		return(representative);
	}

	user(index: number): Account {
		const user = this.network.users[index];
		if (user === undefined) {
			throw(new Error(`there is no user ${String(index)}`));
		}
		return(user);
	}

	/** The last block genesis gave an account. */
	genesisHead(account: GenericAccount): BlockHash {
		const head = this.network.genesis.blocks.filter(function(block): boolean {
			return(block.account.comparePublicKey(account));
		}).at(-1);
		if (head === undefined) {
			throw(new Error(`genesis has no block for ${account.publicKeyString.get()}`));
		}
		return(head.hash);
	}

	advance(milliseconds: number): void {
		advanceClock(milliseconds);
	}

	/** Sets the clock, earlier or later; a step's moment need not follow the one before. */
	moveTo(moment: Date): void {
		freezeClock(moment);
	}

	/** Every listed node adds genesis, each as a step of its own. */
	async addGenesis(...actors: readonly number[]): Promise<void> {
		for (const actor of actors) {
			await this.add(actor, this.network.genesis);
		}
	}

	/**
	 * A staple's canonical bytes are its uncompressed form, the one its hash
	 * covers. A staple an earlier step already carried is referenced.
	 * [Keeta TS] index.js:81036-81040
	 */
	add(actor: number, staple: VoteStaple, from?: AddSource): Promise<StepHandle> {
		const bytes = toBase64(staple.toBytes(true));
		const carriedBy = this.#staples.get(bytes);
		let reference: StapleReference = { type: 'literal', kind: 'staple', bytes };
		if (carriedBy === undefined) {
			this.#staples.set(bytes, this.#steps.length);
		} else {
			reference = { type: 'step', fromStep: carriedBy };
		}
		const action: { type: 'add'; staple: StapleReference; from?: AddSource } = { type: 'add', staple: reference };
		if (from !== undefined) {
			action.from = from;
		}
		return(this.#record(actor, action));
	}

	vote(actor: number, blocks: readonly Block[], otherVotes?: readonly Supporting[], quote?: Supporting): Promise<StepHandle> {
		const action: { type: 'vote'; blocks: Base64[]; otherVotes?: VoteReference[]; quote?: VoteReference } = { type: 'vote', blocks: encodeBlocks(blocks) };
		if (otherVotes !== undefined) {
			action.otherVotes = otherVotes.map(referenceTo);
		}
		if (quote !== undefined) {
			action.quote = referenceTo(quote);
		}
		return(this.#record(actor, action));
	}

	quote(actor: number, blocks: readonly Block[]): Promise<StepHandle> {
		return(this.#record(actor, { type: 'quote', blocks: encodeBlocks(blocks) }));
	}

	gc(actor: number): Promise<StepHandle> {
		return(this.#record(actor, { type: 'gc' }));
	}

	/** Only the nodes that acted are kept, renumbered in their original order. */
	finish(id: string, title: string): VoteCase {
		const recorded = this.#steps;
		const acting: number[] = [];
		const nodes: CaseNode[] = [];
		for (const [index, node] of this.#setup.nodes.entries()) {
			if (recorded.some(function(step): boolean {
				return(step.actor === index);
			})) {
				acting.push(index);
				nodes.push(node);
			}
		}
		const steps = recorded.map(function(step): CaseStep {
			return({ ...step, actor: acting.indexOf(step.actor) });
		});
		return({ id, title, basis: this.#basis, network: this.#setup.network, nodes, steps });
	}

	async #record(actor: number, action: CaseAction): Promise<StepHandle> {
		const moment = toMoment(new Date());
		const fromStep = this.#steps.length;
		const result = await this.#runner.run(actor, action);
		if (result.kind === 'broken') {
			throw(new Error(`step ${String(fromStep)} cannot be recorded: ${result.reason}`));
		}
		this.#steps.push({ moment, actor, action, expect: result.observed });
		return({ type: 'step', fromStep });
	}
}

/** A scenario whose case runs the script on a fresh recorder. */
export function scenario(id: string, title: string, options: RecordingOptions, script: (recorder: CaseRecorder) => Promise<void>): Scenario {
	return({
		id,
		title,
		async build(context) {
			const recorder = await CaseRecorder.start(context, options);
			await script(recorder);
			return(recorder.finish(id, title));
		}
	});
}
