import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { normalizedAll } from '../conformance/api/normalize.js';
import type { Normalization } from '../conformance/api/normalize.js';
import { assertNever } from '../util/assert-never.js';
import type { APIAnswer, APISource } from './api-source.js';
import type { AccountCandidate, FollowerStore, HeldBlock } from './follower-store.js';
import type { APIDiffOutcome, APIDiffPlanRecord, APIDiffReading, APIDiffRecord, ParityLog, RepresentativeReading, StratumPopulation } from './log.js';
import { ACCOUNT_KINDS, OPERATION_NAMES, operationStratum, STRATA } from './strata.js';
import type { OperationName, Stratum } from './strata.js';
import { disputedKindOf, firstDifference, newestStapleOf, QUIET_MARGIN_MILLISECONDS } from './sweep.js';

const lib = KeetaNet.lib;

/** Whether the API diff samples a GET route, and how its answers are normalized, or why it leaves the route out. */
export type RouteUse =
	| { readonly kind: 'sampled'; readonly normalize: readonly Normalization[] }
	| { readonly kind: 'excluded'; readonly why: string };

/** Any route may fail with an internal error, which only an error ID names. */
const SAMPLED: RouteUse = { kind: 'sampled', normalize: ['error-id'] };

/** A history entry is timed by the node's own vote, and its staple's compression is the node's. */
const SAMPLED_HISTORY: RouteUse = { kind: 'sampled', normalize: ['error-id', 'staple-time', 'staple-encoding'] };

function excluded(why: string): RouteUse {
	return({ kind: 'excluded', why });
}

const NODE_LOCAL = 'the answer describes the node that serves it (conformance/API.md, Differences)';

/**
 * Every GET route of api/openapi.json. A route is sampled when two nodes
 * holding the same ledger must answer it alike, given that the accounts it
 * reads are quiet.
 */
export type RoutePath =
	| '/api/vote/{blockhash}'
	| '/api/node/peers'
	| '/api/node/stats'
	| '/api/node/version'
	| '/api/node/bootstrap/votes'
	| '/api/node/ledger/clearstats'
	| '/api/node/ledger/checksum'
	| '/api/node/ledger/block/{blockhash}'
	| '/api/node/ledger/block/{blockhash}/successor'
	| '/api/node/ledger/representative'
	| '/api/node/ledger/representative/{rep}'
	| '/api/node/ledger/representatives'
	| '/api/node/ledger/history'
	| '/api/node/ledger/accounts/{accounts}'
	| '/api/node/ledger/account/{account}'
	| '/api/node/ledger/account/{account}/head'
	| '/api/node/ledger/account/{account}/chain'
	| '/api/node/ledger/account/{account}/history'
	| '/api/node/ledger/account/{account}/history/start/{block}'
	| '/api/node/ledger/account/{account}/balance'
	| '/api/node/ledger/account/{account}/balance/{token}'
	| '/api/node/ledger/account/{account}/acl'
	| '/api/node/ledger/account/{account}/acl/{entityList}'
	| '/api/node/ledger/account/{account}/acl/granted'
	| '/api/node/ledger/account/{account}/acl/additional'
	| '/api/node/ledger/account/{account}/acl/additional/{entityList}'
	| '/api/node/ledger/account/{account}/certificates'
	| '/api/node/ledger/account/{account}/certificates/{certificateHash}'
	| '/api/node/ledger/account/{account}/pending'
	| '/api/node/ledger/account/{account}/idempotent/{idempotent}';

export const GET_ROUTES: Readonly<Record<RoutePath, RouteUse>> = {
	'/api/vote/{blockhash}': SAMPLED,
	'/api/node/peers': excluded(NODE_LOCAL),
	'/api/node/stats': excluded(NODE_LOCAL),
	'/api/node/version': excluded(NODE_LOCAL),
	'/api/node/bootstrap/votes': excluded('a bootstrap pages by the moments the node added staples at, which are its own'),
	'/api/node/ledger/clearstats': excluded('it clears the node\'s statistics, so it is never sent'),
	'/api/node/ledger/checksum': excluded('the checksum is a statistic of the node\'s own, which the checksum signal checks'),
	'/api/node/ledger/block/{blockhash}': SAMPLED,
	'/api/node/ledger/block/{blockhash}/successor': SAMPLED,
	'/api/node/ledger/representative': excluded(NODE_LOCAL),
	'/api/node/ledger/representative/{rep}': excluded('a weight sums the balances of every account that chose the representative, which move with any of them'),
	'/api/node/ledger/representatives': excluded(NODE_LOCAL),
	'/api/node/ledger/history': excluded('each node orders the ledger\'s history by its own vote in each staple'),
	'/api/node/ledger/accounts/{accounts}': SAMPLED,
	'/api/node/ledger/account/{account}': SAMPLED,
	'/api/node/ledger/account/{account}/head': SAMPLED,
	'/api/node/ledger/account/{account}/chain': SAMPLED,
	'/api/node/ledger/account/{account}/history': SAMPLED_HISTORY,
	'/api/node/ledger/account/{account}/history/start/{block}': SAMPLED_HISTORY,
	'/api/node/ledger/account/{account}/balance': SAMPLED,
	'/api/node/ledger/account/{account}/balance/{token}': SAMPLED,
	'/api/node/ledger/account/{account}/acl': SAMPLED,
	'/api/node/ledger/account/{account}/acl/{entityList}': SAMPLED,
	'/api/node/ledger/account/{account}/acl/granted': SAMPLED,
	'/api/node/ledger/account/{account}/acl/additional': SAMPLED,
	'/api/node/ledger/account/{account}/acl/additional/{entityList}': SAMPLED,
	'/api/node/ledger/account/{account}/certificates': SAMPLED,
	'/api/node/ledger/account/{account}/certificates/{certificateHash}': SAMPLED,
	'/api/node/ledger/account/{account}/pending': SAMPLED,
	'/api/node/ledger/account/{account}/idempotent/{idempotent}': SAMPLED
};

