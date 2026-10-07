import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { TEST_NETWORK_SEEDS } from '../testing/network.js';
import {
	VOTE_CASE_FORMAT,
	decodeVoteCaseFile,
	encodeVoteCaseFile,
	toBase64,
	toCaseAccount,
	toCaseBlockHash,
	toCaseSeed,
	toDecimal,
	toMoment
} from './case.js';
import type { CaseAction, CaseExpectation, CaseStep, VoteCase, VoteCaseFile } from './case.js';
import { voteCaseViolations } from './schema.js';

const lib = KeetaNet.lib;

const START = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

function bytesOf(...values: number[]): Uint8Array {
	return(Uint8Array.from(values));
}

function hashOf(fill: string): ReturnType<typeof toCaseBlockHash> {
	return(toCaseBlockHash(new lib.Block.Hash(fill.repeat(64))));
}

const holder = toCaseAccount(lib.Account.fromSeed(TEST_NETWORK_SEEDS.user, 0));
const representative = toCaseAccount(lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 1));
const baseToken = toCaseAccount(lib.Account.generateBaseAddresses(0n).baseToken);

/** One step of every action, expectation, reference and fee shape. */
const steps: readonly CaseStep[] = [
	{ moment: toMoment(START), actor: 0, action: { type: 'add', staple: { type: 'literal', kind: 'staple', bytes: toBase64(bytesOf(1, 2, 3)) } }, expect: { outcome: 'added' } },
	{
		moment: toMoment(START),
		actor: 0,
		action: { type: 'quote', blocks: [toBase64(bytesOf(4))] },
		expect: { outcome: 'quote', blocks: [hashOf('A')], fee: { type: 'single', amount: toDecimal(5n), token: baseToken, payTo: representative } }
	},
	{
		moment: toMoment(new Date(START.getTime() + 1)),
		actor: 1,
		action: { type: 'vote', blocks: [toBase64(bytesOf(4))] },
		expect: { outcome: 'temporary', blocks: [hashOf('A')], fee: { type: 'choices', choices: [{ amount: toDecimal(0n) }, { amount: toDecimal(7n), token: baseToken }] } }
	},
	{
		moment: toMoment(START),
		actor: 0,
		action: {
			type: 'vote',
			blocks: [toBase64(bytesOf(4)), toBase64(bytesOf(5))],
			otherVotes: [{ type: 'step', fromStep: 2 }, { type: 'literal', kind: 'vote', bytes: toBase64(bytesOf(6)) }],
			quote: { type: 'step', fromStep: 1 }
		},
		expect: { outcome: 'permanent', blocks: [hashOf('A'), hashOf('B')], fee: { type: 'none' } }
	},
	{ moment: toMoment(START), actor: 0, action: { type: 'vote', blocks: [], otherVotes: [] }, expect: { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_MISSING_BLOCKS' } } },
	{
		moment: toMoment(START),
		actor: 0,
		action: { type: 'vote', blocks: [toBase64(bytesOf(4))] },
		expect: { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_IDEMPOTENT_KEY_EXISTS', blockhash: hashOf('C'), existingBlockhash: hashOf('D') } }
	},
	{
		moment: toMoment(START),
		actor: 1,
		action: { type: 'vote', blocks: [toBase64(bytesOf(4))] },
		expect: { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_NOT_SUCCESSOR', accounts: [representative, holder] } }
	},
	{ moment: toMoment(START), actor: 1, action: { type: 'gc' }, expect: { outcome: 'collected' } },
	{ moment: toMoment(START), actor: 1, action: { type: 'quote', blocks: [] }, expect: { outcome: 'refused', error: { type: 'plain', message: 'May not issue votes in read-only mode, in no-voting mode' } } },
	{ moment: toMoment(START), actor: 2, action: { type: 'add', staple: { type: 'step', fromStep: 0 }, from: 'bootstrap' }, expect: { outcome: 'added' } },
	{
		moment: toMoment(START),
		actor: 0,
		action: { type: 'vote', blocks: [toBase64(bytesOf(4))], otherVotes: [{ type: 'literal', kind: 'quote', bytes: toBase64(bytesOf(7)) }], quote: { type: 'literal', kind: 'vote', bytes: toBase64(bytesOf(8)) } },
		expect: { outcome: 'rejectedInput', error: { type: 'coded', code: 'VOTE_EXPIRED' } }
	},
	{ moment: toMoment(START), actor: 2, action: { type: 'vote', blocks: [toBase64(bytesOf(4))] }, expect: { outcome: 'rejectedInput', error: { type: 'plain', message: 'not a block' } } },
	{ moment: toMoment(START), actor: 1, action: { type: 'add', staple: { type: 'step', fromStep: 0 } }, expect: { outcome: 'refused', error: { type: 'coded', code: 'LEDGER_BLOCK_ALREADY_EXISTS' } } }
];

const voteCase: VoteCase = {
	id: 'X1',
	title: 'every shape the format has',
	basis: 'upstream',
	network: {
		id: '0',
		seeds: {
			trustedRoot: toCaseSeed(TEST_NETWORK_SEEDS.trustedRoot),
			representative: toCaseSeed(TEST_NETWORK_SEEDS.representative),
			user: toCaseSeed(TEST_NETWORK_SEEDS.user)
		},
		representativeWeights: [toDecimal(400n), toDecimal(300n)]
	},
	nodes: [
		{
			representative: 0,
			fee: { type: 'flat', amount: toDecimal(5n), token: baseToken, payTo: representative },
			mode: 'read-write',
			operations: { enableTokenAdminModifyBalance: true, setRep: 'refuseAll' }
		},
		{
			representative: 1,
			fee: { type: 'choices', choices: [{ amount: toDecimal(0n) }, { amount: toDecimal(7n), token: baseToken, payTo: holder }] },
			mode: 'no-voting',
			subnet: toDecimal(5n),
			operations: { setRep: 'allowAll' }
		},
		{ representative: null, fee: { type: 'free' }, mode: 'bootstrap-only' }
	],
	steps
};

const file: VoteCaseFile = {
	format: VOTE_CASE_FORMAT,
	keetanetClient: '0.18.7',
	cases: [voteCase, { ...voteCase, id: 'X2', basis: 'contract', nodes: [{ representative: null, fee: { type: 'free' }, mode: 'read-only' }], steps: steps.slice(0, 1) }]
};

type JSONTree = { [key: string]: unknown };

/** The encoded file as a mutable tree, so a test can break one field. */
function encodedTree(): JSONTree {
	const tree: unknown = JSON.parse(encodeVoteCaseFile(file));
	if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
		throw(new Error('the encoded file is not an object'));
	}
	return(Object.fromEntries(Object.entries(tree)));
}

/** The object at a path of keys and indexes below the root. */
function nodeAt(tree: JSONTree, path: readonly (string | number)[]): object {
	let node: unknown = tree;
	for (const step of path) {
		if (typeof node !== 'object' || node === null) {
			throw(new Error(`no object on the way to ${path.join('.')}`));
		}
		node = Reflect.get(node, step);
	}
	if (typeof node !== 'object' || node === null) {
		throw(new Error(`no object at ${path.join('.')}`));
	}
	return(node);
}

function setIn(tree: JSONTree, path: readonly (string | number)[], key: string, value: unknown): void {
	Reflect.set(nodeAt(tree, path), key, value);
}

function deleteIn(tree: JSONTree, path: readonly (string | number)[], key: string): void {
	Reflect.deleteProperty(nodeAt(tree, path), key);
}

describe('vote case format', function() {
	test('decoding the encoded file gives the file back', function() {
		const text = encodeVoteCaseFile(file);

		expect(decodeVoteCaseFile(text)).toEqual(file);
		expect(encodeVoteCaseFile(decodeVoteCaseFile(text))).toBe(text);
	});

	test('the encoding has a fixed key order, two-space indentation and a trailing newline', function() {
		const reordered: VoteCaseFile = {
			cases: file.cases.map(function(entry): VoteCase {
				return({ steps: entry.steps, nodes: entry.nodes, network: entry.network, basis: entry.basis, title: entry.title, id: entry.id });
			}),
			keetanetClient: file.keetanetClient,
			format: file.format
		};
		const text = encodeVoteCaseFile(file);

		expect(encodeVoteCaseFile(reordered)).toBe(text);
		expect(text.startsWith('{\n  "format": "slop-node/vote-cases@1",\n  "keetanetClient": "0.18.7",\n  "cases": [\n')).toBe(true);
		expect(text.endsWith('}\n')).toBe(true);
		expect(text.endsWith('\n\n')).toBe(false);
	});

	test('references are written as {fromStep} or {kind, bytes}', function() {
		const action = nodeAt(encodedTree(), ['cases', 0, 'steps', 3, 'action']);

		expect(action).toEqual({
			type: 'vote',
			blocks: [toBase64(bytesOf(4)), toBase64(bytesOf(5))],
			otherVotes: [{ fromStep: 2 }, { kind: 'vote', bytes: toBase64(bytesOf(6)) }],
			quote: { fromStep: 1 }
		});
		expect(nodeAt(encodedTree(), ['cases', 0, 'steps', 9, 'action'])).toEqual({ type: 'add', staple: { fromStep: 0 }, from: 'bootstrap' });
		expect(nodeAt(encodedTree(), ['cases', 0, 'nodes', 2])).toEqual({ representative: null, fee: { type: 'free' }, mode: 'bootstrap-only' });
	});

	test('a node\'s subnet and operations follow its mode, and are absent unless set', function() {
		const tree = encodedTree();

		expect(Object.keys(nodeAt(tree, ['cases', 0, 'nodes', 0]))).toEqual(['representative', 'fee', 'mode', 'operations']);
		expect(Object.keys(nodeAt(tree, ['cases', 0, 'nodes', 1]))).toEqual(['representative', 'fee', 'mode', 'subnet', 'operations']);
		expect(Object.keys(nodeAt(tree, ['cases', 0, 'nodes', 2]))).toEqual(['representative', 'fee', 'mode']);
		expect(nodeAt(tree, ['cases', 0, 'nodes', 0, 'operations'])).toEqual({ enableTokenAdminModifyBalance: true, setRep: 'refuseAll' });
		expect(Reflect.get(nodeAt(tree, ['cases', 0, 'nodes', 1]), 'subnet')).toBe('5');
		expect(nodeAt(tree, ['cases', 0, 'nodes', 1, 'fee'])).toEqual({ type: 'choices', choices: [{ amount: '0' }, { amount: '7', token: baseToken, payTo: holder }] });
	});

	test('every case states its basis, after its title', function() {
		const tree = encodedTree();

		expect(Object.keys(nodeAt(tree, ['cases', 0]))).toEqual(['id', 'title', 'basis', 'network', 'nodes', 'steps']);
		expect(Reflect.get(nodeAt(tree, ['cases', 0]), 'basis')).toBe('upstream');
		expect(Reflect.get(nodeAt(tree, ['cases', 1]), 'basis')).toBe('contract');
	});

	test('an absent list of other votes stays distinct from an empty one', function() {
		const decoded = decodeVoteCaseFile(encodeVoteCaseFile(file));
		const plain = decoded.cases[0]?.steps[2]?.action;
		const empty = decoded.cases[0]?.steps[4]?.action;

		expect(plain).toEqual({ type: 'vote', blocks: [toBase64(bytesOf(4))] });
		expect(empty).toEqual({ type: 'vote', blocks: [], otherVotes: [] });
	});

	test.each([
		['an unknown top-level field', function(tree: JSONTree): void {
			tree['extra'] = true;
		}, /^cases file\.extra: unexpected field$/, true],
		['another format', function(tree: JSONTree): void {
			tree['format'] = 'slop-node/vote-cases@2';
		}, /format: expected "slop-node\/vote-cases@1"/, true],
		['a missing expectation', function(tree: JSONTree): void {
			deleteIn(tree, ['cases', 0, 'steps', 0], 'expect');
		}, /^cases file\.cases\[0\]\.steps\[0\]\.expect: missing field$/, true],
		['an unknown action', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 0, 'action'], 'type', 'publish');
		}, /cases\[0\]\.steps\[0\]\.action\.type: unknown value "publish"/, true],
		['a field another action carries', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 7, 'action'], 'blocks', []);
		}, /cases\[0\]\.steps\[7\]\.action\.blocks: unexpected field/, true],
		['bytes that are not canonical base64', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 0, 'action', 'staple'], 'bytes', `${toBase64(bytesOf(1, 2, 3))}=`);
		}, /cases\[0\]\.steps\[0\]\.action\.staple\.bytes: expected canonical base64/, true],
		['an amount that is not a decimal', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 0, 'fee'], 'amount', '05');
		}, /cases\[0\]\.nodes\[0\]\.fee\.amount: expected a decimal integer/, true],
		['a weight of zero', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'network', 'representativeWeights'], '0', '0');
		}, /representativeWeights\[0\]: expected a positive weight/, true],
		['a moment without milliseconds', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 0], 'moment', '2026-01-01T00:00:00Z');
		}, /cases\[0\]\.steps\[0\]\.moment: expected an ISO-8601 UTC moment with milliseconds/, true],
		['an actor without a node', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 0], 'actor', 3);
		}, /cases\[0\]\.steps\[0\]\.actor: expected a node index below 3/, false],
		['a non-integer actor', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 0], 'actor', 0.5);
		}, /cases\[0\]\.steps\[0\]\.actor: expected a node index/, true],
		['a node of a representative the network lacks', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 0], 'representative', 2);
		}, /cases\[0\]\.nodes\[0\]\.representative: expected null or a representative index below 2/, false],
		['two nodes of one representative', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 1], 'representative', 0);
		}, /cases\[0\]\.nodes\[1\]\.representative: representative 0 already runs a node/, false],
		['a case without nodes', function(tree: JSONTree): void {
			setIn(tree, ['cases', 1], 'nodes', []);
		}, /cases\[1\]\.nodes: expected at least one node/, true],
		['a reference to a later step', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 3, 'action', 'otherVotes', 0], 'fromStep', 3);
		}, /otherVotes\[0\]\.fromStep: expected an earlier step that produced a vote or quote/, false],
		['a vote reference to an add step', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 3, 'action', 'quote'], 'fromStep', 0);
		}, /quote\.fromStep: expected an earlier step that produced a vote or quote/, false],
		['a step reference with a kind', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 3, 'action', 'otherVotes', 0], 'kind', 'vote');
		}, /otherVotes\[0\]\.kind: unexpected field/, true],
		['literal bytes without a kind', function(tree: JSONTree): void {
			deleteIn(tree, ['cases', 0, 'steps', 3, 'action', 'otherVotes', 1], 'kind');
		}, /otherVotes\[1\]\.kind: missing field/, true],
		['a staple among the other votes', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 3, 'action', 'otherVotes', 1], 'kind', 'staple');
		}, /otherVotes\[1\]\.kind: unknown value "staple"/, true],
		['a vote given as a staple', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 0, 'action', 'staple'], 'kind', 'vote');
		}, /steps\[0\]\.action\.staple\.kind: unknown value "vote"/, true],
		['a staple reference to a step that is not an add', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 9, 'action', 'staple'], 'fromStep', 1);
		}, /steps\[9\]\.action\.staple\.fromStep: expected an earlier add step that carries its staple/, false],
		['a chained staple reference', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 12, 'action', 'staple'], 'fromStep', 9);
		}, /steps\[12\]\.action\.staple\.fromStep: expected an earlier add step that carries its staple/, false],
		['an add source that is not a string', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 9, 'action'], 'from', 5);
		}, /steps\[9\]\.action\.from: expected a string/, true],
		['a message on a coded error', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 4, 'expect', 'error'], 'message', 'not pinned');
		}, /steps\[4\]\.expect\.error\.message: unexpected field/, true],
		['the driver wrapping code', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 4, 'expect', 'error'], 'code', 'LEDGER_OTHER');
		}, /steps\[4\]\.expect\.error\.code: LEDGER_OTHER is a driver's wrapping; record its cause/, true],
		['an unknown error code', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 4, 'expect', 'error'], 'code', 'LEDGER_NOPE');
		}, /error\.code: unknown error code "LEDGER_NOPE"/, false],
		['accounts out of code-point order', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 6, 'expect', 'error'], 'accounts', [holder, representative]);
		}, /steps\[6\]\.expect\.error\.accounts\[1\]: expected accounts in code-point order, each once/, false],
		['an account listed twice', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 6, 'expect', 'error'], 'accounts', [holder, holder]);
		}, /steps\[6\]\.expect\.error\.accounts\[1\]: expected accounts in code-point order, each once/, true],
		['a block hash in lowercase', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'steps', 1, 'expect', 'blocks'], '0', 'a'.repeat(64));
		}, /expect\.blocks\[0\]: expected an uppercase hex block hash/, true],
		['an account that does not parse', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 0, 'fee'], 'payTo', 'keeta_nope');
		}, /cases\[0\]\.nodes\[0\]\.fee\.payTo: expected a keeta_ account/, false],
		['a fee policy with no choices', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 1, 'fee'], 'choices', []);
		}, /cases\[0\]\.nodes\[1\]\.fee\.choices: expected at least one choice/, true],
		['a fee choice with a field of the policy', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 1, 'fee', 'choices', 0], 'type', 'flat');
		}, /nodes\[1\]\.fee\.choices\[0\]\.type: unexpected field/, true],
		['a subnet that is not a decimal', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 1], 'subnet', 5);
		}, /cases\[0\]\.nodes\[1\]\.subnet: expected a string/, true],
		['empty operations', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 1], 'operations', {});
		}, /cases\[0\]\.nodes\[1\]\.operations: expected at least one setting/, true],
		['an unknown operations setting', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 0, 'operations'], 'setRepPolicy', 'allowAll');
		}, /nodes\[0\]\.operations\.setRepPolicy: unexpected field/, true],
		['an operations switch that is not a boolean', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 0, 'operations'], 'enableTokenAdminModifyBalance', 'true');
		}, /nodes\[0\]\.operations\.enableTokenAdminModifyBalance: expected a boolean/, true],
		['a setRep policy that is not a constant', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 0, 'operations'], 'setRep', 'weightedOnly');
		}, /nodes\[0\]\.operations\.setRep: unknown value "weightedOnly"/, true],
		['an unknown ledger mode', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0, 'nodes', 0], 'mode', 'write-only');
		}, /cases\[0\]\.nodes\[0\]\.mode: unknown value "write-only"/, true],
		['a case without a basis', function(tree: JSONTree): void {
			deleteIn(tree, ['cases', 0], 'basis');
		}, /^cases file\.cases\[0\]\.basis: missing field$/, true],
		['an unknown basis', function(tree: JSONTree): void {
			setIn(tree, ['cases', 0], 'basis', 'driver');
		}, /cases\[0\]\.basis: unknown value "driver"/, true],
		['a duplicate case', function(tree: JSONTree): void {
			setIn(tree, ['cases', 1], 'id', 'X1');
		}, /cases\[1\]\.id: duplicate case "X1"/, false]
	])('decoding rejects %s', function(_name, change, message, schemaRejects) {
		const tree = encodedTree();
		change(tree);
		const text = JSON.stringify(tree);

		expect(function() {
			return(decodeVoteCaseFile(text));
		}).toThrow(message);
		// The schema checks structure only; references, ranges and code lists need the decoder.
		expect(voteCaseViolations(JSON.parse(text)).length > 0).toBe(schemaRejects);
	});

	describe('a step\'s outcome must be one its action can have', function() {
		const actions: Readonly<Record<CaseAction['type'], CaseAction>> = {
			add: { type: 'add', staple: { type: 'literal', kind: 'staple', bytes: toBase64(bytesOf(1)) } },
			vote: { type: 'vote', blocks: [toBase64(bytesOf(4))] },
			quote: { type: 'quote', blocks: [toBase64(bytesOf(4))] },
			gc: { type: 'gc' }
		};
		const expectations: Readonly<Record<CaseExpectation['outcome'], CaseExpectation>> = {
			added: { outcome: 'added' },
			collected: { outcome: 'collected' },
			temporary: { outcome: 'temporary', blocks: [hashOf('A')], fee: { type: 'none' } },
			permanent: { outcome: 'permanent', blocks: [hashOf('A')], fee: { type: 'none' } },
			quote: { outcome: 'quote', blocks: [hashOf('A')], fee: { type: 'single', amount: toDecimal(0n) } },
			rejectedInput: { outcome: 'rejectedInput', error: { type: 'coded', code: 'VOTE_EXPIRED' } },
			refused: { outcome: 'refused', error: { type: 'plain', message: 'no' } }
		};
		// Only a vote produces votes and only a quote a quote; gc parses no input, so nothing it is given can be rejected.
		const allowed: Readonly<Record<CaseAction['type'], readonly CaseExpectation['outcome'][]>> = {
			add: ['added', 'refused', 'rejectedInput'],
			vote: ['temporary', 'permanent', 'refused', 'rejectedInput'],
			quote: ['quote', 'refused', 'rejectedInput'],
			gc: ['collected', 'refused']
		};
		const pairs = Object.values(actions).flatMap(function(action) {
			return(Object.values(expectations).map(function(expectation) {
				return({ action, expectation, valid: allowed[action.type].includes(expectation.outcome) });
			}));
		});

		test.each(pairs)('$action.type with $expectation.outcome is valid: $valid', function({ action, expectation, valid }) {
			const text = encodeVoteCaseFile({ ...file, cases: [{ ...voteCase, steps: [{ moment: toMoment(START), actor: 0, action, expect: expectation }] }] });

			if (valid) {
				expect(decodeVoteCaseFile(text).cases[0]?.steps[0]?.expect).toEqual(expectation);
				expect(voteCaseViolations(JSON.parse(text))).toEqual([]);
			} else {
				expect(function() {
					return(decodeVoteCaseFile(text));
				}).toThrow(`cases file.cases[0].steps[0].expect.outcome: a ${action.type} step cannot have the outcome "${expectation.outcome}"`);
				expect(voteCaseViolations(JSON.parse(text)).length > 0).toBe(true);
			}
		});
	});

	test('the schema accepts every shape the format has', function() {
		expect(voteCaseViolations(JSON.parse(encodeVoteCaseFile(file)))).toEqual([]);
	});

	test('decoding rejects text that is not JSON', function() {
		expect(function() {
			return(decodeVoteCaseFile('{'));
		}).toThrow(/cases file: not JSON/);
	});
});
