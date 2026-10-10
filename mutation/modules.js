// @ts-check

/**
 * The modules "make mutation MODULE=<name>" mutates, each with the tests that
 * stand for its contract. A module is measured by its own tests, so a mutant
 * counts as killed only when a test of that contract notices it.
 * @type {Readonly<Record<string, { readonly mutate: readonly string[]; readonly tests: readonly string[] }>>}
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
		tests: ['src/ledger/storage/**/*.test.ts']
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
