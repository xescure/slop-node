import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { ErrorCode } from '@keetanetwork/keetanet-client/lib/error/index.js';
import type { Ledger, LedgerConfig } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import { assertNever } from '../util/assert-never.js';

/*
 * The one owner of the JSON form of the vote-decision corpus. Every value
 * that has a textual encoding is a brand made by exactly one function here,
 * so encoding is a matter of key order and decoding validates each value
 * through the same function.
 */

const lib = KeetaNet.lib;

export const VOTE_CASE_FORMAT = 'slop-node/vote-cases@1';

/** Canonical base64 of the canonical bytes of a block, vote, quote or staple. */
export type Base64 = string & { readonly __base64: never };

/** A non-negative integer in decimal, without leading zeros. */
export type Decimal = string & { readonly __decimal: never };

/** An ISO-8601 UTC moment with milliseconds, as Date.prototype.toISOString prints it. */
export type Moment = string & { readonly __moment: never };

/** A 32-byte key seed in lowercase hex. */
export type CaseSeed = string & { readonly __caseSeed: never };

/** An account's public key string, `keeta_...`. */
export type CaseAccount = string & { readonly __caseAccount: never };

/** A block hash as upstream prints it: uppercase hex. */
export type CaseBlockHash = ReturnType<BlockHash['toString']>;

export type CaseLedgerMode = NonNullable<LedgerConfig['ledgerWriteMode']>;

/**
 * The code our storage drivers give an error that has none, keeping the
 * original as its cause. Cases record the cause, so this code never appears.
 */
export const DRIVER_WRAPPING_CODE: Extract<ErrorCode, 'LEDGER_OTHER'> = 'LEDGER_OTHER';

/** Where a staple comes from, as Ledger.add takes it; bootstrap-only ledgers accept only 'bootstrap'. */
export type AddSource = NonNullable<Parameters<Ledger['add']>[1]>;

/**
 * Representative and user i are the secp256k1 keys of their seed at index i,
 * the trusted root the key of its seed at index 0. Representative i is the
 * delegate of user i, who holds the representative's weight.
 */
export type CaseNetwork = {
	readonly id: '0';
	readonly seeds: {
		readonly trustedRoot: CaseSeed;
		readonly representative: CaseSeed;
		readonly user: CaseSeed;
	};
	readonly representativeWeights: readonly Decimal[];
};

/** A flat fee without a token is in the base token, and without a payee is paid to the voter. */
export type CaseFeePolicy =
	{ readonly type: 'free' } |
	{ readonly type: 'flat'; readonly amount: Decimal; readonly token?: CaseAccount; readonly payTo?: CaseAccount };

/**
 * One node of the case: a representative's, or with a null representative
 * one that holds no key. A representative runs at most one node, so the
 * issuer of a vote names the node that produced it.
 */
export type CaseNode = {
	readonly representative: number | null;
	readonly fee: CaseFeePolicy;
	readonly mode: CaseLedgerMode;
};

/**
 * A reference always means bytes: literal bytes of the stated kind, or the
 * bytes an earlier step produced, of the kind that step implies. The bytes
 * are parsed at the referencing step's moment. In JSON a literal is
 * `{kind, bytes}` and a step reference `{fromStep}`.
 */
export type StepReference = { readonly type: 'step'; readonly fromStep: number };

export type VoteReference = { readonly type: 'literal'; readonly kind: 'vote' | 'quote'; readonly bytes: Base64 } | StepReference;

/** A staple given literally, or the literal staple of an earlier add step; references do not chain. */
export type StapleReference = { readonly type: 'literal'; readonly kind: 'staple'; readonly bytes: Base64 } | StepReference;

/** An absent list of other votes differs from an empty one: upstream treats them differently. */
export type CaseAction =
	{ readonly type: 'add'; readonly staple: StapleReference; readonly from?: AddSource } |
	{ readonly type: 'vote'; readonly blocks: readonly Base64[]; readonly otherVotes?: readonly VoteReference[]; readonly quote?: VoteReference } |
	{ readonly type: 'quote'; readonly blocks: readonly Base64[] } |
	{ readonly type: 'gc' };

