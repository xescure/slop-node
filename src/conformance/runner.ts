import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { FeeAmountAndToken, Vote, VoteQuote } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { createTestNetwork } from '../testing/network.js';
import type { TestFeePolicy, TestNetwork } from '../testing/network.js';
import { assertNever } from '../util/assert-never.js';
import { base64Bytes, caseAccount, decimalValue, toCaseAccount, toCaseBlockHash, toDecimal } from './case.js';
import type { Base64, CaseAccount, CaseAction, CaseExpectation, CaseFeeAmount, CaseFeePolicy, CaseRefusal, CaseVoteFee, VoteCase, VoteReference } from './case.js';

const lib = KeetaNet.lib;

/** What a case needs to rebuild its network: everything but the steps. */
export type CaseSetup = Pick<VoteCase, 'network' | 'fee' | 'mode'>;

/** What a step produced, as an expectation; or why the step could not be judged at all. */
export type StepResult =
	{ readonly kind: 'observed'; readonly observed: CaseExpectation } |
	{ readonly kind: 'broken'; readonly reason: string };

/** A vote or quote a step produced, which later steps may reference. */
export type Produced = Vote | VoteQuote;

/** The request an action makes, with every reference resolved and every encoded value parsed. */
type LedgerRequest =
	{ readonly type: 'add'; readonly staple: Base64 } |
	{ readonly type: 'vote'; readonly blocks: readonly Base64[]; readonly otherVotes: readonly SupportingVote[] | undefined; readonly quote: SupportingVote | undefined } |
	{ readonly type: 'quote'; readonly blocks: readonly Base64[] } |
	{ readonly type: 'gc' };

/** A supporting vote or quote, still encoded unless an earlier step produced it. */
type SupportingVote = { readonly bytes: Base64 } | { readonly produced: Produced };

class BrokenStep extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'BrokenStep';
	}
}

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

function requireToken(account: GenericAccount, what: string): TokenAddress {
	if (!account.isToken()) {
		throw(new BrokenStep(`${what} is not a token`));
	}
	return(account);
}

function requirePayee(account: GenericAccount, what: string): Account | StorageAddress {
	if (account.isStorage() || account.isAccount()) {
		return(account);
	}
	throw(new BrokenStep(`${what} can neither sign nor be a storage account`));
}

function testFeePolicy(fee: CaseFeePolicy): TestFeePolicy {
	switch (fee.type) {
		case 'free':
			return({ kind: 'free' });
		case 'flat': {
			const policy: { kind: 'flat'; amount: bigint; token?: TokenAddress; payTo?: Account | StorageAddress } = { kind: 'flat', amount: decimalValue(fee.amount) };
			if (fee.token !== undefined) {
				policy.token = requireToken(caseAccount(fee.token), 'the fee token');
			}
			if (fee.payTo !== undefined) {
				policy.payTo = requirePayee(caseAccount(fee.payTo), 'the fee payee');
			}
			return(policy);
		}
		default:
			return(assertNever(fee));
	}
}

function feeAmountOf(fee: FeeAmountAndToken): CaseFeeAmount {
	const amount: { amount: CaseFeeAmount['amount']; token?: CaseAccount; payTo?: CaseAccount } = { amount: toDecimal(fee.amount) };
	if (fee.token !== undefined) {
		amount.token = toCaseAccount(fee.token);
	}
	if (fee.payTo !== undefined) {
		amount.payTo = toCaseAccount(fee.payTo);
	}
	return(amount);
}

function voteFeeOf(fee: Produced['fee']): CaseVoteFee {
	if (fee === undefined) {
		return({ type: 'none' });
	}
	if (Array.isArray(fee)) {
		return({ type: 'choices', choices: fee.map(feeAmountOf) });
	}
	return({ type: 'single', ...feeAmountOf(fee) });
}

/**
 * Re-parses what the ledger returned, which verifies the signature, and
 * checks that the actor issued it.
 * [Keeta TS] index.js:80558-80563
 */