function literalSegments(route: string): number {
	return(route.split('/').filter(function(part): boolean {
		return(!part.startsWith('{'));
	}).length);
}

/*
 * A segment a route spells out is matched before a parameter in its place,
 * as the server routes them: "acl/granted" is not an entity list.
 */
const ROUTES_MOST_LITERAL_FIRST: readonly RoutePath[] = Object.keys(GET_ROUTES).filter(function(path): path is RoutePath {
	return(path in GET_ROUTES);
}).sort(function(left, right): number {
	return(literalSegments(right) - literalSegments(left));
});

/** The GET routes the document describes. */
export function getRoutesOf(document: unknown): readonly string[] {
	if (!isFields(document) || !isFields(document['paths'])) {
		throw(new Error('not an OpenAPI document'));
	}
	return(Object.entries(document['paths']).filter(function([, item]): boolean {
		return(isFields(item) && 'get' in item);
	}).map(function([path]): string {
		return(path);
	}).sort());
}

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** One request the API diff sends to the follower and to a representative. */
export type SampledRequest = {
	readonly stratum: Stratum;
	readonly route: RoutePath;
	/** Below the API's root, with its query. */
	readonly path: string;
	/** Accounts whose state the answer reads, which must be quiet on both sides for it to count. */
	readonly quiet: readonly string[];
	/** The answer lists permissions on entities, which are set on the entities' chains, so those must be quiet too. */
	readonly listsEntities: boolean;
};

function segment(value: string): string {
	return(encodeURIComponent(value));
}

/** Requests about a block within the follower's reach: the block and its votes, and the chain below it, never change once confirmed. */
export function blockRequests(stratum: Stratum, block: HeldBlock): SampledRequest[] {
	const fixed = function(route: RoutePath, path: string): SampledRequest {
		return({ stratum, route, path, quiet: [], listsEntities: false });
	};
	const requests = [
		fixed('/api/node/ledger/block/{blockhash}', `/node/ledger/block/${block.hash}`),
		fixed('/api/vote/{blockhash}', `/vote/${block.hash}`),
		fixed('/api/node/ledger/account/{account}/chain', `/node/ledger/account/${segment(block.account)}/chain?start=${block.hash}&limit=2`),
		// A block gains its successor when its account publishes again.
		{ stratum, route: '/api/node/ledger/block/{blockhash}/successor', path: `/node/ledger/block/${block.hash}/successor`, quiet: [block.account], listsEntities: false } as const
	];
	const { idempotent } = new lib.Block(block.bytes);
	if (idempotent !== undefined) {
		requests.push(fixed('/api/node/ledger/account/{account}/idempotent/{idempotent}', `/node/ledger/account/${segment(block.account)}/idempotent/${segment(idempotent.toString('base64'))}`));
	}
	return(requests);
}

/** Requests about a quiet account, and about another quiet account beside it. */
export function accountRequests(stratum: Stratum, candidate: AccountCandidate, partner: string | undefined): SampledRequest[] {
	const { account } = candidate;
	const base = `/node/ledger/account/${segment(account)}`;
	const own = function(route: RoutePath, path: string): SampledRequest {
		return({ stratum, route, path, quiet: [account], listsEntities: false });
	};
	const requests: SampledRequest[] = [
		own('/api/node/ledger/account/{account}', base),
		own('/api/node/ledger/account/{account}/head', `${base}/head`),
		own('/api/node/ledger/account/{account}/chain', `${base}/chain?limit=2`),
		own('/api/node/ledger/account/{account}/history', `${base}/history?limit=1`),
		own('/api/node/ledger/account/{account}/balance', `${base}/balance`),
		own('/api/node/ledger/account/{account}/acl/granted', `${base}/acl/granted`),
		own('/api/node/ledger/account/{account}/certificates', `${base}/certificates`),
		own('/api/node/ledger/account/{account}/pending', `${base}/pending`),
		{ ...own('/api/node/ledger/account/{account}/acl', `${base}/acl`), listsEntities: true },
		{ ...own('/api/node/ledger/account/{account}/acl/additional', `${base}/acl/additional`), listsEntities: true }
	];
	for (const token of candidate.tokens) {
		requests.push(own('/api/node/ledger/account/{account}/balance/{token}', `${base}/balance/${segment(token)}`));
	}
	for (const entity of candidate.entities) {
		requests.push({ stratum, route: '/api/node/ledger/account/{account}/acl/{entityList}', path: `${base}/acl/${segment(entity)}`, quiet: [account, entity], listsEntities: false });
		requests.push({ stratum, route: '/api/node/ledger/account/{account}/acl/additional/{entityList}', path: `${base}/acl/additional/${segment(entity)}`, quiet: [account, entity], listsEntities: false });
	}
	for (const certificate of candidate.certificates) {
		requests.push(own('/api/node/ledger/account/{account}/certificates/{certificateHash}', `${base}/certificates/${certificate}`));
	}
	for (const staple of candidate.history.slice(0, 1)) {
		requests.push(own('/api/node/ledger/account/{account}/history/start/{block}', `${base}/history/start/${staple}?limit=1`));
	}
	if (partner !== undefined) {
		requests.push({ stratum, route: '/api/node/ledger/accounts/{accounts}', path: `/node/ledger/accounts/${segment(`${account},${partner}`)}`, quiet: [account, partner], listsEntities: false });
	}
	for (const block of candidate.chain) {
		requests.push(...blockRequests(stratum, block));
	}
	return(requests);
}