export type CaseFeeAmount = {
	readonly amount: Decimal;
	readonly token?: CaseAccount;
	readonly payTo?: CaseAccount;
};

/** The fee a vote or quote carries: none, one amount, or a list of choices. */
export type CaseVoteFee =
	{ readonly type: 'none' } |
	({ readonly type: 'single' } & CaseFeeAmount) |
	{ readonly type: 'choices'; readonly choices: readonly CaseFeeAmount[] };

/**
 * A coded error is matched on its code and on the fields upstream attaches
 * to it; a plain one, an instance of Error itself, on its exact message.
 */
export type CaseError =
	{
		readonly type: 'coded';
		readonly code: ErrorCode;
		readonly accounts?: readonly CaseAccount[];
		readonly blockhash?: CaseBlockHash;
		readonly existingBlockhash?: CaseBlockHash;
	} |
	{ readonly type: 'plain'; readonly message: string };

export type ProducedOutcome = 'temporary' | 'permanent' | 'quote';

/**
 * A produced vote or quote is pinned by the blocks it covers, its permanence
 * and its fee; its issuer is the actor's representative. Serials and
 * signatures are never pinned. Input bytes that do not parse are rejected
 * before the ledger sees the request; a request the ledger turns down is
 * refused.
 */
export type CaseExpectation =
	{ readonly outcome: 'added' } |
	{ readonly outcome: 'collected' } |
	{ readonly outcome: ProducedOutcome; readonly blocks: readonly CaseBlockHash[]; readonly fee: CaseVoteFee } |
	{ readonly outcome: 'rejectedInput'; readonly error: CaseError } |
	{ readonly outcome: 'refused'; readonly error: CaseError };

export type CaseStep = {
	readonly moment: Moment;
	readonly actor: number;
	readonly action: CaseAction;
	readonly expect: CaseExpectation;
};

export type VoteCase = {
	readonly id: string;
	readonly title: string;
	readonly network: CaseNetwork;
	readonly nodes: readonly CaseNode[];
	readonly steps: readonly CaseStep[];
};

export type VoteCaseFile = {
	readonly format: typeof VOTE_CASE_FORMAT;
	readonly keetanetClient: string;
	readonly cases: readonly VoteCase[];
};

const LEDGER_MODES = {
	'read-write': true,
	'no-voting': true,
	'bootstrap-only': true,
	'read-only': true
} satisfies Record<CaseLedgerMode, true>;

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SEED_PATTERN = /^[0-9a-f]{64}$/;
const BLOCK_HASH_PATTERN = /^[0-9A-F]{64}$/;
const MOMENT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

class CaseFormatError extends Error {
	constructor(path: string, problem: string) {
		super(`${path}: ${problem}`);
		this.name = 'CaseFormatError';
	}
}

/* Brands. Each validates its input, so a decoded value and a produced one are alike. */

export function toBase64(bytes: ArrayBuffer | Uint8Array): Base64 {
	// The brand marks the canonical encoding that Buffer prints.
	return(Buffer.from(new Uint8Array(bytes)).toString('base64') as Base64);
}

export function base64Bytes(value: Base64): Buffer {
	return(Buffer.from(value, 'base64'));
}

export function toDecimal(value: bigint): Decimal {
	if (value < 0n) {
		throw(new Error(`a decimal is never negative: ${value.toString()}`));
	}
	// The brand marks the canonical decimal that bigint prints.
	return(value.toString() as Decimal);
}

export function decimalValue(value: Decimal): bigint {
	return(BigInt(value));
}

export function toMoment(moment: Date): Moment {
	// The brand marks the form that toISOString prints.
	return(moment.toISOString() as Moment);
}

export function momentDate(moment: Moment): Date {
	return(new Date(moment));
}