function observeVote(vote: Vote, actor: Account): CaseExpectation {
	let parsed: Vote;
	try {
		parsed = new lib.Vote(vote.toBytes());
	} catch (error: unknown) {
		throw(new BrokenStep(`the produced vote does not verify: ${messageOf(error)}`));
	}
	if (!parsed.issuer.comparePublicKey(actor)) {
		throw(new BrokenStep(`the produced vote was issued by ${parsed.issuer.publicKeyString.get()}, not by the actor`));
	}
	let outcome: 'temporary' | 'permanent' = 'temporary';
	if (parsed.$permanent) {
		outcome = 'permanent';
	}
	return({ outcome, blocks: parsed.blocks.map(toCaseBlockHash), fee: voteFeeOf(parsed.fee) });
}

function observeQuote(quote: VoteQuote, actor: Account): CaseExpectation {
	let parsed: VoteQuote;
	try {
		parsed = new lib.Vote.Quote(quote.toBytes());
	} catch (error: unknown) {
		throw(new BrokenStep(`the produced quote does not verify: ${messageOf(error)}`));
	}
	if (!parsed.issuer.comparePublicKey(actor)) {
		throw(new BrokenStep(`the produced quote was issued by ${parsed.issuer.publicKeyString.get()}, not by the actor`));
	}
	return({ outcome: 'quote', blocks: parsed.blocks.map(toCaseBlockHash), fee: voteFeeOf(parsed.fee) });
}

/**
 * Upstream's coded errors carry a code, and some also the accounts, or the
 * block hashes, that caused them; anything else thrown is a plain Error.
 */
function refusalOf(error: unknown): CaseRefusal {
	if (lib.Error.isInstance(error)) {
		const refusal: { type: 'coded'; code: typeof error.code; accounts?: CaseAccount[]; blockhash?: ReturnType<typeof toCaseBlockHash>; existingBlockhash?: ReturnType<typeof toCaseBlockHash> } = { type: 'coded', code: error.code };
		if ('accounts' in error) {
			refusal.accounts = error.accounts.toArray().map(toCaseAccount).sort();
		}
		if ('blockhash' in error) {
			refusal.blockhash = toCaseBlockHash(error.blockhash);
			refusal.existingBlockhash = toCaseBlockHash(error.existingBlockhash);
		}
		return(refusal);
	}
	if (error instanceof Error) {
		return({ type: 'plain', message: error.message });
	}
	throw(new BrokenStep(`the ledger threw a non-error: ${String(error)}`));
}

function parseBlocks(blocks: readonly Base64[]): Block[] {
	return(blocks.map(function(block): Block {
		return(new lib.Block(base64Bytes(block)));
	}));
}

/** A literal supporting vote parses as a vote, a literal quote as a quote. */
function parseSupporting(supporting: SupportingVote, as: 'vote' | 'quote'): Produced {
	if ('produced' in supporting) {
		return(supporting.produced);
	}
	switch (as) {
		case 'vote':
			return(new lib.Vote(base64Bytes(supporting.bytes)));
		case 'quote':
			return(new lib.Vote.Quote(base64Bytes(supporting.bytes)));
		default:
			return(assertNever(as));
	}
}

/**
 * Executes one action against a network rebuilt from a case's seeds and
 * weights. Each representative's ledger has a driver of its own, created when
 * the representative first acts. Steps are numbered in the order they run,
 * and a step may reference the vote or quote of any earlier step.
 */
export class CaseRunner {
	readonly network: TestNetwork;
	readonly #setup: CaseSetup;
	readonly #createDriver: () => Promise<LedgerStorageDriverBase>;
	readonly #ledgers = new Map<number, Ledger>();
	readonly #produced: (Produced | null)[] = [];

	private constructor(network: TestNetwork, setup: CaseSetup, createDriver: () => Promise<LedgerStorageDriverBase>) {
		this.network = network;
		this.#setup = setup;
		this.#createDriver = createDriver;
	}

	/** The clock should be frozen first: the rebuilt network reads it. */
	static async start(setup: CaseSetup, createDriver: () => Promise<LedgerStorageDriverBase>): Promise<CaseRunner> {
		const { seeds, representativeWeights } = setup.network;
		const network = await createTestNetwork({ representativeWeights: representativeWeights.map(decimalValue), seeds });
		return(new CaseRunner(network, setup, createDriver));
	}

