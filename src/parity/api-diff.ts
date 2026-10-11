import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { normalizedAll } from '../conformance/api/normalize.js';
import type { Normalization } from '../conformance/api/normalize.js';
import { assertNever } from '../util/assert-never.js';
import { answeredByAPI, isAnonymousFailure } from './api-source.js';
import type { APIAnswer, APISource } from './api-source.js';
import type { AccountCandidate, FollowerStore, HeldBlock } from './follower-store.js';
import type { APIDiffExplainedRecord, APIDiffOutcome, APIDiffPlanRecord, APIDiffReading, APIDiffRecord, ParityLog, ParityRecord, RepresentativeReading, StratumPopulation } from './log.js';
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
 * The requests of each stratum a run compares to meet the done criterion,
 * a divergence rate below 1% at 95% by the rule of three; a run that
 * compares fewer makes no claim about any stratum's whole population.
 */
export const API_DIFF_SAMPLES_TARGET = 300;

/**
 * How far a run that compares fewer requests than the done criterion reads
 * the blocks' table: some twenty thousand blocks from a page the seed fixes,
 * seconds where reading every block takes minutes.
 */
const BOUNDED_TABLE_PAGES = 2000;

/** How much of the blocks' table a plan reads. */
type BlockScan = 'every-block' | 'bounded';

/** The pages to read, in reads of TABLE_PAGES_PER_READ: every page, or a bounded run of them from a page the seed fixes, round to the first. */
function pageReadsOf(pages: number, scan: BlockScan, seed: string): readonly number[] {
	const reads = Math.ceil(pages / TABLE_PAGES_PER_READ);
	switch (scan) {
		case 'every-block':
			return(Array.from({ length: reads }, function(_, index): number {
				return(index * TABLE_PAGES_PER_READ);
			}));
		case 'bounded': {
			const first = Number(BigInt(`0x${createHash('sha256').update(seed).digest('hex')}`) % BigInt(Math.max(1, reads)));
			return(Array.from({ length: Math.min(reads, BOUNDED_TABLE_PAGES / TABLE_PAGES_PER_READ) }, function(_, index): number {
				return(((first + index) % reads) * TABLE_PAGES_PER_READ);
			}));
		}
		default:
			return(assertNever(scan));
	}
}

type DrawnBlocks = {
	readonly byOperation: ReadonlyMap<OperationName, readonly HeldBlock[]>;
	/** Whether every held block was read, so that a type with fewer blocks than wanted has none besides them. */
	readonly everyBlockRead: boolean;
};

/**
 * The blocks of each type of operation the seed puts first, at most so many
 * of each, from a read of every held block, or of a bounded part of them:
 * the rarest types are held by a few blocks in hundreds of thousands, so a
 * type with fewer blocks than wanted in a read of every block has drawn
 * every block it has.
 */