export function toCaseSeed(seed: string): CaseSeed {
	if (!SEED_PATTERN.test(seed)) {
		throw(new Error(`a seed is 32 bytes of lowercase hex: ${seed}`));
	}
	// The pattern above is the brand's definition.
	return(seed as CaseSeed);
}

export function toCaseAccount(account: GenericAccount): CaseAccount {
	// The brand marks the canonical form that publicKeyString prints.
	return(account.publicKeyString.get() as CaseAccount);
}

export function caseAccount(value: CaseAccount): GenericAccount {
	return(lib.Account.fromPublicKeyString(value));
}

export function toCaseBlockHash(hash: BlockHash): CaseBlockHash {
	return(hash.toString());
}

/* Encoding. Objects are built field by field, so key order never depends on the input. */

type JSONValue = string | number | null | readonly JSONValue[] | { readonly [key: string]: JSONValue };

type JSONObject = { [key: string]: JSONValue };

function encodeFeeAmount(fee: CaseFeeAmount, into: JSONObject): JSONObject {
	into['amount'] = fee.amount;
	if (fee.token !== undefined) {
		into['token'] = fee.token;
	}
	if (fee.payTo !== undefined) {
		into['payTo'] = fee.payTo;
	}
	return(into);
}

function encodeFeePolicy(fee: CaseFeePolicy): JSONObject {
	switch (fee.type) {
		case 'free':
			return({ type: fee.type });
		case 'flat':
			return(encodeFeeAmount(fee, { type: fee.type }));
		default:
			return(assertNever(fee));
	}
}

function encodeVoteFee(fee: CaseVoteFee): JSONObject {
	switch (fee.type) {
		case 'none':
			return({ type: fee.type });
		case 'single':
			return(encodeFeeAmount(fee, { type: fee.type }));
		case 'choices':
			return({
				type: fee.type,
				choices: fee.choices.map(function(choice): JSONObject {
					return(encodeFeeAmount(choice, {}));
				})
			});
		default:
			return(assertNever(fee));
	}
}

function encodeReference(reference: VoteReference | StapleReference): JSONObject {
	switch (reference.type) {
		case 'literal':
			return({ kind: reference.kind, bytes: reference.bytes });
		case 'step':
			return({ fromStep: reference.fromStep });
		default:
			return(assertNever(reference));
	}
}

function encodeAction(action: CaseAction): JSONObject {
	switch (action.type) {
		case 'add': {
			const encoded: JSONObject = { type: action.type, staple: encodeReference(action.staple) };
			if (action.from !== undefined) {
				encoded['from'] = action.from;
			}
			return(encoded);
		}
		case 'vote': {
			const encoded: JSONObject = { type: action.type, blocks: [...action.blocks] };
			if (action.otherVotes !== undefined) {
				encoded['otherVotes'] = action.otherVotes.map(encodeReference);
			}
			if (action.quote !== undefined) {
				encoded['quote'] = encodeReference(action.quote);
			}
			return(encoded);
		}
		case 'quote':
			return({ type: action.type, blocks: [...action.blocks] });
		case 'gc':
			return({ type: action.type });
		default:
			return(assertNever(action));
	}
}

function encodeError(error: CaseError): JSONObject {
	switch (error.type) {
		case 'coded': {
			const encoded: JSONObject = { type: error.type, code: error.code };
			if (error.accounts !== undefined) {
				encoded['accounts'] = [...error.accounts];
			}
			if (error.blockhash !== undefined) {
				encoded['blockhash'] = error.blockhash;
			}
			if (error.existingBlockhash !== undefined) {
				encoded['existingBlockhash'] = error.existingBlockhash;
			}
			return(encoded);
		}
		case 'plain':
			return({ type: error.type, message: error.message });
		default:
			return(assertNever(error));
	}
}

function encodeExpectation(expectation: CaseExpectation): JSONObject {
	switch (expectation.outcome) {
		case 'added':
		case 'collected':
			return({ outcome: expectation.outcome });
		case 'temporary':
		case 'permanent':
		case 'quote':
			return({ outcome: expectation.outcome, blocks: [...expectation.blocks], fee: encodeVoteFee(expectation.fee) });
		case 'rejectedInput':
		case 'refused':
			return({ outcome: expectation.outcome, error: encodeError(expectation.error) });
		default:
			return(assertNever(expectation));
	}
}