type ASN1Value = ReturnType<typeof lib.Utils.ASN1.ASN1toJS>;

function isExplicitTag(value: ASN1Value): value is Extract<ASN1Value, { readonly type: 'context'; readonly kind: 'explicit' }> {
	return(lib.Utils.ASN1.ASN1CheckUtilities.isASN1ContextTag(value, 'explicit'));
}

/** A block's fields, of either version: a sequence, or a sequence tagged explicitly with 1 [Keeta TS] index.js:63202-63323. */
function blockFieldsOf(bytes: Buffer): readonly ASN1Value[] {
	const decoded = lib.Utils.ASN1.ASN1toJS(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	if (Array.isArray(decoded)) {
		return(decoded);
	}
	if (isExplicitTag(decoded) && decoded.value === 1 && Array.isArray(decoded.contains)) {
		return(decoded.contains);
	}
	throw(new Error('not the encoding of a block'));
}

/**
 * The types of operation the block carries, each once. Each operation is
 * encoded tagged explicitly with its type [Keeta TS] index.js:64948-64959,
 * in the one field of the block that is a sequence of such tags, so the
 * types are read from the encoding alone; decoding the whole block would
 * build every account and amount of its operations, which costs about ten
 * times as much over the blocks of the main network's airdrops.
 */
export function operationsOf(block: HeldBlock): readonly OperationName[] {
	const operations = blockFieldsOf(block.bytes).find(function(field): field is ASN1Value[] {
		return(Array.isArray(field) && field.length > 0 && field.every(isExplicitTag));
	});
	if (operations === undefined) {
		throw(new Error(`the block ${block.hash} lists no operations`));
	}
	const types = new Set(operations.filter(isExplicitTag).map(function(operation): number {
		return(operation.value);
	}));
	return(OPERATION_NAMES.filter(function(name): boolean {
		return(types.has(lib.Block.OperationType[name]));
	}));
}

/** An order the seed fixes and that does not follow the follower's own. */
export function shuffled<Item>(items: readonly Item[], keyOf: (item: Item) => string, seed: string): Item[] {
	const keyed = items.map(function(item) {
		return({ item, key: createHash('sha256').update(`${seed}\0${keyOf(item)}`).digest('hex') });
	});
	keyed.sort(function(left, right): number {
		return(left.key.localeCompare(right.key));
	});
	return(keyed.map(function({ item }): Item {
		return(item);
	}));
}

/** What the API diff reads of the follower's storage. */
export type APIDiffStore = Pick<FollowerStore, 'progress' | 'quietAccounts' | 'heldBlocks' | 'blockPages' | 'heldBlocksInPages' | 'heldBlocksOfStaples' | 'newestStaples'>;

/**
 * Pages of the blocks' table read at a time: some two thousand blocks, in
 * the order they are stored, so that their bytes are read as stored rather
 * than in the order of an index.
 */
const TABLE_PAGES_PER_READ = 200;

type DrawnBlock = { readonly key: string; readonly block: HeldBlock };

function drawKey(seed: string, block: HeldBlock): string {
	return(createHash('sha256').update(`${seed}\0${block.hash}`).digest('hex'));
}

/** The blocks the seed puts first, at most so many. */
function keptFirst(drawn: readonly DrawnBlock[], wanted: number): DrawnBlock[] {
	return([...drawn].sort(function(left, right): number {
		return(left.key.localeCompare(right.key));
	}).slice(0, wanted));
}

/**
 * The blocks of each type of operation the seed puts first, at most so many
 * of each, from a read of every held block: the rarest types are held by a
 * few blocks in hundreds of thousands, so a type with fewer blocks than
 * wanted has drawn every block it has.
 */
async function blocksByOperation(store: APIDiffStore, before: Date, wanted: number, seed: string): Promise<ReadonlyMap<OperationName, readonly HeldBlock[]>> {
	const byOperation = new Map<OperationName, DrawnBlock[]>(OPERATION_NAMES.map(function(name) {
		return([name, []]);
	}));
	const pages = await store.blockPages();
	for (let fromPage = 0; fromPage < pages; fromPage += TABLE_PAGES_PER_READ) {
		for (const block of await store.heldBlocksInPages(fromPage, fromPage + TABLE_PAGES_PER_READ, before)) {
			for (const name of operationsOf(block)) {
				const drawn = byOperation.get(name) ?? [];
				drawn.push({ key: drawKey(seed, block), block });
				// Kept to at most twice as many as wanted, so that a common type holds no more than that.
				if (drawn.length >= 2 * wanted) {
					byOperation.set(name, keptFirst(drawn, wanted));
				} else {
					byOperation.set(name, drawn);
				}
			}
		}
	}
	return(new Map([...byOperation].map(function([name, drawn]) {
		return([name, keptFirst(drawn, wanted).map(function({ block }): HeldBlock {
			return(block);
		})]);
	})));
}

/** A stratum's requests, and whether they are every request the follower's data forms for it. */
export type PlannedStratum = {
	readonly requests: readonly SampledRequest[];
	readonly whole: boolean;
};

function pathOf(request: SampledRequest): string {
	return(request.path);
}

/** The requests once each, in an order the seed fixes: two blocks of an account name it alike. */
function planned(requests: readonly SampledRequest[], whole: boolean, seed: string): PlannedStratum {
	const unique = [...new Map(requests.map(function(request) {
		return([request.path, request]);
	})).values()];
	return({ requests: shuffled(unique, pathOf, seed), whole });
}

/**
 * The requests of each stratum, in an order the seed fixes: about quiet
 * accounts of each kind, at most so many of them, about blocks carrying
 * each type of operation, at most so many of each, and about the edge-case
 * staples the follower holds, all within its reach. A stratum is whole when
 * fewer accounts or blocks than that are all it has: then its requests are
 * every request the sampler forms from the follower's data.
 */
export async function samplingPlan(store: APIDiffStore, quietBefore: Date, perStratum: number, seed: string, edgeCaseStaples: readonly string[]): Promise<ReadonlyMap<Stratum, PlannedStratum>> {
	const plan = new Map<Stratum, PlannedStratum>();
	for (const kind of ACCOUNT_KINDS) {
		const candidates = await store.quietAccounts(kind, quietBefore, perStratum, seed);
		plan.set(kind, planned(candidates.flatMap(function(candidate, index): SampledRequest[] {
			return(accountRequests(kind, candidate, candidates[index + 1]?.account));
		}), candidates.length < perStratum, seed));
	}
	for (const [name, blocks] of await blocksByOperation(store, quietBefore, perStratum, seed)) {
		const stratum = operationStratum(name);
		plan.set(stratum, planned(blocks.flatMap(function(block): SampledRequest[] {
			return(blockRequests(stratum, block));
		}), blocks.length < perStratum, seed));
	}
	const edgeBlocks = await store.heldBlocksOfStaples(edgeCaseStaples, quietBefore);
	plan.set('edge-cases', planned(edgeBlocks.flatMap(function(block): SampledRequest[] {
		return([...blockRequests('edge-cases', block), { stratum: 'edge-cases', route: '/api/node/ledger/account/{account}', path: `/node/ledger/account/${segment(block.account)}`, quiet: [block.account], listsEntities: false }]);
	}), true, seed));
	return(plan);
}

/**
 * A stratum is a census when its whole population is fewer requests than
 * the run compares of each, so that the run sends every one of them.
 */
export function populationOf(stratum: PlannedStratum, samplesPerStratum: number): StratumPopulation {
	if (stratum.whole && stratum.requests.length < samplesPerStratum) {
		return({ kind: 'census', requests: stratum.requests.map(pathOf) });
	}
	return({ kind: 'sample', drawn: stratum.requests.length, whole: stratum.whole });
}

/** Whether an account is quiet on one side, and why not. */
type Quietness = { readonly quiet: true } | { readonly quiet: false; readonly side: 'representative' | 'follower'; readonly detail: string };

/**
 * Decides whether accounts are quiet: the follower holds no staple of
 * theirs from the margin before its reach on, and a representative's
 * newest staple of theirs has no vote from then on, as the sweep decides
 * (src/parity/sweep.ts). Each representative is asked about an account
 * once a run, since the one compared with and those read again may each
 * hold it at a point of their own.
 */
class QuietAccounts {
	readonly #store: APIDiffStore;
	readonly #quietBefore: Date;
	readonly #representativeSide = new Map<string, Promise<Quietness>>();

	constructor(store: APIDiffStore, quietBefore: Date) {
		this.#store = store;
		this.#quietBefore = quietBefore;
	}

	async of(accounts: readonly string[], representative: APISource): Promise<Quietness> {
		const unique = [...new Set(accounts)];
		if (unique.length === 0) {
			return({ quiet: true });
		}
		const newest = await this.#store.newestStaples(unique);
		for (const account of unique) {
			const staple = newest.get(account);
			if (staple !== undefined && staple.getTime() >= this.#quietBefore.getTime()) {
				return({ quiet: false, side: 'follower', detail: `the follower holds a staple of ${account} from ${staple.toISOString()}` });
			}
		}
		for (const account of unique) {
			const answer = await this.#onRepresentative(account, representative);
			if (!answer.quiet) {
				return(answer);
			}
		}
		return({ quiet: true });
	}

	#onRepresentative(account: string, representative: APISource): Promise<Quietness> {
		const key = `${representative.endpoint} ${account}`;
		const known = this.#representativeSide.get(key);
		if (known !== undefined) {
			return(known);
		}
		const quietBefore = this.#quietBefore;
		const answers = this.#representativeSide;
		const asked = (async function(): Promise<Quietness> {
			const answer = await representative.get(`/node/ledger/account/${segment(account)}/history?limit=1`);
			if (answer.status !== 200) {
				throw(new Error(`${representative.endpoint} answered ${String(answer.status)} for the history of ${account}`));
			}
			const newest = newestStapleOf(answer.body);
			if (newest !== undefined && newest.latestVote.getTime() >= quietBefore.getTime()) {
				return({ quiet: false, side: 'representative', detail: `its newest staple of ${account}, ${newest.staple}, has a vote from ${newest.latestVote.toISOString()}` });
			}
			return({ quiet: true });
		})();
		answers.set(key, asked);
		// A failed question is asked again for the next request.
		asked.catch(function() {
			answers.delete(key);
		});
		return(asked);
	}
}

