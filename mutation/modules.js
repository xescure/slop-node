// @ts-check

/**
 * The modules "make mutation MODULE=<name>" mutates, each with the tests that
 * stand for its contract. A module is measured by its own tests, so a mutant
 * counts as killed only when a test of that contract notices it. A module's
 * ignorers, from mutation/ignorers.js, name code its score leaves out.
 * @type {Readonly<Record<string, { readonly mutate: readonly string[]; readonly tests: readonly string[]; readonly ignorers: readonly string[] }>>}
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
		ignorers: []
	},
	postgres: {
		mutate: ['src/ledger/storage/postgres/*.ts', '!src/ledger/storage/postgres/*.test.ts'],
		tests: ['src/ledger/storage/drivers.test.ts', 'src/ledger/storage/postgres/*.test.ts'],
		// The SQL is measured by the suite and the corpus, not by mutating its text.
		ignorers: ['postgres-sql']
	},
	/*
	 * The bootstrap is mutated in three modules, so that a mutant runs only
	 * the tests of its part: the client and how it reaches its peers and
	 * stores its progress, tested against nodes over HTTP; one pass over a
	 * peer, tested against simulated peers; and the ranges, the stage and
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
		ignorers: []
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
