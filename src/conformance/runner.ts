import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger, LedgerConfig } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { FeeAmountAndToken, Vote, VoteQuote, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { createTestLedgerFactory, deriveTestKeys } from '../testing/network.js';
import type { TestFeeAmount, TestFeePolicy, TestKeys, TestLedgerFactory, TestLedgerOptions } from '../testing/network.js';
import { assertNever } from '../util/assert-never.js';
import { DRIVER_WRAPPING_CODE, base64Bytes, caseAccount, decimalValue, toCaseAccount, toCaseBlockHash, toDecimal } from './case.js';
import type {
	AddSource,
	Base64,
	CaseAccount,
	CaseAction,
	CaseBlockHash,
	CaseError,
	CaseExpectation,
	CaseFeeAmount,
	CaseFeePolicy,
	CaseNode,
	CaseNodeOperations,
	CaseSetRepPolicy,
	CaseVoteFee,
	StapleReference,
	VoteCase,
	VoteReference
} from './case.js';

const lib = KeetaNet.lib;

/** What a case needs to rebuild its network: everything but the steps. */
export type CaseSetup = Pick<VoteCase, 'network' | 'nodes'>;

/** What a step produced, as an expectation; or why the step could not be judged at all. */
export type StepResult =
	{ readonly kind: 'observed'; readonly observed: CaseExpectation } |
	{ readonly kind: 'broken'; readonly reason: string };

/** Bytes a step offers to later references, and how they parse. */
type Offered = { readonly kind: 'vote' | 'quote' | 'staple'; readonly bytes: Buffer };

/** An action with every reference resolved to bytes, nothing parsed yet. */
type ResolvedAction =
	{ readonly type: 'add'; readonly staple: Offered; readonly from: AddSource | undefined } |
	{ readonly type: 'vote'; readonly blocks: readonly Base64[]; readonly otherVotes: readonly Offered[] | undefined; readonly quote: Offered | undefined } |
	{ readonly type: 'quote'; readonly blocks: readonly Base64[] } |
	{ readonly type: 'gc' };

type SupportingVote = Vote | VoteQuote;

/** The request as the ledger receives it, every input parsed. */
type LedgerRequest =
	{ readonly type: 'add'; readonly staple: VoteStaple; readonly from: AddSource | undefined } |
	{ readonly type: 'vote'; readonly blocks: Block[]; readonly otherVotes: SupportingVote[] | undefined; readonly quote: SupportingVote | undefined } |
	{ readonly type: 'quote'; readonly blocks: Block[] } |
	{ readonly type: 'gc' };

type Performed = { readonly observed: CaseExpectation; readonly offered: Offered | null };

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

function testFeeAmount(fee: CaseFeeAmount): TestFeeAmount {
	const amount: { amount: bigint; token?: TokenAddress; payTo?: Account | StorageAddress } = { amount: decimalValue(fee.amount) };
	if (fee.token !== undefined) {
		amount.token = requireToken(caseAccount(fee.token), 'the fee token');
	}
	if (fee.payTo !== undefined) {
		amount.payTo = requirePayee(caseAccount(fee.payTo), 'the fee payee');
	}
	return(amount);
}

function testFeePolicy(fee: CaseFeePolicy): TestFeePolicy {
	switch (fee.type) {
		case 'free':
			return({ kind: 'free' });
		case 'flat':
			return({ kind: 'flat', ...testFeeAmount(fee) });
		case 'choices':
			return({ kind: 'choices', choices: fee.choices.map(testFeeAmount) });
		default:
			return(assertNever(fee));
	}
}

type LedgerOperations = NonNullable<LedgerConfig['operations']>;

/** Upstream's setRep hook answering every delegation the same way. */
function setRepHook(policy: CaseSetRepPolicy): NonNullable<LedgerOperations['setRep']> {
	let answer: boolean;
	switch (policy) {
		case 'allowAll':
			answer = true;
			break;
		case 'refuseAll':
			answer = false;
			break;
		default:
			return(assertNever(policy));
	}
	return(function() {
		return(Promise.resolve(answer));
	});
}

function ledgerOperations(operations: CaseNodeOperations): LedgerOperations {
	const settings: LedgerOperations = {};
	if (operations.enableTokenAdminModifyBalance !== undefined) {
		settings.enableTokenAdminModifyBalance = operations.enableTokenAdminModifyBalance;
	}
	if (operations.setRep !== undefined) {
		settings.setRep = setRepHook(operations.setRep);
	}
	return(settings);
}

function testLedgerOptions(node: CaseNode): TestLedgerOptions {
	const options: { -readonly [Key in keyof TestLedgerOptions]: TestLedgerOptions[Key] } = { fee: testFeePolicy(node.fee), ledgerWriteMode: node.mode };
	if (node.subnet !== undefined) {
		options.subnet = decimalValue(node.subnet);
	}
	if (node.operations !== undefined) {
		options.operations = ledgerOperations(node.operations);
	}
	return(options);
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

function voteFeeOf(fee: SupportingVote['fee']): CaseVoteFee {
	if (fee === undefined) {
		return({ type: 'none' });
	}
	if (Array.isArray(fee)) {
		return({ type: 'choices', choices: fee.map(feeAmountOf) });
	}
	return({ type: 'single', ...feeAmountOf(fee) });
}

function requireIssuer(issuer: Account, representative: Account | null, what: string): void {
	if (representative === null) {
		throw(new BrokenStep(`a node without a key produced a ${what}`));
	}
	if (!issuer.comparePublicKey(representative)) {
		throw(new BrokenStep(`the produced ${what} was issued by ${issuer.publicKeyString.get()}, not by the actor's representative`));
	}
}

/**
 * Re-parses what the ledger returned, which verifies the signature, and
 * checks that the actor's representative issued it.
 * [Keeta TS] index.js:81710-81715
 */
function observeVote(vote: Vote, representative: Account | null): Performed {
	let parsed: Vote;
	try {
		parsed = new lib.Vote(vote.toBytes());
	} catch (error: unknown) {
		throw(new BrokenStep(`the produced vote does not verify: ${messageOf(error)}`));
	}
	requireIssuer(parsed.issuer, representative, 'vote');
	let outcome: 'temporary' | 'permanent' = 'temporary';
	if (parsed.$permanent) {
		outcome = 'permanent';
	}
	return({
		observed: { outcome, blocks: parsed.blocks.map(toCaseBlockHash), fee: voteFeeOf(parsed.fee) },
		offered: { kind: 'vote', bytes: Buffer.from(vote.toBytes()) }
	});
}

function observeQuote(quote: VoteQuote, representative: Account | null): Performed {
	let parsed: VoteQuote;
	try {
		parsed = new lib.Vote.Quote(quote.toBytes());
	} catch (error: unknown) {
		throw(new BrokenStep(`the produced quote does not verify: ${messageOf(error)}`));
	}
	requireIssuer(parsed.issuer, representative, 'quote');
	return({
		observed: { outcome: 'quote', blocks: parsed.blocks.map(toCaseBlockHash), fee: voteFeeOf(parsed.fee) },
		offered: { kind: 'quote', bytes: Buffer.from(quote.toBytes()) }
	});
}

/**
 * Upstream's coded errors carry a code, and some also the accounts, or the
 * block hashes, that caused them; its other errors are instances of Error
 * itself. Any other class, such as a TypeError, is a fault, not a decision.
 */
function upstreamErrorOf(error: unknown): CaseError {
	if (lib.Error.isInstance(error)) {
		if (error.code === DRIVER_WRAPPING_CODE) {
			throw(new BrokenStep(`a ${DRIVER_WRAPPING_CODE} wraps another: ${error.message}`));
		}
		const coded: { type: 'coded'; code: typeof error.code; accounts?: CaseAccount[]; blockhash?: CaseBlockHash; existingBlockhash?: CaseBlockHash } = { type: 'coded', code: error.code };
		if ('accounts' in error) {
			coded.accounts = error.accounts.toArray().map(toCaseAccount).sort();
		}
		if ('blockhash' in error) {
			coded.blockhash = toCaseBlockHash(error.blockhash);
			coded.existingBlockhash = toCaseBlockHash(error.existingBlockhash);
		}
		return(coded);
	}
	if (error instanceof Error && error.constructor === Error) {
		return({ type: 'plain', message: error.message });
	}
	if (error instanceof Error) {
		throw(new BrokenStep(`the ledger threw a ${error.constructor.name}: ${error.message}`));
	}
	throw(new BrokenStep(`the ledger threw a non-error: ${String(error)}`));
}

/**
 * The error upstream raised, as a case records it. An error raised inside a
 * ledger transaction reaches the caller as the driver's evaluateError makes
 * it, and our drivers wrap anything without a KeetaNet code as LEDGER_OTHER
 * with the original as its cause. That wrapping is the driver's, so the
 * cause is recorded instead, and a wrapping without one is a fault.
 * [Keeta TS] index.js:71387
 */
export function caseErrorOf(error: unknown): CaseError {
	if (lib.Error.isInstance(error) && error.code === DRIVER_WRAPPING_CODE) {
		const cause: unknown = error.cause;
		if (cause === undefined) {
			throw(new BrokenStep(`a ${DRIVER_WRAPPING_CODE} without a cause: ${error.message}`));
		}
		return(upstreamErrorOf(cause));
	}
	return(upstreamErrorOf(error));
}

function parseBlocks(blocks: readonly Base64[]): Block[] {
	return(blocks.map(function(block): Block {
		return(new lib.Block(base64Bytes(block)));
	}));
}

/** Parses supporting bytes as the kind they carry; a staple has no place among supporting votes. */
function parseSupporting(offered: Offered): SupportingVote {
	switch (offered.kind) {
		case 'vote':
			return(new lib.Vote(offered.bytes));
		case 'quote':
			return(new lib.Vote.Quote(offered.bytes));
		case 'staple':
			throw(new BrokenStep('a staple cannot be offered as a vote or quote'));
		default:
			return(assertNever(offered.kind));
	}
}

function parseStaple(offered: Offered): VoteStaple {
	if (offered.kind !== 'staple') {
		throw(new BrokenStep(`a ${offered.kind} cannot be added as a staple`));
	}
	return(new lib.Vote.Staple(offered.bytes));
}

/**
 * Parsing happens at the step's moment, in a fixed order: the blocks, then
 * the other votes in order, then the quote, or the staple of an add.
 */
function parseRequest(action: ResolvedAction): LedgerRequest {
	switch (action.type) {
		case 'add':
			return({ type: action.type, staple: parseStaple(action.staple), from: action.from });
		case 'vote': {
			const blocks = parseBlocks(action.blocks);
			const otherVotes = action.otherVotes?.map(parseSupporting);
			let quote: SupportingVote | undefined;
			if (action.quote !== undefined) {
				quote = parseSupporting(action.quote);
			}
			return({ type: action.type, blocks, otherVotes, quote });
		}
		case 'quote':
			return({ type: action.type, blocks: parseBlocks(action.blocks) });
		case 'gc':
			return(action);
		default:
			return(assertNever(action));
	}
}

/*
 * Cases offer quotes as supporting votes, and votes as quotes, on purpose, to
 * pin how upstream refuses them; the typing of Ledger.vote admits neither, so
 * the call goes through Reflect.
 */
async function requestVote(ledger: Ledger, request: Extract<LedgerRequest, { type: 'vote' }>): Promise<Vote> {
	const vote: unknown = await Reflect.apply(ledger.vote.bind(ledger), undefined, [request.blocks, request.otherVotes, request.quote]);
	if (!lib.Vote.isInstance(vote)) {
		throw(new BrokenStep('the ledger returned something other than a vote'));
	}
	return(vote);
}

async function perform(ledger: Ledger, request: LedgerRequest, representative: Account | null): Promise<Performed> {
	switch (request.type) {
		case 'add':
			await ledger.add(request.staple, request.from);
			return({ observed: { outcome: 'added' }, offered: null });
		case 'vote':
			return(observeVote(await requestVote(ledger, request), representative));
		case 'quote':
			return(observeQuote(await ledger.quote(request.blocks), representative));
		case 'gc':
			// Whether a pass finished depends on the driver's batching, so only completion is observed.
			await ledger.gc();
			return({ observed: { outcome: 'collected' }, offered: null });
		default:
			return(assertNever(request));
	}
}

/**
 * Executes one action against a network rebuilt from a case's seeds alone:
 * the keys derive from the seeds, and each node's ledger has a driver of its
 * own, created when the node first acts. Steps are numbered in the order they
 * run, and a step may reference the bytes of any earlier step.
 */
export class CaseRunner {
	readonly #keys: TestKeys;
	readonly #factory: TestLedgerFactory;
	readonly #nodes: readonly CaseNode[];
	readonly #createDriver: () => Promise<LedgerStorageDriverBase>;
	readonly #ledgers = new Map<number, Ledger>();
	readonly #offered: (Offered | null)[] = [];

	constructor(setup: CaseSetup, createDriver: () => Promise<LedgerStorageDriverBase>) {
		this.#keys = deriveTestKeys(setup.network.seeds, setup.network.representativeWeights.length);
		this.#factory = createTestLedgerFactory(this.#keys.trustedRoot);
		this.#nodes = setup.nodes;
		this.#createDriver = createDriver;
	}

	async run(actor: number, action: CaseAction): Promise<StepResult> {
		let offered: Offered | null = null;
		let result: StepResult;
		try {
			const node = this.#node(actor);
			const representative = this.#representativeOf(node);
			const ledger = await this.#ledgerFor(actor, node, representative);
			const resolved = this.#resolve(action);
			if (resolved.type === 'add' && action.type === 'add' && action.staple.type === 'literal') {
				offered = resolved.staple;
			}
			const performed = await this.#attempt(ledger, resolved, representative);
			offered ??= performed.offered;
			result = { kind: 'observed', observed: performed.observed };
		} catch (error: unknown) {
			if (!(error instanceof BrokenStep)) {
				throw(error);
			}
			result = { kind: 'broken', reason: error.message };
		}
		this.#offered.push(offered);
		return(result);
	}

	async #attempt(ledger: Ledger, resolved: ResolvedAction, representative: Account | null): Promise<Performed> {
		let request: LedgerRequest;
		try {
			request = parseRequest(resolved);
		} catch (error: unknown) {
			if (error instanceof BrokenStep) {
				throw(error);
			}
			return({ observed: { outcome: 'rejectedInput', error: caseErrorOf(error) }, offered: null });
		}
		try {
			return(await perform(ledger, request, representative));
		} catch (error: unknown) {
			if (error instanceof BrokenStep) {
				throw(error);
			}
			return({ observed: { outcome: 'refused', error: caseErrorOf(error) }, offered: null });
		}
	}

	#node(actor: number): CaseNode {
		const node = this.#nodes[actor];
		if (node === undefined) {
			throw(new BrokenStep(`there is no node ${String(actor)}`));
		}
		return(node);
	}

	#representativeOf(node: CaseNode): Account | null {
		if (node.representative === null) {
			return(null);
		}
		const representative = this.#keys.representatives[node.representative];
		if (representative === undefined) {
			throw(new BrokenStep(`there is no representative ${String(node.representative)}`));
		}
		return(representative);
	}

	async #ledgerFor(actor: number, node: CaseNode, representative: Account | null): Promise<Ledger> {
		const existing = this.#ledgers.get(actor);
		if (existing !== undefined) {
			return(existing);
		}
		const options = testLedgerOptions(node);
		const storage = await this.#createDriver();
		let ledger: Ledger;
		if (representative === null) {
			ledger = this.#factory.createAccountLedger(storage, options);
		} else {
			ledger = this.#factory.createLedger(storage, representative, options);
		}
		this.#ledgers.set(actor, ledger);
		return(ledger);
	}

	#fromStep(fromStep: number): Offered {
		const offered = this.#offered[fromStep];
		if (offered === undefined || offered === null) {
			throw(new BrokenStep(`step ${String(fromStep)} offers no bytes to reference`));
		}
		return(offered);
	}

	#bytesOf(reference: VoteReference | StapleReference): Offered {
		switch (reference.type) {
			case 'literal':
				return({ kind: reference.kind, bytes: base64Bytes(reference.bytes) });
			case 'step':
				return(this.#fromStep(reference.fromStep));
			default:
				return(assertNever(reference));
		}
	}

	#resolve(action: CaseAction): ResolvedAction {
		switch (action.type) {
			case 'add':
				return({ type: action.type, staple: this.#bytesOf(action.staple), from: action.from });
			case 'vote': {
				const bytesOf = this.#bytesOf.bind(this);
				let quote: Offered | undefined;
				if (action.quote !== undefined) {
					quote = bytesOf(action.quote);
				}
				return({ type: action.type, blocks: action.blocks, otherVotes: action.otherVotes?.map(bytesOf), quote });
			}
			case 'quote':
			case 'gc':
				return(action);
			default:
				return(assertNever(action));
		}
	}
}