/** The entities a listing of permissions names, in either form a principal's listing takes. */
export function entitiesListed(body: unknown): readonly string[] {
	if (!isFields(body)) {
		return([]);
	}
	const rows = [body['permissions'], body['access']].flatMap(function(list): unknown[] {
		if (!Array.isArray(list)) {
			return([]);
		}
		return(list);
	});
	return(rows.flatMap(function(row): string[] {
		if (isFields(row) && typeof row['entity'] === 'string') {
			return([row['entity']]);
		}
		return([]);
	}));
}

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

/**
 * A gateway in front of a representative answers these when the
 * representative itself does not, with a page of its own rather than the
 * API's error envelope.
 */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function normalizedAnswer(route: RoutePath, answer: APIAnswer): unknown {
	const use = GET_ROUTES[route];
	switch (use.kind) {
		case 'sampled':
			return({ status: answer.status, body: normalizedAll(answer.body, use.normalize) });
		case 'excluded':
			throw(new Error(`${route} is not sampled: ${use.why}`));
		default:
			return(assertNever(use));
	}
}

type Compared = { readonly outcome: APIDiffOutcome; readonly representativeAnswer: APIAnswer | undefined };

/** The rule the sweep judges whose a divergence is by reads only whether each other representative agrees. */
function judgedAsTheSweepDoes(reading: APIDiffReading): RepresentativeReading {
	switch (reading.kind) {
		case 'agrees':
		case 'disagrees':
			return({ representative: reading.representative, kind: reading.kind, state: reading.answer, staple: null });
		case 'unanswered':
		case 'moving':
			return(reading);
		default:
			return(assertNever(reading));
	}
}

