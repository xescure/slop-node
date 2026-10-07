import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		/*
		 * Under make -j8 the corpus replay of the fees group took 4.0 to 4.6 s on
		 * Postgres and generating the permissions group 2.6 s, against the default
		 * of 5 s, and each process the CLI tests start spends about a second
		 * loading the client. This leaves room for a machine several times slower.
		 */
		testTimeout: 30_000,
		include: ['src/**/*.test.ts', 'utils/**/*.test.ts'],
		exclude: ['utils/lint-fixtures/**'],
		globalSetup: ['src/testing/postgres-global-setup.ts']
	}
});
