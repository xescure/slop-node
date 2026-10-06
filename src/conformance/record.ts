import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { TEST_NETWORK_SEEDS, advanceClock, freezeClock } from '../testing/network.js';
import type { TestNetwork } from '../testing/network.js';
import { toBase64, toCaseSeed, toDecimal, toMoment } from './case.js';
import type { Base64, CaseAction, CaseFeePolicy, CaseLedgerMode, CaseStep, VoteCase, VoteReference } from './case.js';
import { CaseRunner } from './runner.js';
import type { CaseSetup, Produced } from './runner.js';

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

export type RecordingOptions = {
	readonly representativeWeights?: readonly bigint[];
	readonly fee?: CaseFeePolicy;
	readonly mode?: CaseLedgerMode;
};

/** A step's produced vote or quote, as later steps reference it. */
export type StepHandle = Extract<VoteReference, { fromStep: number }>;

/** A supporting vote or quote: one an earlier step produced, or one given literally. */
export type Supporting = StepHandle | Produced;

function referenceTo(supporting: Supporting): VoteReference {
	if ('fromStep' in supporting) {
		return(supporting);
	}
	return({ bytes: toBase64(supporting.toBytes()) });
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
	readonly #runner: CaseRunner;
	readonly #setup: CaseSetup;
	readonly #steps: CaseStep[] = [];

	private constructor(runner: CaseRunner, setup: CaseSetup) {
		this.#runner = runner;
		this.#setup = setup;
	}

	/** Freezes the clock at the start of the case. */
	static async start(context: ScenarioContext, options: RecordingOptions = {}): Promise<CaseRecorder> {
		const { representativeWeights = DEFAULT_WEIGHTS, fee = { type: 'free' }, mode = 'read-write' } = options;
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
			fee,
			mode
		};
		freezeClock(CASE_START);
		return(new CaseRecorder(await CaseRunner.start(setup, context.createDriver), setup));
	}

	get network(): TestNetwork {
		return(this.#runner.network);
	}

	representative(index: number): Account {
		return(this.#runner.representative(index));
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

	/** Every listed representative adds genesis, each as a step of its own. */
	async addGenesis(...actors: readonly number[]): Promise<void> {
		for (const actor of actors) {
			await this.add(actor, this.network.genesis);
		}
	}

	/**
	 * A staple's canonical bytes are its uncompressed form, the one its hash covers.
	 * [Keeta TS] index.js:81036-81040
	 */
	add(actor: number, staple: VoteStaple): Promise<StepHandle> {
		return(this.#record(actor, { type: 'add', staple: toBase64(staple.toBytes(true)) }));
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

	finish(id: string, title: string): VoteCase {
		return({ id, title, ...this.#setup, steps: [...this.#steps] });
	}

	async #record(actor: number, action: CaseAction): Promise<StepHandle> {
		const moment = toMoment(new Date());
		const fromStep = this.#steps.length;
		const result = await this.#runner.run(actor, action);
		if (result.kind === 'broken') {
			throw(new Error(`step ${String(fromStep)} cannot be recorded: ${result.reason}`));
		}
		this.#steps.push({ moment, actor, action, expect: result.observed });
		return({ fromStep });
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