/** Whether the accounts a request reads, and those its answer lists, are quiet on the representative. */
async function quietFor(request: SampledRequest, answers: readonly APIAnswer[], representative: APISource, quiet: QuietAccounts): Promise<Quietness> {
	const accounts = [...request.quiet];
	if (request.listsEntities) {
		accounts.push(...answers.flatMap(function(answer): readonly string[] {
			return(entitiesListed(answer.body));
		}));
	}
	return(await quiet.of(accounts, representative));
}

/**
 * Sends the request to another representative, as it was to the one
 * compared with, and tells whether its answer is the follower's once both
 * are normalized.
 */
async function readingOf(request: SampledRequest, other: APISource, followerAnswer: APIAnswer, quiet: QuietAccounts): Promise<APIDiffReading> {
	const representative = other.endpoint;
	try {
		const before = await quiet.of(request.quiet, other);
		if (!before.quiet) {
			return({ representative, kind: 'moving', detail: before.detail });
		}
		const answer = await other.get(request.path);
		if (GATEWAY_STATUSES.has(answer.status)) {
			return({ representative, kind: 'unanswered', detail: `${representative} answered ${String(answer.status)}` });
		}
		const listed = await quietFor({ ...request, quiet: [] }, [followerAnswer, answer], other, quiet);
		if (!listed.quiet) {
			return({ representative, kind: 'moving', detail: listed.detail });
		}
		if (firstDifference(normalizedAnswer(request.route, followerAnswer), normalizedAnswer(request.route, answer)) === undefined) {
			return({ representative, kind: 'agrees', answer });
		}
		return({ representative, kind: 'disagrees', answer });
	} catch (error: unknown) {
		return({ representative, kind: 'unanswered', detail: messageOf(error) });
	}
}