	/** The vote or quote that a step produced, if it produced one. */
	produced(step: number): Produced | null {
		return(this.#produced[step] ?? null);
	}

	representative(actor: number): Account {
		const representative = this.network.representatives[actor];
		if (representative === undefined) {
			throw(new BrokenStep(`there is no representative ${String(actor)}`));
		}
		return(representative);
	}

	async run(actor: number, action: CaseAction): Promise<StepResult> {
		let produced: Produced | null = null;
		let result: StepResult;
		try {
			const representative = this.representative(actor);
			const ledger = await this.#ledgerFor(actor, representative);
			const request = this.#resolve(action);
			const outcome = await this.#perform(ledger, request, representative);
			produced = outcome.produced;
			result = { kind: 'observed', observed: outcome.observed };
		} catch (error: unknown) {
			if (!(error instanceof BrokenStep)) {
				throw(error);
			}
			result = { kind: 'broken', reason: error.message };
		}
		this.#produced.push(produced);
		return(result);
	}

	async #ledgerFor(actor: number, representative: Account): Promise<Ledger> {
		const existing = this.#ledgers.get(actor);
		if (existing !== undefined) {
			return(existing);
		}
		const ledger = this.network.createLedger(await this.#createDriver(), representative, {
			fee: testFeePolicy(this.#setup.fee),
			ledgerWriteMode: this.#setup.mode
		});
		this.#ledgers.set(actor, ledger);
		return(ledger);
	}

	#supporting(reference: VoteReference): SupportingVote {
		if ('bytes' in reference) {
			return({ bytes: reference.bytes });
		}
		const produced = this.#produced[reference.fromStep];
		if (produced === undefined || produced === null) {
			throw(new BrokenStep(`step ${String(reference.fromStep)} produced no vote or quote to reference`));
		}
		return({ produced });
	}

	#resolve(action: CaseAction): LedgerRequest {
		switch (action.type) {
			case 'add':
			case 'quote':
			case 'gc':
				return(action);
			case 'vote': {
				const supporting = this.#supporting.bind(this);
				let quote: SupportingVote | undefined;
				if (action.quote !== undefined) {
					quote = supporting(action.quote);
				}
				return({ type: action.type, blocks: action.blocks, otherVotes: action.otherVotes?.map(supporting), quote });
			}
			default:
				return(assertNever(action));
		}
	}

	/** Decoding the request is part of the step: bytes that do not parse are refused like any other request. */
	async #perform(ledger: Ledger, request: LedgerRequest, actor: Account): Promise<{ readonly observed: CaseExpectation; readonly produced: Produced | null }> {
		try {
			switch (request.type) {
				case 'add':
					await ledger.add(new lib.Vote.Staple(base64Bytes(request.staple)));
					return({ observed: { outcome: 'added' }, produced: null });
				case 'vote': {
					const vote = await requestVote(ledger, request);
					return({ observed: observeVote(vote, actor), produced: vote });
				}
				case 'quote': {
					const quote = await ledger.quote(parseBlocks(request.blocks));
					return({ observed: observeQuote(quote, actor), produced: quote });
				}
				case 'gc':
					// Whether a pass finished depends on the driver's batching, so only completion is observed.
					await ledger.gc();
					return({ observed: { outcome: 'collected' }, produced: null });
				default:
					return(assertNever(request));
			}
		} catch (error: unknown) {
			if (error instanceof BrokenStep) {
				throw(error);
			}
			return({ observed: { outcome: 'refused', error: refusalOf(error) }, produced: null });
		}
	}
}

/*
 * Cases offer quotes as supporting votes, and votes as quotes, on purpose, to
 * pin how upstream refuses them; the typing of Ledger.vote admits neither, so
 * the call goes through Reflect.
 */
async function requestVote(ledger: Ledger, request: Extract<LedgerRequest, { type: 'vote' }>): Promise<Vote> {
	const otherVotes = request.otherVotes?.map(function(supporting): Produced {
		return(parseSupporting(supporting, 'vote'));
	});
	let quote: Produced | undefined;
	if (request.quote !== undefined) {
		quote = parseSupporting(request.quote, 'quote');
	}
	const vote: unknown = await Reflect.apply(ledger.vote.bind(ledger), undefined, [parseBlocks(request.blocks), otherVotes, quote]);
	if (!lib.Vote.isInstance(vote)) {
		throw(new BrokenStep('the ledger returned something other than a vote'));
	}
	return(vote);
}