function encodeStep(step: CaseStep): JSONObject {
	return({
		moment: step.moment,
		actor: step.actor,
		action: encodeAction(step.action),
		expect: encodeExpectation(step.expect)
	});
}

function encodeCase(voteCase: VoteCase): JSONObject {
	const { network } = voteCase;
	return({
		id: voteCase.id,
		title: voteCase.title,
		network: {
			id: network.id,
			seeds: {
				trustedRoot: network.seeds.trustedRoot,
				representative: network.seeds.representative,
				user: network.seeds.user
			},
			representativeWeights: [...network.representativeWeights]
		},
		nodes: voteCase.nodes.map(function(node): JSONObject {
			return({ representative: node.representative, fee: encodeFeePolicy(node.fee), mode: node.mode });
		}),
		steps: voteCase.steps.map(encodeStep)
	});
}

/** Stable key order, two-space indentation and a trailing newline, so equal files are equal bytes. */
export function encodeVoteCaseFile(file: VoteCaseFile): string {
	const encoded: JSONObject = {
		format: file.format,
		keetanetClient: file.keetanetClient,
		cases: file.cases.map(encodeCase)
	};
	return(`${JSON.stringify(encoded, null, 2)}\n`);
}

/* Decoding. Anything the format does not define is an error naming its path. */

type Fields = {
	readonly path: string;
	get(key: string): unknown;
	has(key: string): boolean;
	at(key: string): string;
};

function readObject(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Fields {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw(new CaseFormatError(path, 'expected an object'));
	}
	for (const key of Object.keys(value)) {
		if (!required.includes(key) && !optional.includes(key)) {
			throw(new CaseFormatError(`${path}.${key}`, 'unexpected field'));
		}
	}
	for (const key of required) {
		if (!Object.hasOwn(value, key)) {
			throw(new CaseFormatError(`${path}.${key}`, 'missing field'));
		}
	}
	return({
		path,
		get(key) {
			const field: unknown = Reflect.get(value, key);
			return(field);
		},
		has(key) {
			return(Object.hasOwn(value, key));
		},
		at(key) {
			return(`${path}.${key}`);
		}
	});
}

function readArray<Item>(value: unknown, path: string, readItem: (item: unknown, itemPath: string, index: number) => Item): Item[] {
	if (!Array.isArray(value)) {
		throw(new CaseFormatError(path, 'expected an array'));
	}
	const items: unknown[] = value;
	return(items.map(function(item, index): Item {
		return(readItem(item, `${path}[${String(index)}]`, index));
	}));
}

function readString(value: unknown, path: string): string {
	if (typeof value !== 'string') {
		throw(new CaseFormatError(path, 'expected a string'));
	}
	return(value);
}

function readNonEmptyString(value: unknown, path: string): string {
	const text = readString(value, path);
	if (text.length === 0) {
		throw(new CaseFormatError(path, 'expected a non-empty string'));
	}
	return(text);
}

function readChoice<Choice extends string>(value: unknown, path: string, choices: Record<Choice, true>): Choice {
	const text = readString(value, path);
	if (!Object.hasOwn(choices, text)) {
		throw(new CaseFormatError(path, `unknown value ${JSON.stringify(text)}`));
	}
	// The own-property check above proves that the text is one of the choices.
	return(text as Choice);
}

function readBase64(value: unknown, path: string): Base64 {
	const text = readString(value, path);
	if (toBase64(Buffer.from(text, 'base64')) !== text) {
		throw(new CaseFormatError(path, 'expected canonical base64'));
	}
	// The round trip above proves the canonical form.
	return(text as Base64);
}

function readDecimal(value: unknown, path: string): Decimal {
	const text = readString(value, path);
	if (!DECIMAL_PATTERN.test(text)) {
		throw(new CaseFormatError(path, 'expected a decimal integer'));
	}
	return(toDecimal(BigInt(text)));
}

