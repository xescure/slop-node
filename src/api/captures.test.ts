import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { CAPTURE_DIRECTORY, jsonFiles, readCapture, requestPathOf } from '../conformance/api/captures.js';
import { isJSONObject } from '../conformance/api/document.js';
import { loadMainnetFixture, mainnetReplayRepresentative } from '../conformance/mainnet/fixture.js';
import { REPLAY_TIMEOUT_MILLISECONDS } from '../conformance/mainnet/head-replay.js';
import { mainnetNodeConfig, replayOn } from '../conformance/mainnet/replay.js';
import { driverUnderTestNamed } from '../ledger/storage/suite/drivers.js';
import { LocalNode } from '../node/local.js';
import { request } from '../testing/local-node.js';
import type { HTTPAnswer } from '../testing/local-node.js';
import { assertNever } from '../util/assert-never.js';
import { compareText } from '../util/compare-text.js';

const lib = KeetaNet.lib;

const LOOPBACK = '127.0.0.1';

/*
 * A node holding the mainnet head answers each captured request whose answer
 * the head determines, and its answer must be the representative's, but for
 * the normalized fields below. Every other capture is excluded with the
 * reason the head cannot determine it.
 */

/**
 * The fields compared only once normalized, each because two
 * representatives holding the same ledger still answer it differently.
 */
type Normalization =
	/*
	 * An internal failure is named only by an error ID, drawn afresh for each
	 * failure, so no two answers share one.
	 */
	| 'error-id'
	/*
	 * A representative gives a history entry the time of its own vote in the
	 * staple [Keeta TS] index.js:81061-81087. The replay's representative voted
	 * in none of mainnet's staples, so its entries carry the votes' average;
	 * "each side times a history entry by its own vote" checks both times.
	 */
	| 'staple-time'
	/*
	 * A staple's "$binary" is its DER compressed with zlib
	 * [Keeta TS] index.js:81016-81027. Compression is not canonical: this node
	 * rebuilds a staple from its blocks and votes and compresses it with zlib's
	 * defaults, while the representative serves the same DER compressed
	 * differently. The DER, which the client inflates and decodes, is compared
	 * byte for byte instead.
	 */
	| 'staple-encoding';

/** Why a capture is not something the head determines. */
type Exclusion =
	/**
	 * The account, or an account the answer describes, had blocks after the
	 * head, as the evidence capture shows. A permission row has the entity
	 * whose chain holds the block that set it [Keeta TS] index.js:68355-68360,
	 * so a listing that holds a row of an account that moved is not
	 * determined by the head: a later block of that account may have changed
	 * the row, and a principal's listing may also gain rows from any entity.
	 */
	| { readonly kind: 'later-activity'; readonly account: string; readonly evidence: string }
	/** The answer serves blocks added after the head. */
	| { readonly kind: 'later-staples' }
	/** A representative's weight sums the balances of the accounts that chose it, which moved after the head. */
	| { readonly kind: 'later-weight' }
	/** The answer describes the representative itself: its identity, build, statistics, peers, or the moments it added staples at. */
	| { readonly kind: 'node-local'; readonly what: string };

type Verdict =
	| { readonly kind: 'replayed'; readonly normalize: readonly Normalization[] }
	| { readonly kind: 'excluded'; readonly exclusion: Exclusion };

function replayed(...normalize: readonly Normalization[]): Verdict {
	return({ kind: 'replayed', normalize });
}

function excluded(exclusion: Exclusion): Verdict {
	return({ kind: 'excluded', exclusion });
}

/** The key pair account the captures name, whose head on mainnet moved past the head's 1C8C24... */
const USER = 'keeta_aab66dscfdj2k2hrtzeseeofk4o6jiq77t5zijle6g2xgdtdck5wk6thxg4v35a';

/** The base token, KTA, whose chain and supply moved on after the head, and which sets the permissions its listings show. */
const BASE_TOKEN = 'keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg';

