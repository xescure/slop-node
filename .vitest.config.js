import { defineConfig } from 'vitest/config';

const DEVNET_TESTS = 'src/devnet/**/*.test.ts';

const DEVNET_FAULT_TESTS = 'src/devnet/faults.test.ts';

export default defineConfig({
	test: {
		/*
		 * Under make -j8 the corpus replay of the fees group took 4.0 to 4.6 s on
		 * Postgres and generating the permissions group 2.6 s, against the default
		 * of 5 s, and each process the CLI tests start spends about a second
		 * loading the client. This leaves room for a machine several times slower.
		 */
		testTimeout: 30_000,
		/*
		 * The workspace shares a hard 12 GiB memory cap, and a worker holds 1 to
		 * 2.4 GiB; the default of one worker per core got workers OOM-killed and
		 * then the whole session. Three keeps the suite well under the cap
		 * beside lint and the build.
		 */
		maxWorkers: 3,
		globalSetup: ['src/testing/postgres-global-setup.ts'],
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['src/**/*.test.ts', 'utils/**/*.test.ts'],
					exclude: ['utils/lint-fixtures/**', DEVNET_TESTS]
				}
			},
			/*
			 * Each devnet file starts four Postgres clusters and four node
			 * processes. Three at once, beside the other files, made the nodes'
			 * connections to Postgres wait past their 5 s timeout, so the devnet
			 * files run one at a time, and after the others, which keeps their
			 * load and the rest of the suite's apart.
			 */
			{
				extends: true,
				test: {
					name: 'devnet',
					include: [DEVNET_TESTS],
					exclude: [DEVNET_FAULT_TESTS],
					maxWorkers: 1,
					sequence: { groupOrder: 1 }
				}
			},
			/*
			 * The faults take about two and a half minutes, mostly waiting out
			 * the client's retries of a representative that is down and the
			 * minute a node cut off takes to catch up once healed, so only
			 * "make devnet-test" runs them, after the other devnet files.
			 */
			{
				extends: true,
				test: {
					name: 'devnet-faults',
					include: [DEVNET_FAULT_TESTS],
					maxWorkers: 1,
					sequence: { groupOrder: 2 }
				}
			}
		]
	}
});