function readWeight(value: unknown, path: string): Decimal {
	const weight = readDecimal(value, path);
	if (decimalValue(weight) === 0n) {
		throw(new CaseFormatError(path, 'expected a positive weight'));
	}
	return(weight);
}

function readMoment(value: unknown, path: string): Moment {
	const text = readString(value, path);
	const moment = new Date(text);
	if (!MOMENT_PATTERN.test(text) || Number.isNaN(moment.getTime()) || moment.toISOString() !== text) {
		throw(new CaseFormatError(path, 'expected an ISO-8601 UTC moment with milliseconds'));
	}
	return(toMoment(moment));
}

function readSeed(value: unknown, path: string): CaseSeed {
	const text = readString(value, path);
	if (!SEED_PATTERN.test(text)) {
		throw(new CaseFormatError(path, 'expected 32 bytes of lowercase hex'));
	}
	return(toCaseSeed(text));
}

function readAccount(value: unknown, path: string): CaseAccount {
	const text = readString(value, path);
	let account: GenericAccount;
	try {
		account = lib.Account.fromPublicKeyString(text);
	} catch {
		throw(new CaseFormatError(path, 'expected a keeta_ account'));
	}
	const canonical = toCaseAccount(account);
	if (canonical !== text) {
		throw(new CaseFormatError(path, 'expected a keeta_ account in canonical form'));
	}
	return(canonical);
}

function readBlockHash(value: unknown, path: string): CaseBlockHash {
	const text = readString(value, path);
	if (!BLOCK_HASH_PATTERN.test(text)) {
		throw(new CaseFormatError(path, 'expected an uppercase hex block hash'));
	}
	return(toCaseBlockHash(new lib.Block.Hash(text)));
}

function readErrorCode(value: unknown, path: string): ErrorCode {
	const text = readString(value, path);
	if (!lib.Error.isValidErrorCode(text)) {
		throw(new CaseFormatError(path, `unknown error code ${JSON.stringify(text)}`));
	}
	return(text);
}

function readIndex(value: unknown, path: string, below: number, problem: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= below) {
		throw(new CaseFormatError(path, problem));
	}
	return(value);
}

function readFeeAmount(fields: Fields): CaseFeeAmount {
	const amount = readDecimal(fields.get('amount'), fields.at('amount'));
	const fee: { amount: Decimal; token?: CaseAccount; payTo?: CaseAccount } = { amount };
	if (fields.has('token')) {
		fee.token = readAccount(fields.get('token'), fields.at('token'));
	}
	if (fields.has('payTo')) {
		fee.payTo = readAccount(fields.get('payTo'), fields.at('payTo'));
	}
	return(fee);
}

function readFeePolicy(value: unknown, path: string): CaseFeePolicy {
	const type = readChoice(readObject(value, path, ['type'], ['amount', 'token', 'payTo']).get('type'), `${path}.type`, { free: true, flat: true });
	switch (type) {
		case 'free':
			readObject(value, path, ['type']);
			return({ type });
		case 'flat':
			return({ type, ...readFeeAmount(readObject(value, path, ['type', 'amount'], ['token', 'payTo'])) });
		default:
			return(assertNever(type));
	}
}

function readVoteFee(value: unknown, path: string): CaseVoteFee {
	const type = readChoice(readObject(value, path, ['type'], ['amount', 'token', 'payTo', 'choices']).get('type'), `${path}.type`, { none: true, single: true, choices: true });
	switch (type) {
		case 'none':
			readObject(value, path, ['type']);
			return({ type });
		case 'single':
			return({ type, ...readFeeAmount(readObject(value, path, ['type', 'amount'], ['token', 'payTo'])) });
		case 'choices': {
			const fields = readObject(value, path, ['type', 'choices']);
			return({
				type,
				choices: readArray(fields.get('choices'), fields.at('choices'), function(choice, choicePath): CaseFeeAmount {
					return(readFeeAmount(readObject(choice, choicePath, ['amount'], ['token', 'payTo'])));
				})
			});
		}
		default:
			return(assertNever(type));
	}
}