/**
 * Sends the request to the follower before and after the representative,
 * so that an account the follower changes in between shows as a change,
 * and compares the two answers once normalized, when every account the
 * answer reads is quiet on both sides. Answers that differ are read again
 * from every other representative, and judged by the sweep's rule: the
 * follower's when most disagree with it, the one representative's own when
 * most agree with the follower and at least two do, and unresolved
 * otherwise.
 */
async function compareRequest(request: SampledRequest, follower: APISource, representative: APISource, others: readonly APISource[], quiet: QuietAccounts): Promise<Compared> {
	let followerAfter: APIAnswer;
	let representativeAnswer: APIAnswer;
	try {
		const before = await quiet.of(request.quiet, representative);
		if (!before.quiet) {
			return({ outcome: { kind: 'skipped', reason: 'moving', side: before.side, detail: before.detail }, representativeAnswer: undefined });
		}
		const followerBefore = await follower.get(request.path);
		representativeAnswer = await representative.get(request.path);
		followerAfter = await follower.get(request.path);
		if (GATEWAY_STATUSES.has(representativeAnswer.status)) {
			return({ outcome: { kind: 'skipped', reason: 'unanswered', detail: `${representative.endpoint} answered ${String(representativeAnswer.status)}` }, representativeAnswer: undefined });
		}
		if (!isDeepStrictEqual(followerBefore, followerAfter)) {
			return({ outcome: { kind: 'skipped', reason: 'moving', side: 'follower', detail: 'the follower changed its answer while it was compared' }, representativeAnswer });
		}
		const listed = await quietFor({ ...request, quiet: [] }, [followerAfter, representativeAnswer], representative, quiet);
		if (!listed.quiet) {
			return({ outcome: { kind: 'skipped', reason: 'moving', side: listed.side, detail: listed.detail }, representativeAnswer });
		}
	} catch (error: unknown) {
		return({ outcome: { kind: 'skipped', reason: 'unanswered', detail: messageOf(error) }, representativeAnswer: undefined });
	}
	const field = firstDifference(normalizedAnswer(request.route, followerAfter), normalizedAnswer(request.route, representativeAnswer));
	if (field === undefined) {
		return({ outcome: { kind: 'match' }, representativeAnswer });
	}
	const answered = followerAfter;
	const readings = await Promise.all(others.map(function(other) {
		return(readingOf(request, other, answered, quiet));
	}));
	const kind = disputedKindOf(readings.map(judgedAsTheSweepDoes), field);
	return({ outcome: { kind, field, follower: followerAfter, representative: representativeAnswer, readings }, representativeAnswer });
}

/** The route of the document a request below the API's root is of, and its decoded path parameters. */
export function routeOf(path: string): { readonly route: RoutePath; readonly parameters: Readonly<Record<string, string>> } | undefined {
	const [bare = ''] = path.split('?');
	const segments = `/api${bare}`.split('/');
	for (const route of ROUTES_MOST_LITERAL_FIRST) {
		const pattern = route.split('/');
		if (pattern.length !== segments.length) {
			continue;
		}
		const parameters: Record<string, string> = {};
		const matches = pattern.every(function(part, index): boolean {
			const value = segments[index] ?? '';
			const name = /^\{(.+)\}$/.exec(part)?.[1];
			if (name === undefined) {
				return(part === value);
			}
			parameters[name] = decodeURIComponent(value);
			return(value !== '');
		});
		if (matches) {
			return({ route, parameters });
		}
	}
	return(undefined);
}

function keyTypeOf(account: string): string {
	try {
		return(lib.Account.AccountKeyAlgorithm[lib.Account.fromPublicKeyString(account).keyType]);
	} catch {
		return('malformed');
	}
}

/** The names of the operation types of every block an answer serves, at any depth. */
function operationsServed(value: unknown): readonly string[] {
	if (Array.isArray(value)) {
		return(value.flatMap(operationsServed));
	}
	if (!isFields(value)) {
		return([]);
	}
	const own = value['operations'];
	const nested = Object.values(value).flatMap(operationsServed);
	if (!Array.isArray(own)) {
		return(nested);
	}
	return([...own.flatMap(function(operation: unknown): string[] {
		if (!isFields(operation) || typeof operation['type'] !== 'number') {
			return([]);
		}
		return([OPERATION_NAMES[operation['type']] ?? `type ${String(operation['type'])}`]);
	}), ...nested]);
}

/**
 * The kinds of behavior an answer shows, as the capture set is told apart
 * by: its route with its status and error code, the kind of account it is
 * about, and each type of operation of the blocks it serves, which every
 * route serializes alike. Each is told apart from the others, so that a
 * new combination of known ones is not new.
 */
export function behaviorsOf(path: string, answer: APIAnswer): readonly string[] {
	const matched = routeOf(path);
	if (matched === undefined) {
		return([]);
	}
	let error = '-';
	if (isFields(answer.body) && answer.body['error'] === true) {
		error = 'internal';
		if (typeof answer.body['code'] === 'string') {
			error = answer.body['code'];
		}
	}
	const behaviors = [`${matched.route} ${String(answer.status)} error=${error}`];
	const named = matched.parameters['account'];
	if (named !== undefined) {
		behaviors.push(`account=${keyTypeOf(named)}`);
	}
	for (const operation of [...new Set(operationsServed(answer.body))].sort()) {
		behaviors.push(`operation=${operation}`);
	}
	return(behaviors);
}

