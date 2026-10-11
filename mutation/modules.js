// @ts-check

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
	}
};

/** The module the environment names, as make passes it to both configurations. */
export function selectedModule() {
	const name = process.env.SLOP_NODE_MUTATION_MODULE ?? '';
	const module = MODULES[name];
	if (module === undefined) {
		throw(new Error(`unknown mutation module '${name}'; the modules are: ${Object.keys(MODULES).join(', ')}`));
	}
	return({ name, ...module });
}