/** What each earlier step offers to references: the bytes it produced or carried, by kind. */
type ReferenceKind = 'vote' | 'quote' | 'staple';
type Producers = ReadonlyMap<number, ReferenceKind>;

/** The kind of bytes a step offers to later references, if any. */
function offeredBy(step: CaseStep): ReferenceKind | null {
	switch (step.expect.outcome) {
		case 'temporary':
		case 'permanent':
			return('vote');
		case 'quote':
			return('quote');
		case 'added':
		case 'collected':
		case 'rejectedInput':
		case 'refused':
			break;
		default:
			return(assertNever(step.expect));
	}
	// An add step offers the staple it carries literally, whatever its outcome; references do not chain.
	if (step.action.type === 'add' && step.action.staple.type === 'literal') {
		return('staple');
	}
	return(null);
}

function readStepReference(fields: Fields, producers: Producers, accepted: readonly ReferenceKind[], expected: string): StepReference {
	const fromStep = fields.get('fromStep');
	if (typeof fromStep !== 'number') {
		throw(new CaseFormatError(fields.at('fromStep'), expected));
	}
	const offered = producers.get(fromStep);
	if (offered === undefined || !accepted.includes(offered)) {
		throw(new CaseFormatError(fields.at('fromStep'), expected));
	}
	return({ type: 'step', fromStep });
}

function readVoteReference(value: unknown, path: string, producers: Producers): VoteReference {
	const fields = readObject(value, path, [], ['kind', 'bytes', 'fromStep']);
	if (fields.has('fromStep')) {
		readObject(value, path, ['fromStep']);
		return(readStepReference(fields, producers, ['vote', 'quote'], 'expected an earlier step that produced a vote or quote'));
	}
	readObject(value, path, ['kind', 'bytes']);
	return({
		type: 'literal',
		kind: readChoice(fields.get('kind'), fields.at('kind'), { vote: true, quote: true }),
		bytes: readBase64(fields.get('bytes'), fields.at('bytes'))
	});
}

function readStapleReference(value: unknown, path: string, producers: Producers): StapleReference {
	const fields = readObject(value, path, [], ['kind', 'bytes', 'fromStep']);
	if (fields.has('fromStep')) {
		readObject(value, path, ['fromStep']);
		return(readStepReference(fields, producers, ['staple'], 'expected an earlier add step that carries its staple'));
	}
	readObject(value, path, ['kind', 'bytes']);
	return({
		type: 'literal',
		kind: readChoice(fields.get('kind'), fields.at('kind'), { staple: true }),
		bytes: readBase64(fields.get('bytes'), fields.at('bytes'))
	});
}

function readBlocks(fields: Fields): Base64[] {
	return(readArray(fields.get('blocks'), fields.at('blocks'), readBase64));
}

function readAction(value: unknown, path: string, producers: Producers): CaseAction {
	const type = readChoice(readObject(value, path, ['type'], ['staple', 'from', 'blocks', 'otherVotes', 'quote']).get('type'), `${path}.type`, { add: true, vote: true, quote: true, gc: true });
	switch (type) {
		case 'add': {
			const fields = readObject(value, path, ['type', 'staple'], ['from']);
			const action: { type: 'add'; staple: StapleReference; from?: AddSource } = { type, staple: readStapleReference(fields.get('staple'), fields.at('staple'), producers) };
			if (fields.has('from')) {
				action.from = readString(fields.get('from'), fields.at('from'));
			}
			return(action);
		}
		case 'vote': {
			const fields = readObject(value, path, ['type', 'blocks'], ['otherVotes', 'quote']);
			const action: { type: 'vote'; blocks: Base64[]; otherVotes?: VoteReference[]; quote?: VoteReference } = { type, blocks: readBlocks(fields) };
			if (fields.has('otherVotes')) {
				action.otherVotes = readArray(fields.get('otherVotes'), fields.at('otherVotes'), function(reference, referencePath): VoteReference {
					return(readVoteReference(reference, referencePath, producers));
				});
			}
			if (fields.has('quote')) {
				action.quote = readVoteReference(fields.get('quote'), fields.at('quote'), producers);
			}
			return(action);
		}
		case 'quote':
			return({ type, blocks: readBlocks(readObject(value, path, ['type', 'blocks'])) });
		case 'gc':
			readObject(value, path, ['type']);
			return({ type });
		default:
			return(assertNever(type));
	}
}