async function blocksByOperation(store: APIDiffStore, before: Date, wanted: number, seed: string, scan: BlockScan, stopped: AbortSignal): Promise<DrawnBlocks> {
	const byOperation = new Map<OperationName, DrawnBlock[]>(OPERATION_NAMES.map(function(name) {
		return([name, []]);
	}));
	const filled = function(): boolean {
		return([...byOperation.values()].every(function(drawn): boolean {
			return(drawn.length >= wanted);
		}));
	};
	const reads = pageReadsOf(await store.blockPages(), scan, seed);
	let read = 0;
	for (const fromPage of reads) {
		if (isStopped(stopped) || (scan === 'bounded' && filled())) {
			break;
		}
		read++;
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
	return({
		byOperation: new Map([...byOperation].map(function([name, drawn]) {
			return([name, keptFirst(drawn, wanted).map(function({ block }): HeldBlock {
				return(block);
			})]);
		})),
		everyBlockRead: scan === 'every-block' && read === reads.length
	});
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
export async function samplingPlan(store: APIDiffStore, quietBefore: Date, perStratum: number, seed: string, edgeCaseStaples: readonly string[], scan: BlockScan, stopped: AbortSignal): Promise<ReadonlyMap<Stratum, PlannedStratum>> {
	const plan = new Map<Stratum, PlannedStratum>();
	for (const kind of ACCOUNT_KINDS) {
		const candidates = await store.quietAccounts(kind, quietBefore, perStratum, seed);
		plan.set(kind, planned(candidates.flatMap(function(candidate, index): SampledRequest[] {
			return(accountRequests(kind, candidate, candidates[index + 1]?.account));
		}), candidates.length < perStratum, seed));
	}
	const { byOperation, everyBlockRead } = await blocksByOperation(store, quietBefore, perStratum, seed, scan, stopped);
	for (const [name, blocks] of byOperation) {
		const stratum = operationStratum(name);
		plan.set(stratum, planned(blocks.flatMap(function(block): SampledRequest[] {
			return(blockRequests(stratum, block));
		}), everyBlockRead && blocks.length < perStratum, seed));
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

/** The value with every object's fields in the order of their names, as two nodes may serialize them in different orders. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return(value.map(canonical));
	}
	if (!isFields(value)) {
		return(value);
	}
	return(Object.fromEntries(Object.keys(value).sort().map(function(name) {
		return([name, canonical(value[name])]);
	})));
}

function digestOf(route: RoutePath, answer: APIAnswer): string {
	return(createHash('sha256').update(JSON.stringify(canonical(normalizedAnswer(route, answer)))).digest('hex'));
}

function isAnswer(value: unknown): value is APIAnswer {
	return(isFields(value) && typeof value['status'] === 'number');
}

/** The digest of an answer to the request, once normalized, which two answers alike share; nothing for a path of no sampled route or a value that is no answer. */
export function answerDigest(path: string, answer: unknown): string | undefined {
	const matched = routeOf(path);
	if (matched === undefined || !isAnswer(answer) || GET_ROUTES[matched.route].kind !== 'sampled') {
		return(undefined);
	}
	return(digestOf(matched.route, answer));
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

const HISTORY_ROUTES: ReadonlySet<RoutePath> = new Set<RoutePath>(['/api/node/ledger/account/{account}/history', '/api/node/ledger/account/{account}/history/start/{block}']);

const LAST_SUCCESS_STATUS = 299;

function succeeded(answer: APIAnswer): boolean {
	return(answer.status <= LAST_SUCCESS_STATUS);
}

/**
 * The difference in the terms of the sweep's rule (src/parity/sweep.ts),
 * which never counts one representative's own a follower that failed to
 * answer ("status"), nor a staple the follower may lack ("history"): two
 * pages of history that differ may show one, which other representatives
 * can hide by listing a staple of their own first, ordering an account's
 * history by their own votes (conformance/API.md, Differences).
 */
function judgedField(route: RoutePath, followerAnswer: APIAnswer, representativeAnswer: APIAnswer, field: string): string {
	if (!succeeded(followerAnswer)) {
		return('status');
	}
	if (HISTORY_ROUTES.has(route) && succeeded(representativeAnswer)) {
		return('history');
	}
	return(field);
}

/**
 * Sends the request to another representative, as it was to the one
 * compared with, and tells whether its answer is the follower's once both
 * are normalized, as the sweep reads another representative: a reading
 * counts only when every account the answer reads is quiet on that
 * representative, and agrees with a follower that failed never.
 */
async function readingOf(request: SampledRequest, other: APISource, followerAnswer: APIAnswer, judged: string, quiet: QuietAccounts): Promise<APIDiffReading> {
	const representative = other.endpoint;
	try {
		const answer = await other.get(request.path);
		if (!answeredByAPI(answer)) {
			return({ representative, kind: 'unanswered', detail: `${representative} answered ${String(answer.status)}` });
		}
		const quietness = await quietFor(request, [followerAnswer, answer], other, quiet);
		if (!quietness.quiet) {
			return({ representative, kind: 'moving', detail: quietness.detail });
		}
		if (judged !== 'status' && firstDifference(normalizedAnswer(request.route, followerAnswer), normalizedAnswer(request.route, answer)) === undefined) {
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
 * and compares the two answers once normalized. Answers alike match, with
 * the digest of the answer, so that a later match shows which state it
 * matched on. Answers apart count only when every account the answer reads
 * is quiet on both sides, the representative's newest staples read after
 * its answer, so that one it added since shows; they are then read again
 * from every other representative, and judged by the sweep's rule.
 */
async function compareRequest(request: SampledRequest, follower: APISource, representative: APISource, others: readonly APISource[], quiet: QuietAccounts): Promise<Compared> {
	let followerAfter: APIAnswer;
	let representativeAnswer: APIAnswer;
	let field: string | undefined;
	try {
		const followerBefore = await follower.get(request.path);
		representativeAnswer = await representative.get(request.path);
		followerAfter = await follower.get(request.path);
		if (!answeredByAPI(representativeAnswer)) {
			return({ outcome: { kind: 'skipped', reason: 'unanswered', detail: `${representative.endpoint} answered ${String(representativeAnswer.status)}` }, representativeAnswer: undefined });
		}
		// An internal failure names an error ID of its own each time it is served.
		if (!isDeepStrictEqual(normalizedAnswer(request.route, followerBefore), normalizedAnswer(request.route, followerAfter))) {
			return({ outcome: { kind: 'skipped', reason: 'moving', side: 'follower', detail: 'the follower changed its answer while it was compared' }, representativeAnswer });
		}
		if (isAnonymousFailure(followerAfter) && isAnonymousFailure(representativeAnswer)) {
			return({ outcome: { kind: 'skipped', reason: 'unanswered', detail: 'both failed internally, naming no code of the API, which shows nothing alike' }, representativeAnswer: undefined });
		}
		field = firstDifference(normalizedAnswer(request.route, followerAfter), normalizedAnswer(request.route, representativeAnswer));
		if (field === undefined) {
			return({ outcome: { kind: 'match', digest: digestOf(request.route, followerAfter) }, representativeAnswer });
		}
		const quietness = await quietFor(request, [followerAfter, representativeAnswer], representative, quiet);
		if (!quietness.quiet) {
			return({ outcome: { kind: 'skipped', reason: 'moving', side: quietness.side, detail: quietness.detail }, representativeAnswer });
		}
	} catch (error: unknown) {
		return({ outcome: { kind: 'skipped', reason: 'unanswered', detail: messageOf(error) }, representativeAnswer: undefined });
	}
	const answered = followerAfter;
	const judged = judgedField(request.route, answered, representativeAnswer, field);
	const readings = await Promise.all(others.map(function(other) {
		return(readingOf(request, other, answered, judged, quiet));
	}));
	const kind = disputedKindOf(readings.map(judgedAsTheSweepDoes), judged);
	/*
	 * A representative failing internally to serve a page of history is
	 * asked again later rather than counted its own, or split on: the
	 * failure names no cause, and a page it does serve may show a staple the
	 * follower lacks. Only when most of the answers read, the failure among
	 * them, differ from the follower's, failing or serving another page, is
	 * the divergence the follower's; it carries the failure, which no later
	 * comparison settles, so only a triage closes it.
	 */
	if (HISTORY_ROUTES.has(request.route) && isAnonymousFailure(representativeAnswer) && kind !== 'diverged') {
		return({ outcome: { kind: 'skipped', reason: 'unanswered', detail: `${representative.endpoint} failed internally, and most representatives did not answer apart from the follower` }, representativeAnswer: undefined });
	}
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
	if (isStopped(setup.stopped)) {
		return({ quietBefore: quietBefore.toISOString(), strata, newBehaviors: [] });
	}
	/*
	 * Only a run that compares as many requests as the done criterion asks
	 * reads every block and records its plan, whose censuses the report
	 * counts: a smaller one, as make parity's, draws from a bounded part of
	 * the blocks and claims nothing about a stratum's whole population.
	 */
	const meetsCriterion = setup.samplesPerStratum >= API_DIFF_SAMPLES_TARGET;
	let scan: BlockScan = 'bounded';
	if (meetsCriterion) {
		scan = 'every-block';
	}
	const plan = await samplingPlan(setup.store, quietBefore, setup.samplesPerStratum, setup.seed, setup.edgeCaseStaples, scan, setup.stopped);
	// A plan cut short by a stop holds only some of the blocks, so it is no census of any stratum.
	if (isStopped(setup.stopped)) {
		return({ quietBefore: quietBefore.toISOString(), strata, newBehaviors: [] });
	}
	if (meetsCriterion) {
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
	}
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
				// A stop ends what the request waited on, a read of the follower's database among them, which compared nothing.
				if (isStopped(setup.stopped)) {
					return;
				}
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
 * A request of a stratum as a record names it, with the accounts that must
 * be quiet for answers apart to count: every account its path names, which
 * is as many as the sampler asked for or more, and for a block's successor
 * the block's account, which the follower holds within its reach. Nothing
 * when the follower no longer holds that block there.
 */
async function requestOf(stratum: Stratum, path: string, store: APIDiffStore, quietBefore: Date): Promise<SampledRequest | undefined> {
	const matched = routeOf(path);
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
	return({ stratum, route, path, quiet, listsEntities: LISTING_ENTITIES.has(route) });
}

export type APIRecheckSetup = Pick<APIDiffSetup, 'follower' | 'representatives' | 'store' | 'log' | 'stopped'>;

/** How many requests were compared again, by the outcome each had. */
export type APIRecheckSummary = Readonly<Partial<Record<APIDiffOutcome['kind'], number>>>;

/** A request to send again, and the representative to send it to, or none to send it to the first. */
type Pending = { readonly stratum: Stratum; readonly path: string; readonly representative: string | undefined };

export function keyOf(stratum: Stratum, path: string): string {
	return(`${stratum} ${path}`);
}

function followerDivergesOn(record: APIDiffRecord): boolean {
	return(record.outcome.kind === 'diverged' || record.outcome.kind === 'unresolved');
}

/**
 * Whether a later comparison of the identical request settles the
 * divergence: the follower now answers, once normalized, what the
 * representative answered then. A later comparison of a state either side
 * reached since settles nothing about the state the divergence was about,
 * nor does any later answer settle an internal failure that names no code
 * of the API, which another such failure would equal whatever its cause.
 */
export function supersedes(divergence: APIDiffRecord, later: APIDiffRecord): boolean {
	if (divergence.outcome.kind !== 'diverged' && divergence.outcome.kind !== 'unresolved') {
		return(false);
	}
	const { representative } = divergence.outcome;
	if (isAnswer(representative) && isAnonymousFailure(representative)) {
		return(false);
	}
	const then = answerDigest(divergence.path, representative);
	if (then === undefined) {
		return(false);
	}
	switch (later.outcome.kind) {
		case 'match':
			return(later.outcome.digest === then);
		case 'representative-local':
			return(answerDigest(later.path, later.outcome.follower) === then);
		case 'diverged':
		case 'unresolved':
		case 'skipped':
			return(false);
		default:
			return(assertNever(later.outcome));
	}
}

/** The behavior of an internal failure naming no code of the API, of a route and a server error status. */
const ANONYMOUS_FAILURE_BEHAVIOR = /^\/api\/\S* 5\d\d error=internal$/;

/**
 * Whether a match was recorded of two internal failures that name no code
 * of the API, by the behavior of the representative's answer, before such
 * answers were counted as no answer: it shows nothing alike.
 */
function matchedOnAnonymousFailures(record: APIDiffRecord): boolean {
	return(record.outcome.kind === 'match' && record.behaviors.some(function(behavior): boolean {
		return(ANONYMOUS_FAILURE_BEHAVIOR.test(behavior));
	}));
}

/** A divergence a later comparison of the identical request settled, and that comparison. */
export type SupersededDivergence = { readonly divergence: APIDiffRecord; readonly by: APIDiffRecord };

/** A divergence nothing settled or explained, which fails, with the latest comparison after it that was of another state. */
export type OpenDivergence = { readonly divergence: APIDiffRecord; readonly retestedBy: APIDiffRecord | undefined };

/** A divergence a triage record explains, and that record. */
export type ExplainedDivergence = { readonly divergence: APIDiffRecord; readonly explanation: APIDiffExplainedRecord };

/** Where a request stands after its comparisons. */
export type RequestStanding = {
	/** Its latest comparison. */
	readonly latest: APIDiffRecord;
	/** Every divergence of it that no comparison of its own state settled, and no triage explains. */
	readonly open: readonly OpenDivergence[];
	readonly superseded: readonly SupersededDivergence[];
	readonly explained: readonly ExplainedDivergence[];
};

/**
 * How each request compared stands, by its stratum and path, in the order
 * requests were first compared. Each divergence is settled only by a later
 * comparison of its own state, so a divergence of a state that moved on
 * stays open until a triage record explains it.
 */
export function requestStandings(records: readonly APIDiffRecord[], explanations: readonly APIDiffExplainedRecord[]): ReadonlyMap<string, RequestStanding> {
	const standings = new Map<string, { latest: APIDiffRecord; open: OpenDivergence[]; superseded: SupersededDivergence[] }>();
	for (const record of records) {
		if (record.outcome.kind === 'skipped' || matchedOnAnonymousFailures(record)) {
			continue;
		}
		const key = keyOf(record.stratum, record.path);
		const standing = standings.get(key) ?? { latest: record, open: [], superseded: [] };
		standing.latest = record;
		if (followerDivergesOn(record)) {
			standing.open.push({ divergence: record, retestedBy: undefined });
		} else {
			standing.superseded.push(...standing.open.filter(function({ divergence }): boolean {
				return(supersedes(divergence, record));
			}).map(function({ divergence }): SupersededDivergence {
				return({ divergence, by: record });
			}));
			standing.open = standing.open.filter(function({ divergence }): boolean {
				return(!supersedes(divergence, record));
			}).map(function({ divergence }): OpenDivergence {
				return({ divergence, retestedBy: record });
			});
		}
		standings.set(key, standing);
	}
	const explanationOf = function(divergence: APIDiffRecord): APIDiffExplainedRecord | undefined {
		return(explanations.find(function(explanation): boolean {
			return(explanation.stratum === divergence.stratum && explanation.path === divergence.path && explanation.divergenceAt === divergence.at);
		}));
	};
	return(new Map([...standings].map(function([key, { latest, open, superseded }]): [string, RequestStanding] {
		const explained = open.flatMap(function({ divergence }): ExplainedDivergence[] {
			const explanation = explanationOf(divergence);
			if (explanation === undefined) {
				return([]);
			}
			return([{ divergence, explanation }]);
		});
		return([key, {
			latest,
			open: open.filter(function({ divergence }): boolean {
				return(explanationOf(divergence) === undefined);
			}),
			superseded,
			explained
		}]);
	})));
}

/**
 * Whether the request's latest comparison is a divergence a triage
 * explains: it then shows no answer alike, so it is no clean sample, until
 * a later comparison of the request matches or diverges again.
 */
export function standsOnExplanation(standing: RequestStanding): boolean {
	return(standing.open.length === 0 && followerDivergesOn(standing.latest));
}

/** A route's requests in a stratum: how many were compared, and the latest attempt at each never compared. */
export type RouteAttempts = {
	readonly stratum: Stratum;
	readonly route: APIDiffRecord['route'];
	readonly compared: number;
	readonly neverCompared: readonly APIDiffRecord[];
};

/*
 * The share of a route's requests attempted that may go never compared
 * while it counts as covered. The requests skipped are those whose accounts
 * were moving or that went unanswered, so a route most of whose requests
 * are skipped is covered only by the quiet few: a selection, not a sample.
 */
const ROUTE_NEVER_COMPARED_PERCENT = 10;

const PERCENT = 100;

/**
 * Each route's requests of each stratum, by their latest attempt: a request
 * compared counts once it stands on no explained divergence, and one never
 * compared is listed by its latest attempt, which skipped it.
 */
export function routeAttemptsOf(records: readonly APIDiffRecord[], standings: ReadonlyMap<string, RequestStanding>): readonly RouteAttempts[] {
	const latestAttempts = new Map<string, APIDiffRecord>();
	for (const record of records) {
		latestAttempts.set(keyOf(record.stratum, record.path), record);
	}
	const routes = new Map<string, { stratum: Stratum; route: APIDiffRecord['route']; compared: number; neverCompared: APIDiffRecord[] }>();
	const routeOf = function(record: APIDiffRecord) {
		const key = `${record.stratum} ${record.route}`;
		const entry = routes.get(key) ?? { stratum: record.stratum, route: record.route, compared: 0, neverCompared: [] };
		routes.set(key, entry);
		return(entry);
	};
	for (const standing of standings.values()) {
		if (!standsOnExplanation(standing)) {
			routeOf(standing.latest).compared++;
		}
	}
	for (const [key, attempt] of latestAttempts) {
		const standing = standings.get(key);
		if (attempt.outcome.kind === 'skipped' && (standing === undefined || standsOnExplanation(standing))) {
			routeOf(attempt).neverCompared.push(attempt);
		}
	}
	return([...routes.values()]);
}

/** Whether more than the tolerated share of the route's requests attempted were never compared. */
export function routeUncovered({ compared, neverCompared }: RouteAttempts): boolean {
	return(neverCompared.length * PERCENT > ROUTE_NEVER_COMPARED_PERCENT * (compared + neverCompared.length));
}

/**
 * The census each stratum stands on: the latest plan that made one of it,
 * whose population, which may have grown since an older census, is the
 * one to cover. A later plan that drew a sample of the stratum ends it: a
 * plan is recorded only for a run of the done criterion, so its population
 * has grown past that, which no older census covers.
 */
export function standingCensuses(plans: readonly APIDiffPlanRecord[]): ReadonlyMap<Stratum, { readonly plan: APIDiffPlanRecord; readonly requests: readonly string[] }> {
	const censuses = new Map<Stratum, { readonly plan: APIDiffPlanRecord; readonly requests: readonly string[] }>();
	for (const plan of plans) {
		for (const { stratum, population } of plan.strata) {
			switch (population.kind) {
				case 'census':
					censuses.set(stratum, { plan, requests: population.requests });
					break;
				case 'sample':
					censuses.delete(stratum);
					break;
				default:
					assertNever(population);
			}
		}
	}
	return(censuses);
}

/**
 * The requests to send again: each with an open divergence, or whose
 * latest comparison is a divergence a triage explains, to the
 * representative it diverged with; each request of a standing census that
 * has no comparison; and each request never compared of a route left
 * uncovered by them, oldest first, as one skipped as moving can be
 * compared once what it reads is quiet: these to the representative last
 * tried with them.
 */
function pendingOf(records: readonly ParityRecord[]): readonly Pending[] {
	const comparisons = records.filter(function(record): record is APIDiffRecord {
		return(record.kind === 'api-diff');
	});
	const plans = records.filter(function(record): record is APIDiffPlanRecord {
		return(record.kind === 'api-diff-plan');
	});
	const attempted = new Map(comparisons.map(function(record) {
		return([keyOf(record.stratum, record.path), record]);
	}));
	const explanations = records.filter(function(record): record is APIDiffExplainedRecord {
		return(record.kind === 'api-diff-explained');
	});
	const standings = requestStandings(comparisons, explanations);
	const open = [...standings.values()].flatMap(function(standing): Pending[] {
		let latest = standing.open.at(-1)?.divergence;
		if (standsOnExplanation(standing)) {
			latest = standing.latest;
		}
		if (latest === undefined) {
			return([]);
		}
		return([{ stratum: latest.stratum, path: latest.path, representative: latest.representative }]);
	});
	const uncounted = [...standingCensuses(plans)].flatMap(function([stratum, { requests }]): Pending[] {
		return(requests.filter(function(path): boolean {
			return(!standings.has(keyOf(stratum, path)));
		}).map(function(path): Pending {
			return({ stratum, path, representative: attempted.get(keyOf(stratum, path))?.representative });
		}));
	});
	const sending = new Set([...open, ...uncounted].map(function({ stratum, path }): string {
		return(keyOf(stratum, path));
	}));
	const uncovered = routeAttemptsOf(comparisons, standings).filter(routeUncovered).flatMap(function({ neverCompared }): readonly APIDiffRecord[] {
		return(neverCompared);
	}).filter(function(attempt): boolean {
		return(!sending.has(keyOf(attempt.stratum, attempt.path)));
	}).sort(function(left, right): number {
		return(left.at.localeCompare(right.at));
	}).map(function(attempt): Pending {
		return({ stratum: attempt.stratum, path: attempt.path, representative: attempt.representative });
	});
	return([...open, ...uncounted, ...uncovered]);
}

/**
 * Sends again each request whose latest comparison diverged or was
 * unresolved, the identical request to the representative it was compared
 * with, read again from every other, and each request of the latest plan's
 * census not compared yet, and records the outcome, which stands as the
 * request's latest. A representative the run does not reach leaves its
 * requests as they stand.
 */
export async function recheckAPIDivergences(setup: APIRecheckSetup): Promise<APIRecheckSummary> {
	const { heldBefore } = await setup.store.progress();
	if (heldBefore === undefined) {
		throw(new Error('the follower has read from no representative yet'));
	}
	const quietBefore = new Date(heldBefore.getTime() - QUIET_MARGIN_MILLISECONDS);
	const quiet = new QuietAccounts(setup.store, quietBefore);
	const summary: Partial<Record<APIDiffOutcome['kind'], number>> = {};
	for (const pending of pendingOf((await setup.log.read()).records)) {
		let representative = setup.representatives[0];
		if (pending.representative !== undefined) {
			representative = setup.representatives.find(function(source): boolean {
				return(source.endpoint === pending.representative);
			});
		}
		const request = await requestOf(pending.stratum, pending.path, setup.store, quietBefore);
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

/** A triage of an API divergence, as the explain command names it. */
export type DivergenceTriage = Pick<APIDiffExplainedRecord, 'stratum' | 'path' | 'divergenceAt' | 'divergence' | 'reference' | 'untestedBecause'>;

/**
 * Whether a later attempt at the request retested the divergence: compared
 * it again, or found it moving, which shows the state it was about has moved
 * on. One left unanswered shows nothing.
 */
function retests(later: APIDiffRecord): boolean {
	return(later.outcome.kind !== 'skipped' || later.outcome.reason === 'moving');
}

/**
 * Records the triage of an open divergence of the request, named by the
 * moment it was recorded, which closes it. A triage names its evidence,
 * and closes only a divergence a later attempt at the request retested,
 * unless it states why none needs to: a divergence of a state still
 * standing is to be compared again, not explained. A divergence that is
 * not open, settled or explained already or never recorded, is refused.
 */
export async function explainDivergence(log: ParityLog, triage: DivergenceTriage): Promise<APIDiffExplainedRecord> {
	const { records } = await log.read();
	const comparisons = records.filter(function(record): record is APIDiffRecord {
		return(record.kind === 'api-diff');
	});
	const explanations = records.filter(function(record): record is APIDiffExplainedRecord {
		return(record.kind === 'api-diff-explained');
	});
	if (triage.reference.trim() === '') {
		throw(new Error('a triage with no reference names no change or document that explains the divergence'));
	}
	const open = requestStandings(comparisons, explanations).get(keyOf(triage.stratum, triage.path))?.open ?? [];
	const named = open.find(function({ divergence }): boolean {
		return(divergence.at === triage.divergenceAt);
	})?.divergence;
	if (named === undefined) {
		throw(new Error(`no open divergence of ${triage.stratum} ${triage.path} was recorded at ${triage.divergenceAt}`));
	}
	const retested = comparisons.slice(comparisons.indexOf(named) + 1).some(function(later): boolean {
		return(later.stratum === named.stratum && later.path === named.path && retests(later));
	});
	if (!retested && (triage.untestedBecause ?? '').trim() === '') {
		throw(new Error(`no later attempt at ${triage.stratum} ${triage.path} retested the divergence recorded at ${triage.divergenceAt}: send it again with recheck, or force the triage with why no retest is needed`));
	}
	const explained: APIDiffExplainedRecord = { kind: 'api-diff-explained', at: new Date().toISOString(), ...triage };
	await log.append([explained]);
	return(explained);
}