/** The behaviors of the capture set, which conformance/API.md describes; a capture of a path outside the sampled routes has none. */
export async function capturedBehaviors(directory: string): Promise<ReadonlySet<string>> {
	const behaviors = new Set<string>();
	for (const name of (await readdir(directory)).filter(function(file): boolean {
		return(file.endsWith('.json'));
	})) {
		const capture: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'));
		if (!isFields(capture) || !isFields(capture['request']) || typeof capture['request']['path'] !== 'string' || typeof capture['status'] !== 'number') {
			throw(new Error(`${name} is not a capture`));
		}
		for (const behavior of behaviorsOf(capture['request']['path'].replace(/^\/api/, ''), { status: capture['status'], body: capture['body'] })) {
			behaviors.add(behavior);
		}
	}
	return(behaviors);
}

export type APIDiffSetup = {
	readonly follower: APISource;
	/** Each request goes to one of them, in turn; their requests are paced by the caller. */
	readonly representatives: readonly APISource[];
	readonly store: APIDiffStore;
	readonly log: ParityLog;
	/** How many requests of each stratum to compare. */
	readonly samplesPerStratum: number;
	/** Fixes which requests are drawn and in what order. */
	readonly seed: string;
	/** The edge-case staples, by the hash of their blocks. */
	readonly edgeCaseStaples: readonly string[];
	readonly knownBehaviors: ReadonlySet<string>;
	readonly stopped: AbortSignal;
};

export type StratumSummary = {
	readonly stratum: Stratum;
	/** Requests drawn for the stratum, of which so many were sent. */
	readonly available: number;
	readonly compared: number;
	readonly matched: number;
	readonly diverged: number;
	readonly skipped: number;
};

export type APIDiffSummary = {
	readonly quietBefore: string | null;
	readonly strata: readonly StratumSummary[];
	/** Answers of a kind the capture set holds none of, each with a request that drew it. */
	readonly newBehaviors: readonly { readonly behavior: string; readonly path: string }[];
};

function othersThan(representatives: readonly APISource[], representative: APISource): readonly APISource[] {
	return(representatives.filter(function(other): boolean {
		return(other.endpoint !== representative.endpoint);
	}));
}

/** A comparison's record, with the behaviors the representative's answer shows when it was compared. */
function recordOf(representative: APISource, request: SampledRequest, compared: Compared): APIDiffRecord {
	const { outcome, representativeAnswer } = compared;
	let behaviors: readonly string[] = [];
	if (representativeAnswer !== undefined && outcome.kind !== 'skipped') {
		behaviors = behaviorsOf(request.path, representativeAnswer);
	}
	return({ kind: 'api-diff', at: new Date().toISOString(), representative: representative.endpoint, stratum: request.stratum, route: request.route, path: request.path, behaviors, outcome });
}

/** Read through a call, as a signal is aborted while the sampler awaits. */
function isStopped(signal: AbortSignal): boolean {
	return(signal.aborted);
}

function emptySummary(stratum: Stratum, available: number): StratumSummary {
	return({ stratum, available, compared: 0, matched: 0, diverged: 0, skipped: 0 });
}

/**
 * Compares requests of each stratum until so many were compared or none
 * is left, one worker for each representative taking the next request,
 * and records each comparison as it ends.
 */
export async function sampleAPI(setup: APIDiffSetup): Promise<APIDiffSummary> {
	if (setup.representatives.length === 0) {
		throw(new Error('the API diff needs a representative to compare with'));
	}
	const strata: StratumSummary[] = [];
	const { heldBefore } = await setup.store.progress();
	if (heldBefore === undefined) {
		return({ quietBefore: null, strata, newBehaviors: [] });
	}
	const quietBefore = new Date(heldBefore.getTime() - QUIET_MARGIN_MILLISECONDS);
	const plan = await samplingPlan(setup.store, quietBefore, setup.samplesPerStratum, setup.seed, setup.edgeCaseStaples);
	const planRecord: APIDiffPlanRecord = {
		kind: 'api-diff-plan',
		at: new Date().toISOString(),
		quietBefore: quietBefore.toISOString(),
		samplesPerStratum: setup.samplesPerStratum,
		strata: STRATA.map(function(stratum) {
			return({ stratum, population: populationOf(plan.get(stratum) ?? { requests: [], whole: true }, setup.samplesPerStratum) });
		})
	};
	await setup.log.append([planRecord]);
	const quiet = new QuietAccounts(setup.store, quietBefore);
	const newBehaviors = new Map<string, string>();
	for (const stratum of STRATA) {
		const requests = plan.get(stratum)?.requests ?? [];
		const counts = { ...emptySummary(stratum, requests.length) };
		let next = 0;
		const workers = setup.representatives.map(async function(representative) {
			while (counts.compared < setup.samplesPerStratum && !isStopped(setup.stopped)) {
				const request = requests[next++];
				if (request === undefined) {
					return;
				}
				const compared = await compareRequest(request, setup.follower, representative, othersThan(setup.representatives, representative), quiet);
				const record = recordOf(representative, request, compared);
				for (const behavior of record.behaviors) {
					if (!setup.knownBehaviors.has(behavior) && !newBehaviors.has(behavior)) {
						newBehaviors.set(behavior, request.path);
					}
				}
				await setup.log.append([record]);
				const { outcome } = compared;
				switch (outcome.kind) {
					case 'match':
					case 'representative-local':
						counts.compared++;
						counts.matched++;
						break;
					case 'diverged':
					case 'unresolved':
						counts.compared++;
						counts.diverged++;
						break;
					case 'skipped':
						counts.skipped++;
						break;
					default:
						assertNever(outcome);
				}
			}
		});
		await Promise.all(workers);
		strata.push(counts);
		if (isStopped(setup.stopped)) {
			break;
		}
	}
	return({
		quietBefore: quietBefore.toISOString(),
		strata,
		newBehaviors: [...newBehaviors].map(function([behavior, path]) {
			return({ behavior, path });
		})
	});
}