function readError(value: unknown, path: string): CaseError {
	const type = readChoice(readObject(value, path, ['type'], ['code', 'accounts', 'blockhash', 'existingBlockhash', 'message']).get('type'), `${path}.type`, { coded: true, plain: true });
	switch (type) {
		case 'coded': {
			const fields = readObject(value, path, ['type', 'code'], ['accounts', 'blockhash', 'existingBlockhash']);
			const error: { type: 'coded'; code: ErrorCode; accounts?: CaseAccount[]; blockhash?: CaseBlockHash; existingBlockhash?: CaseBlockHash } = {
				type,
				code: readErrorCode(fields.get('code'), fields.at('code'))
			};
			if (error.code === DRIVER_WRAPPING_CODE) {
				throw(new CaseFormatError(fields.at('code'), `${DRIVER_WRAPPING_CODE} is a driver's wrapping; record its cause`));
			}
			if (fields.has('accounts')) {
				error.accounts = readArray(fields.get('accounts'), fields.at('accounts'), readAccount);
			}
			if (fields.has('blockhash')) {
				error.blockhash = readBlockHash(fields.get('blockhash'), fields.at('blockhash'));
			}
			if (fields.has('existingBlockhash')) {
				error.existingBlockhash = readBlockHash(fields.get('existingBlockhash'), fields.at('existingBlockhash'));
			}
			return(error);
		}
		case 'plain': {
			const fields = readObject(value, path, ['type', 'message']);
			return({ type, message: readString(fields.get('message'), fields.at('message')) });
		}
		default:
			return(assertNever(type));
	}
}

function readExpectation(value: unknown, path: string): CaseExpectation {
	const outcome = readChoice(readObject(value, path, ['outcome'], ['blocks', 'fee', 'error']).get('outcome'), `${path}.outcome`, {
		added: true,
		collected: true,
		temporary: true,
		permanent: true,
		quote: true,
		rejectedInput: true,
		refused: true
	});
	switch (outcome) {
		case 'added':
		case 'collected':
			readObject(value, path, ['outcome']);
			return({ outcome });
		case 'temporary':
		case 'permanent':
		case 'quote': {
			const fields = readObject(value, path, ['outcome', 'blocks', 'fee']);
			return({
				outcome,
				blocks: readArray(fields.get('blocks'), fields.at('blocks'), readBlockHash),
				fee: readVoteFee(fields.get('fee'), fields.at('fee'))
			});
		}
		case 'rejectedInput':
		case 'refused': {
			const fields = readObject(value, path, ['outcome', 'error']);
			return({ outcome, error: readError(fields.get('error'), fields.at('error')) });
		}
		default:
			return(assertNever(outcome));
	}
}

function readNetwork(value: unknown, path: string): CaseNetwork {
	const fields = readObject(value, path, ['id', 'seeds', 'representativeWeights']);
	if (fields.get('id') !== '0') {
		throw(new CaseFormatError(fields.at('id'), 'expected "0"'));
	}
	const seeds = readObject(fields.get('seeds'), fields.at('seeds'), ['trustedRoot', 'representative', 'user']);
	const representativeWeights = readArray(fields.get('representativeWeights'), fields.at('representativeWeights'), readWeight);
	if (representativeWeights.length === 0) {
		throw(new CaseFormatError(fields.at('representativeWeights'), 'expected at least one representative'));
	}
	return({
		id: '0',
		seeds: {
			trustedRoot: readSeed(seeds.get('trustedRoot'), seeds.at('trustedRoot')),
			representative: readSeed(seeds.get('representative'), seeds.at('representative')),
			user: readSeed(seeds.get('user'), seeds.at('user'))
		},
		representativeWeights
	});
}

