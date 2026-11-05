// @ts-check
import { readFileSync } from 'node:fs';

/**
 * The cases of the bootstrap simulation the pipeline is measured by: those
 * that read the history in ranges, and those of the retry queue, whose
 * cases are each a second or two. A mutant every case reaches and none
 * kills runs every case it reaches, and the whole simulation takes five
 * minutes, which would make a full run take days; one pass over a peer is
 * measured by its own unit tests (src/node/bootstrap-pass.test.ts).
 */
const PIPELINE_SIMULATION_CASES = {
	'src/node/bootstrap-simulation.test.ts': [
		'reading the history it lacks in ranges, one per peer, while far behind',
		'offers a staple refused for want of weight again only once its voters have the weight, however many pages come before the staple that gives it',
		'offers a staple refused for a balance again once a staple lands on an account it names, long before its wait has passed',
		'offers a staple that stays refused again after a wait that doubles with each refusal, up to the longest, however often passes run',
		'fails a pass rather than move past a refused staple its full queue has no room for, and moves on once the queue drains',
		're-reads the peer, once a full queue stops every pass, for a staple a pass missed that the queued staples need'
	]
};

/** The configuration, of which the peer-to-peer module mutates the parts that close a network to peers, and the config module the rest. */
const CONFIG = 'src/node/config.ts';

/**
 * The parts of config.ts that close a network to its peer-to-peer surface:
 * the public networks, the rule of where a node may vote on each network
 * and the write mode that votes, the networks a node's ID names, and the
 * closure itself with its refusals, that of a node voting in memory among
 * them. Each runs from the line that is "from" to the first line
 * that is "to" after the line "through", or after "from". They are found by
 * their text, so that an edit of config.ts moves them along, and a part whose
 * lines are not there, the first two once each, stops the run
 * (utils/mutation/modules.test.ts runs this in the suite).
 * @type {readonly { readonly from: string; readonly through?: string; readonly to: string }[]}
 */
const CLOSURE_PARTS = [
	{
		from: 'export const PUBLIC_NETWORKS: readonly PublicNetwork[] = [\'main\', \'test\'];',
		through: 'const NON_VOTING_WRITE_MODES: readonly LedgerWriteMode[] = WRITE_MODES.filter(function(mode): boolean {',
		to: '});'
	},
	{ from: 'function networkWithID(id: bigint): NetworkSelection | undefined {', to: '}' },
	{ from: 'export function publicNetworkOf(selection: NetworkSelection): PublicNetwork | undefined {', to: '}' },
	{
		from: 'type P2PClosure =',
		through: 'function refuseVotesInMemory(network: NetworkSelection, ledgerWriteMode: LedgerWriteMode, storage: StorageChoice): void {',
		to: '}'
	}
];

/**
 * The lines of config.ts that hold its parts that close a network to peers,
 * in the order of the file, read from that source.
 * @param {string} source
 * @returns {{ first: number; last: number }[]}
 */
function closureLines(source) {
	const lines = source.split('\n');
	/** @param {string} text */
	function onlyLine(text) {
		const index = lines.indexOf(text);
		if (index < 0 || lines.indexOf(text, index + 1) >= 0) {
			throw(new Error(`${CONFIG} has not exactly one line '${text}'`));
		}
		return(index);
	}
	return(CLOSURE_PARTS.map(function(part) {
		const first = onlyLine(part.from);
		const last = lines.indexOf(part.to, onlyLine(part.through ?? part.from));
		if (last < 0) {
			throw(new Error(`${CONFIG} has no line '${part.to}' to end the part from '${part.from}'`));
		}
		return({ first: first + 1, last: last + 1 });
	}).sort(function(left, right) {
		return(left.first - right.first);
	}));
}

/**
 * The ranges of config.ts Stryker mutates for its parts that close a network
 * to peers, read from that source.
 * @param {string} source
 * @returns {string[]}
 */
export function closureRanges(source) {
	return(closureLines(source).map(function({ first, last }) {
		return(`${CONFIG}:${String(first)}-${String(last)}`);
	}));
}

