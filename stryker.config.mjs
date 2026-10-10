// @ts-check
import { globSync, statSync } from 'node:fs';
import { selectedModule } from './mutation/modules.js';

const module = selectedModule();

const incrementalFile = `.stryker/${module.name}/incremental.json`;

/*
 * Everything outside the mutated files and the test files that can change a
 * run's outcome: Stryker's incremental mode notices a change to a mutated file
 * or to a test file it ran, and nothing else.
 */
const UNTRACKED_INPUTS = [
	// The modules the tests import, such as the storage suite's cases.
	'src/**/*.ts',
	// The Postgres driver's runs migrate their databases from these.
	'schema/migrations/*.sql',
	// The installed upstream and how it is patched.
	'package-lock.json',
	'patches/**',
	// How the runs are configured.
	'stryker.config.mjs',
	'mutation/*.js',
	'.vitest.config.js'
];

/**
 * Whether an input Stryker does not track is newer than the last run, after
 * which every mutant runs again.
 * @returns {boolean}
 */
function inputsChangedSinceLastRun() {
	let lastRun;
	try {
		lastRun = statSync(incrementalFile).mtimeMs;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return(false);
		}
		throw(error);
	}
	const tracked = new Set(globSync([...module.mutate]));
	return(globSync(UNTRACKED_INPUTS).some(function(path) {
		return(!path.endsWith('.test.ts') && !tracked.has(path) && statSync(path).mtimeMs > lastRun);
	}));
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'mutation/vitest.config.js',
		// The configuration names the module's test files outright.
		related: false
	},
	coverageAnalysis: 'perTest',
	mutate: [...module.mutate],
	plugins: ['@stryker-mutator/*', './mutation/ignorers.js'],
	ignorers: [...module.ignorers],
	/*
	 * Two runners, each a single vitest worker with its own Postgres cluster,
	 * stay within a 12 GiB memory cap beside a running node.
	 */
	concurrency: 2,
	/*
	 * The incremental file is a cache of the last run, kept out of the tree
	 * with the reports: every run rewrites it, and it holds nothing a run
	 * cannot recompute from the sources and tests.
	 */
	incremental: true,
	incrementalFile,
	force: inputsChangedSinceLastRun(),
	tempDirName: '.stryker/tmp',
	cleanTempDir: 'always',
	reporters: ['progress', 'clear-text', 'json', 'html'],
	jsonReporter: { fileName: `.stryker/${module.name}/report.json` },
	htmlReporter: { fileName: `.stryker/${module.name}/report.html` },
	// The tests need none of these, and some are large.
	ignorePatterns: ['/.stryker', '/dist', '/build', '/reference', '/result', '/.devenv', '/.direnv', '/.private', '/.superpowers', '/.claude', '/.coverage'],
	thresholds: { high: 90, low: 90, break: null }
};