/** The accounts named in a request's path, each of which an account's answer may read. */
function accountsNamed(parameters: Readonly<Record<string, string>>): string[] {
	const named = [parameters['account'], parameters['entityList'], ...(parameters['accounts']?.split(',') ?? [])];
	return(named.filter(function(account): account is string {
		return(account !== undefined);
	}));
}

const LISTING_ENTITIES: ReadonlySet<RoutePath> = new Set<RoutePath>(['/api/node/ledger/account/{account}/acl', '/api/node/ledger/account/{account}/acl/additional']);

/**
 * The request a record compared, with the accounts that must be quiet for
 * it: every account its path names, which is as many as the sampler asked
 * for or more, and for a block's successor the block's account, which the
 * follower holds within its reach. Nothing when the follower no longer
 * holds that block there.
 */
async function recordedRequestOf(record: APIDiffRecord, store: APIDiffStore, quietBefore: Date): Promise<SampledRequest | undefined> {
	const matched = routeOf(record.path);
	if (matched === undefined) {
		return(undefined);
	}
	const { route, parameters } = matched;
	const quiet = accountsNamed(parameters);
	const successorOf = parameters['blockhash'];
	if (route === '/api/node/ledger/block/{blockhash}/successor' && successorOf !== undefined) {
		const [block] = await store.heldBlocks(successorOf, quietBefore, 1);
		if (block?.hash !== successorOf) {
			return(undefined);
		}
		quiet.push(block.account);
	}
	return({ stratum: record.stratum, route, path: record.path, quiet, listsEntities: LISTING_ENTITIES.has(route) });
}

export type APIRecheckSetup = Pick<APIDiffSetup, 'follower' | 'representatives' | 'store' | 'log' | 'stopped'>;

/** How many requests were compared again, by the outcome each had. */
export type APIRecheckSummary = Readonly<Partial<Record<APIDiffOutcome['kind'], number>>>;

/** The latest comparison of each request of a stratum, in the order the requests were first compared. */
function latestComparisons(records: readonly APIDiffRecord[]): readonly APIDiffRecord[] {
	const latest = new Map<string, APIDiffRecord>();
	for (const record of records) {
		if (record.outcome.kind !== 'skipped') {
			latest.set(`${record.stratum} ${record.path}`, record);
		}
	}
	return([...latest.values()]);
}

/**
 * Sends again each request whose latest comparison diverged or was
 * unresolved, the identical request to the representative it was compared
 * with, read again from every other, and records the outcome, which stands
 * as the request's latest. A representative the run does not reach leaves
 * its requests as they stand.
 */
export async function recheckAPIDivergences(setup: APIRecheckSetup): Promise<APIRecheckSummary> {
	const { heldBefore } = await setup.store.progress();
	if (heldBefore === undefined) {
		throw(new Error('the follower has read from no representative yet'));
	}
	const quietBefore = new Date(heldBefore.getTime() - QUIET_MARGIN_MILLISECONDS);
	const quiet = new QuietAccounts(setup.store, quietBefore);
	const disputed = latestComparisons((await setup.log.read()).records.filter(function(record): record is APIDiffRecord {
		return(record.kind === 'api-diff');
	})).filter(function(record): boolean {
		return(record.outcome.kind === 'diverged' || record.outcome.kind === 'unresolved');
	});
	const summary: Partial<Record<APIDiffOutcome['kind'], number>> = {};
	for (const record of disputed) {
		const representative = setup.representatives.find(function(source): boolean {
			return(source.endpoint === record.representative);
		});
		const request = await recordedRequestOf(record, setup.store, quietBefore);
		if (representative === undefined || request === undefined) {
			continue;
		}
		const compared = await compareRequest(request, setup.follower, representative, othersThan(setup.representatives, representative), quiet);
		if (isStopped(setup.stopped)) {
			break;
		}
		await setup.log.append([recordOf(representative, request, compared)]);
		summary[compared.outcome.kind] = (summary[compared.outcome.kind] ?? 0) + 1;
	}
	return(summary);
}
