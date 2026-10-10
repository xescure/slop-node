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