/**
 * The ranges of config.ts Stryker mutates for the rest of it: every line the
 * parts that close a network to peers leave, so that no mutant of the file
 * is in both modules, nor in neither.
 * @param {string} source
 * @returns {string[]}
 */
export function restOfConfigRanges(source) {
	const lineCount = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
	/** @type {string[]} */
	const ranges = [];
	let next = 1;
	for (const { first, last } of [...closureLines(source), { first: lineCount + 1, last: lineCount }]) {
		if (first > next) {
			ranges.push(`${CONFIG}:${String(next)}-${String(first - 1)}`);
		}
		next = last + 1;
	}
	return(ranges);
}

/**
 * The modules "make mutation MODULE=<name>" mutates, each with the tests that
 * stand for its contract. A module is measured by its own tests, so a mutant
 * counts as killed only when a test of that contract notices it. A module's
 * ignorers, from mutation/ignorers.js, name code its score leaves out, and
 * its selected cases, by test file and the name of a case or of a block of
 * cases, the only cases of those files its runs run (mutation/select-cases.js).
 * @type {Readonly<Record<string, { readonly mutate: readonly string[]; readonly tests: readonly string[]; readonly ignorers: readonly string[]; readonly selectedCases: Readonly<Record<string, readonly string[]>> }>>}
 */