const MULTISIG = 'keeta_a733fw4ggvpzh6o4lut6sst6orrs5wmhqwawamideu6aa6ela5gsnztw4vvqm';

const NETWORK_ADDRESS = 'keeta_alwerxoezkupzhifvpo5yvoazlsdqaweov66mokhq7xl4h5ow36v5xu6ek3js';

const USER_LATER = excluded({ kind: 'later-activity', account: USER, evidence: 'ledger-account-keypair.json' });

const BASE_TOKEN_LATER = excluded({ kind: 'later-activity', account: BASE_TOKEN, evidence: 'ledger-account-token.json' });

/**
 * Every capture, and whether the head determines it. A capture about the
 * user is still replayed where its answer cannot depend on the user's later
 * blocks: a chain page that starts at the user's head in the head reads only
 * blocks below it, which never change, and a refusal, an empty page or a
 * hash nothing has is answered before any state is read.
 *
 * One rule covers the permission listings: the head determines one only when
 * every account whose chain sets a row it holds, or could hold, is quiet after
 * the head. Rows are set on the entity's chain, so a listing by entity needs
 * that entity quiet, and a listing by principal needs every entity quiet,
 * which no head shows. KTA is an entity in all five and moved, so all five are
 * excluded; the multisig, which is only a principal, sets none of them.
 */
const VERDICTS: Readonly<Record<string, Verdict>> = {
	'ledger-account-acl-additional-of-entities.json': BASE_TOKEN_LATER,
	'ledger-account-acl-additional.json': BASE_TOKEN_LATER,
	'ledger-account-acl-granted.json': BASE_TOKEN_LATER,
	'ledger-account-acl-of-entities.json': BASE_TOKEN_LATER,
	'ledger-account-acl.json': BASE_TOKEN_LATER,
	'ledger-account-balance-of-token.json': USER_LATER,
	'ledger-account-balance.json': USER_LATER,
	'ledger-account-certificate-unknown.json': replayed(),
	'ledger-account-certificates.json': USER_LATER,
	'ledger-account-chain-fractional-limit.json': replayed(),
	'ledger-account-chain-from-start.json': replayed(),
	'ledger-account-chain-full-page-at-end.json': replayed(),
	'ledger-account-chain-to-end.json': replayed(),
	'ledger-account-chain.json': USER_LATER,
	'ledger-account-head-unknown.json': replayed(),
	'ledger-account-head.json': USER_LATER,
	'ledger-account-history-from-start.json': USER_LATER,
	'ledger-account-history-limit-below-one.json': replayed(),
	'ledger-account-history-limit-empty.json': replayed(),
	'ledger-account-history-limit-fractional.json': USER_LATER,
	'ledger-account-history-limit-negative.json': replayed(),
	'ledger-account-history-limit-not-a-number.json': replayed(),
	'ledger-account-history-limit-zero.json': replayed(),
	'ledger-account-history-start.json': USER_LATER,
	'ledger-account-history.json': USER_LATER,
	'ledger-account-idempotent-unknown.json': replayed(),
	'ledger-account-keypair.json': USER_LATER,
	'ledger-account-malformed.json': replayed(),
	'ledger-account-multisig.json': replayed(),
	'ledger-account-network.json': replayed(),
	'ledger-account-pending.json': USER_LATER,
	'ledger-account-token.json': BASE_TOKEN_LATER,
	'ledger-account-unknown.json': replayed(),
	'ledger-accounts-malformed.json': USER_LATER,
	'ledger-accounts.json': USER_LATER,
	'ledger-block-empty-side.json': replayed(),
	'ledger-block-invalid-side.json': replayed(),
	'ledger-block-malformed.json': replayed('error-id'),
	'ledger-block-side.json': replayed(),
	'ledger-block-successor-unknown.json': replayed(),
	'ledger-block-successor.json': excluded({ kind: 'later-staples' }),
	'ledger-block-unknown.json': replayed(),
	'ledger-block.json': replayed(),
	'ledger-checksum.json': excluded({ kind: 'node-local', what: 'the checksum of every block the representative holds, and when it read it' }),
	'ledger-history-after-final-page.json': replayed(),
	'ledger-history-final-page.json': replayed('staple-time', 'staple-encoding'),
	'ledger-history-from-start.json': excluded({ kind: 'later-staples' }),
	'ledger-history-full-final-page.json': replayed('staple-time', 'staple-encoding'),
	'ledger-history-limit-zero.json': replayed(),
	'ledger-history.json': excluded({ kind: 'later-staples' }),
	'ledger-representative-of-account.json': excluded({ kind: 'later-weight' }),
	'ledger-representative.json': excluded({ kind: 'node-local', what: 'the representative\'s own key' }),
	'ledger-representatives.json': excluded({ kind: 'node-local', what: 'the representative itself and its peers' }),
	'node-bootstrap-votes-fractional-limit.json': excluded({ kind: 'node-local', what: 'the moments the representative added staples at, which order a bootstrap' }),
	'node-bootstrap-votes-malformed-start.json': replayed('error-id'),
	'node-bootstrap-votes-without-start.json': replayed(),
	'node-bootstrap-votes.json': excluded({ kind: 'node-local', what: 'the moments the representative added staples at, which order a bootstrap' }),
	'node-peers.json': excluded({ kind: 'node-local', what: 'the representative\'s peers' }),
	'node-stats.json': excluded({ kind: 'node-local', what: 'the representative\'s statistics' }),
	'node-version.json': excluded({ kind: 'node-local', what: 'the representative\'s build' }),
	'vote-malformed.json': replayed('error-id'),
	'vote-side.json': replayed(),
	'vote-unknown.json': replayed(),
	'vote.json': replayed()
};