function readNodes(value: unknown, path: string, representatives: number): CaseNode[] {
	const running = new Set<number>();
	const nodes = readArray(value, path, function(item, nodePath): CaseNode {
		const fields = readObject(item, nodePath, ['representative', 'fee', 'mode']);
		let representative: number | null = null;
		if (fields.get('representative') !== null) {
			representative = readIndex(fields.get('representative'), fields.at('representative'), representatives, `expected null or a representative index below ${String(representatives)}`);
			if (running.has(representative)) {
				throw(new CaseFormatError(fields.at('representative'), `representative ${String(representative)} already runs a node`));
			}
			running.add(representative);
		}
		return({
			representative,
			fee: readFeePolicy(fields.get('fee'), fields.at('fee')),
			mode: readChoice(fields.get('mode'), fields.at('mode'), LEDGER_MODES)
		});
	});
	if (nodes.length === 0) {
		throw(new CaseFormatError(path, 'expected at least one node'));
	}
	return(nodes);
}

function readSteps(value: unknown, path: string, nodes: number): CaseStep[] {
	const producers = new Map<number, ReferenceKind>();
	return(readArray(value, path, function(item, stepPath, index): CaseStep {
		const fields = readObject(item, stepPath, ['moment', 'actor', 'action', 'expect']);
		const step: CaseStep = {
			moment: readMoment(fields.get('moment'), fields.at('moment')),
			actor: readIndex(fields.get('actor'), fields.at('actor'), nodes, `expected a node index below ${String(nodes)}`),
			action: readAction(fields.get('action'), fields.at('action'), producers),
			expect: readExpectation(fields.get('expect'), fields.at('expect'))
		};
		const offered = offeredBy(step);
		if (offered !== null) {
			producers.set(index, offered);
		}
		return(step);
	}));
}

function readCase(value: unknown, path: string): VoteCase {
	const fields = readObject(value, path, ['id', 'title', 'network', 'nodes', 'steps']);
	const network = readNetwork(fields.get('network'), fields.at('network'));
	const nodes = readNodes(fields.get('nodes'), fields.at('nodes'), network.representativeWeights.length);
	return({
		id: readNonEmptyString(fields.get('id'), fields.at('id')),
		title: readNonEmptyString(fields.get('title'), fields.at('title')),
		network,
		nodes,
		steps: readSteps(fields.get('steps'), fields.at('steps'), nodes.length)
	});
}

/** Validates the whole structure and throws, naming the path, on anything the format does not define. */
export function decodeVoteCaseFile(text: string): VoteCaseFile {
	const path = 'cases file';
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw(new CaseFormatError(path, 'not JSON'));
	}
	const fields = readObject(parsed, path, ['format', 'keetanetClient', 'cases']);
	if (fields.get('format') !== VOTE_CASE_FORMAT) {
		throw(new CaseFormatError(fields.at('format'), `expected ${JSON.stringify(VOTE_CASE_FORMAT)}`));
	}
	const keetanetClient = readString(fields.get('keetanetClient'), fields.at('keetanetClient'));
	if (!VERSION_PATTERN.test(keetanetClient)) {
		throw(new CaseFormatError(fields.at('keetanetClient'), 'expected an exact version'));
	}
	const seen = new Set<string>();
	const cases = readArray(fields.get('cases'), fields.at('cases'), function(item, casePath): VoteCase {
		const voteCase = readCase(item, casePath);
		if (seen.has(voteCase.id)) {
			throw(new CaseFormatError(`${casePath}.id`, `duplicate case ${JSON.stringify(voteCase.id)}`));
		}
		seen.add(voteCase.id);
		return(voteCase);
	});
	return({ format: VOTE_CASE_FORMAT, keetanetClient, cases });
}