const MODULES = {
	storage: {
		mutate: [
			'src/ledger/storage/base.ts',
			'src/ledger/storage/confirmed.ts',
			'src/ledger/storage/expiry.ts',
			'src/ledger/storage/stage.ts',
			'src/ledger/storage/memory/*.ts'
		],
		tests: ['src/ledger/storage/**/*.test.ts'],
		ignorers: [],
		selectedCases: {}
	},
	postgres: {
		mutate: ['src/ledger/storage/postgres/*.ts', '!src/ledger/storage/postgres/*.test.ts'],
		tests: ['src/ledger/storage/drivers.test.ts', 'src/ledger/storage/postgres/*.test.ts'],
		// The SQL is measured by the suite and the corpus, not by mutating its text.
		ignorers: ['postgres-sql'],
		selectedCases: {}
	},
	/*
	 * The bootstrap is mutated in three modules, so that a mutant runs only
	 * the tests of its part: the client and how it reaches its peers and
	 * stores its progress, tested against nodes over HTTP; one pass over a
	 * peer and what a page's votes show of how far it read, tested against
	 * simulated peers; and the ranges, the stage and
	 * the retry queue that carry what the passes read into the ledger.
	 */
	'bootstrap-client': {
		mutate: [
			'src/node/bootstrap.ts',
			'src/node/bootstrap-cursors.ts',
			'src/node/bootstrap-pacing.ts',
			'src/node/bootstrap-page.ts',
			'src/node/bootstrap-peers.ts',
			'src/node/bootstrap-update.ts'
		],
		tests: [
			'src/node/bootstrap.test.ts',
			'src/node/bootstrap-mainnet.test.ts',
			'src/node/bootstrap-page.test.ts',
			'src/node/bootstrap-cursors.test.ts',
			'src/node/bootstrap-pacing.test.ts',
			'src/node/bootstrap-update.test.ts'
		],
		ignorers: [],
		selectedCases: {}
	},
	'bootstrap-pass': {
		mutate: ['src/node/bootstrap-pass.ts', 'src/node/bootstrap-evidence.ts', 'src/node/bootstrap-window.ts'],
		tests: ['src/node/bootstrap-pass.test.ts', 'src/node/bootstrap-evidence.test.ts', 'src/node/bootstrap-window.test.ts'],
		ignorers: [],
		selectedCases: {}
	},
	'bootstrap-pipeline': {
		mutate: ['src/node/bootstrap-ranges.ts', 'src/node/bootstrap-stage.ts', 'src/node/bootstrap-retry.ts'],
		tests: ['src/node/bootstrap-ranges.test.ts', 'src/node/bootstrap-stage.test.ts', 'src/node/bootstrap-retry.test.ts', 'src/node/bootstrap-simulation.test.ts'],
		ignorers: [],
		selectedCases: PIPELINE_SIMULATION_CASES
	},
	/*
	 * The API's parameters, errors and handlers, measured by the API's own
	 * tests: the contract against the API document, the routes' answers, and
	 * the mainnet captures a node holding the head replays. The peer-to-peer
	 * routes are measured with the peer-to-peer safety code instead.
	 */
	api: {
		mutate: ['src/api/*.ts', '!src/api/*.test.ts', '!src/api/p2p.ts'],
		tests: ['src/api/*.test.ts'],
		ignorers: [],
		selectedCases: {}
	},
	/*
	 * The peer-to-peer surface and what keeps it closed: the routes peers
	 * post to, the /p2p WebSocket, the peers the store remembers and the
	 * bounds on what peers send, how the node holds the switch's connections
	 * until the switch lets go of them, and the parts of config.ts that close
	 * a network to peers (CLOSURE_PARTS). The rest of config.ts is its own
	 * module. The API's route-table case imports the table as it runs, so
	 * that a route of p2p.ts broken as it loads fails that case rather than
	 * every file that loads the node.
	 */
	p2p: {
		/* Read only when asked: a run's sandbox holds config.ts instrumented, where the parts' lines are not. */
		get mutate() {
			return([
				'src/api/p2p.ts',
				'src/node/peers.ts',
				'src/node/peer-store.ts',
				'src/node/peer-limits.ts',
				'src/node/connections.ts',
				...closureRanges(readFileSync(CONFIG, 'utf8'))
			]);
		},
		tests: [
			'src/node/p2p.test.ts',
			'src/node/peers.test.ts',
			'src/node/connections.test.ts',
			'src/node/peer-store.test.ts',
			'src/node/configured-peers.test.ts',
			'src/node/config.test.ts',
			'src/node/local.test.ts',
			'src/api/index.test.ts'
		],
		ignorers: [],
		selectedCases: {}
	},
	/*
	 * How the node reads its environment, and the node upstream is given from
	 * it: the rest of config.ts, measured by its own tests, by the genesis
	 * command's, which reads the node's variables through it, and by the
	 * follower's, which is a node configured through it; and the staples the
	 * network it selects adds without a quorum, measured by their own tests.
	 */
	config: {
		/* Read only when asked, as the peer-to-peer module's is. */
		get mutate() {
			return([...restOfConfigRanges(readFileSync(CONFIG, 'utf8')), 'src/node/admitted-staples.ts']);
		},
		tests: [
			'src/node/config.test.ts',
			'src/node/configured-peers.test.ts',
			'src/node/genesis.test.ts',
			'src/parity/follower-config.test.ts',
			'src/node/admitted-staples.test.ts'
		],
		ignorers: [],
		selectedCases: {}
	},
	/*
	 * When the node runs the projection backfill beside itself: once it has
	 * caught up, between batches only while it stays so, again after a
	 * failure, and no further once stopped; measured by its own tests, with
	 * the backfill and the node's state stood in for.
	 */
	'projection-backfill': {
		mutate: ['src/node/projection-backfill.ts'],
		tests: ['src/node/projection-backfill.test.ts'],
		ignorers: [],
		selectedCases: {}
	}
};

/**
 * The module of the name.
 * @param {string} name
 */
export function moduleNamed(name) {
	const module = MODULES[name];
	if (module === undefined) {
		throw(new Error(`unknown mutation module '${name}'; the modules are: ${Object.keys(MODULES).join(', ')}`));
	}
	// Spreading the module would read what it mutates, which only Stryker's own configuration asks for.
	return({
		name,
		get mutate() {
			return(module.mutate);
		},
		tests: module.tests,
		ignorers: module.ignorers,
		selectedCases: module.selectedCases
	});
}

/** The module the environment names, as make passes it to both configurations. */
export function selectedModule() {
	return(moduleNamed(process.env.SLOP_NODE_MUTATION_MODULE ?? ''));
}