/** The accounts replayed captures describe, each with the capture of its state on mainnet. */
const QUIET_ACCOUNTS: readonly { readonly account: string; readonly evidence: string }[] = [
	{ account: MULTISIG, evidence: 'ledger-account-multisig.json' },
	{ account: NETWORK_ADDRESS, evidence: 'ledger-account-network.json' }
];

/** The base64 of the zlib header a staple's compressed bytes start with, 78 9C. */
const ZLIB_BASE64_PREFIX = 'eJ';

const ERROR_ID = /^Internal error occurred \(error ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/;

function normalized(body: unknown, normalization: Normalization): unknown {
	switch (normalization) {
		case 'error-id': {
			if (isJSONObject(body) && typeof body['message'] === 'string' && ERROR_ID.test(body['message'])) {
				return({ ...body, message: 'Internal error occurred (error ID: <error ID>)' });
			}
			return(body);
		}
		case 'staple-time': {
			if (!isJSONObject(body) || !Array.isArray(body['history'])) {
				return(body);
			}
			return({
				...body,
				history: body['history'].map(function(entry: unknown): unknown {
					if (!isJSONObject(entry)) {
						return(entry);
					}
					return({ ...entry, $timestamp: '<the representative\'s own vote>' });
				})
			});
		}
		case 'staple-encoding':
			return(inflatedStaples(body));
		default:
			return(assertNever(normalization));
	}
}

/** The value with each zlib-compressed "$binary" in it, at any depth, replaced by the bytes it inflates to. */
function inflatedStaples(value: unknown): unknown {
	if (Array.isArray(value)) {
		return(value.map(inflatedStaples));
	}
	if (!isJSONObject(value)) {
		return(value);
	}
	const inflated: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(value)) {
		inflated[name] = inflatedStaples(entry);
	}
	const binary = value['$binary'];
	if (typeof binary === 'string' && binary.startsWith(ZLIB_BASE64_PREFIX)) {
		inflated['$binary'] = inflateSync(Buffer.from(binary, 'base64')).toString('base64');
	}
	return(inflated);
}

function normalizedAll(body: unknown, normalize: readonly Normalization[]): unknown {
	return(normalize.reduce(normalized, body));
}

function field(body: unknown, name: string): unknown {
	if (!isJSONObject(body)) {
		throw(new Error(`not an object: ${JSON.stringify(body)}`));
	}
	return(body[name]);
}

function list(body: unknown, name: string): readonly unknown[] {
	const value = field(body, name);
	if (!Array.isArray(value)) {
		throw(new Error(`"${name}" is not a list`));
	}
	return(value);
}

function text(body: unknown, name: string): string {
	const value = field(body, name);
	if (typeof value !== 'string') {
		throw(new Error(`"${name}" is not a string`));
	}
	return(value);
}

/** Every block hash a body serves, at any depth. */
function servedBlockHashes(value: unknown): readonly string[] {
	if (Array.isArray(value)) {
		return(value.flatMap(servedBlockHashes));
	}
	if (!isJSONObject(value)) {
		return([]);
	}
	const own = value['$hash'];
	const nested = Object.values(value).flatMap(servedBlockHashes);
	if (typeof own === 'string') {
		return([own, ...nested]);
	}
	return(nested);
}

function namesWith(kind: Verdict['kind']): readonly string[] {
	return(Object.entries(VERDICTS).filter(function([, verdict]): boolean {
		return(verdict.kind === kind);
	}).map(function([name]): string {
		return(name);
	}));
}

type LaterActivity = Extract<Exclusion, { kind: 'later-activity' }>;

function laterActivityExclusions(): readonly (readonly [string, LaterActivity])[] {
	const found: (readonly [string, LaterActivity])[] = [];
	for (const [name, verdict] of Object.entries(VERDICTS)) {
		if (verdict.kind === 'excluded' && verdict.exclusion.kind === 'later-activity') {
			found.push([name, verdict.exclusion]);
		}
	}
	return(found);
}

function laterStaplesExclusions(): readonly string[] {
	return(Object.entries(VERDICTS).filter(function([, verdict]): boolean {
		return(verdict.kind === 'excluded' && verdict.exclusion.kind === 'later-staples');
	}).map(function([name]): string {
		return(name);
	}));
}

function normalizationsOf(name: string): readonly Normalization[] {
	const verdict = VERDICTS[name];
	if (verdict?.kind !== 'replayed') {
		throw(new Error(`${name} is not replayed`));
	}
	return(verdict.normalize);
}

let served: { readonly node: LocalNode; readonly apiURL: string } | undefined;

beforeAll(async function() {
	const storage = await driverUnderTestNamed('memory').create();
	const node = new LocalNode({ ...mainnetNodeConfig(storage), nodeOptions: { listenIP: LOOPBACK, listenPort: 0 } });
	const replay = await replayOn(node, await loadMainnetFixture('head'));
	expect(replay.deferred).toEqual([]);
	await node.run();
	const apiURL = node.config.endpoints?.api;
	if (apiURL === undefined) {
		throw(new Error('the node advertises no API endpoint'));
	}
	served = { node, apiURL };
}, REPLAY_TIMEOUT_MILLISECONDS);

afterAll(async function() {
	await served?.node.stop();
});

function ask(path: string): Promise<HTTPAnswer> {
	if (served === undefined) {
		throw(new Error('the node holding the head is not running'));
	}
	return(request(served, path));
}

async function headBlockOf(account: string): Promise<unknown> {
	return(field((await ask(`/node/ledger/account/${account}`)).body, 'currentHeadBlock'));
}

describe('a node holding the mainnet head', function() {
	test('every capture is replayed or excluded with its reason', function() {
		expect(Object.keys(VERDICTS).sort()).toEqual(jsonFiles(CAPTURE_DIRECTORY));
	});

	test.each(namesWith('replayed'))('answers %s as the representative did', async function(name) {
		const normalize = normalizationsOf(name);
		const capture = readCapture(name);
		const answer = await ask(requestPathOf(capture));

		expect({ status: answer.status, body: normalizedAll(answer.body, normalize) }).toEqual({ status: capture.status, body: normalizedAll(capture.body, normalize) });
	});

	test('each side times a history entry by its own vote in the staple', async function() {
		const mainnetRepresentative = lib.Account.fromPublicKeyString(text(readCapture('ledger-representative.json').body, 'representative')).assertAccount();
		const timed = namesWith('replayed').filter(function(name): boolean {
			return(normalizationsOf(name).includes('staple-time'));
		});
		let entries = 0;
		for (const name of timed) {
			const capture = readCapture(name);
			const ours = list((await ask(requestPathOf(capture))).body, 'history');
			for (const [index, entry] of list(capture.body, 'history').entries()) {
				const staple = new lib.Vote.Staple(Buffer.from(text(field(entry, 'voteStaple'), '$binary'), 'base64'));
				expect(field(entry, '$timestamp')).toBe(staple.timestamp(mainnetRepresentative).toISOString());
				expect(field(ours[index], '$timestamp')).toBe(staple.timestamp(mainnetReplayRepresentative()).toISOString());
				entries++;
			}
		}
		expect(entries).toBeGreaterThan(0);
	});

	test('the accounts replayed captures describe are where the head left them on mainnet', async function() {
		for (const { account, evidence } of QUIET_ACCOUNTS) {
			expect({ account, head: await headBlockOf(account) }).toEqual({ account, head: field(readCapture(evidence).body, 'currentHeadBlock') });
		}
	});

	test('the chain pages replayed start at the user\'s head in the head', async function() {
		const head = await headBlockOf(USER);
		const chains = namesWith('replayed').filter(function(name): boolean {
			return(name.startsWith('ledger-account-chain'));
		});

		expect(chains.length).toBeGreaterThan(0);
		for (const name of chains) {
			expect({ name, start: readCapture(name).request.query['start'] }).toEqual({ name, start: head });
		}
	});

	test('the permission captures hold a row set on the chain of KTA, which moved, and list it in the order the handlers give', function() {
		const names = [
			'ledger-account-acl-granted.json',
			'ledger-account-acl-of-entities.json',
			'ledger-account-acl.json'
		];
		const orders: Readonly<Record<string, readonly string[]>> = {
			'ledger-account-acl-granted.json': ['principal', 'target'],
			'ledger-account-acl-of-entities.json': ['entity', 'target'],
			'ledger-account-acl.json': ['entity', 'target']
		};
		for (const name of names) {
			const rows = list(readCapture(name).body, 'permissions');
			const keys = rows.map(function(row): string {
				return((orders[name] ?? []).map(function(column): string {
					return(text(row, column));
				}).join('\0'));
			});

			expect({ name, kta: rows.some(function(row): boolean {
				return(text(row, 'entity') === BASE_TOKEN);
			}) }).toEqual({ name, kta: true });
			expect({ name, keys }).toEqual({ name, keys: [...keys].sort(compareText) });
		}
	});

	test('an account excluded for later activity moved past the head on mainnet', async function() {
		const exclusions = laterActivityExclusions();

		expect(exclusions.length).toBeGreaterThan(0);
		for (const [name, { account, evidence }] of exclusions) {
			const mainnetHead = field(readCapture(evidence).body, 'currentHeadBlock');
			expect({ name, head: await headBlockOf(account) }).not.toEqual({ name, head: mainnetHead });
		}
	});

	test('a capture excluded for later staples serves a block the head does not hold', async function() {
		const exclusions = laterStaplesExclusions();

		expect(exclusions.length).toBeGreaterThan(0);
		for (const name of exclusions) {
			const missing = [];
			for (const hash of servedBlockHashes(readCapture(name).body)) {
				if (field((await ask(`/node/ledger/block/${hash}`)).body, 'block') === null) {
					missing.push(hash);
				}
			}
			expect({ name, missing: missing.length > 0 }).toEqual({ name, missing: true });
		}
	});
});
