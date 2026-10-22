// @ts-check
import { globSync, readFileSync, statSync } from 'node:fs';
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
 * @typedef {object} LastRun What the incremental file keeps of the last run.
 * @property {Record<string, { mutants: { static?: boolean }[] }>} files
 * @property {Record<string, { source?: string }>} testFiles The tests' sources as the run read them, when it began.
 */

/**
 * Whether a test of the module differs from the source the last run read,
 * while that run had a static mutant, one in code that runs as its module
 * loads: Stryker ties its result to no test, so its incremental mode reuses
 * that result whichever tests changed. The sources are compared rather than
 * times, as a test edited during a run is older than the file the run writes
 * at its end.
 * @param {LastRun} lastRun
 * @returns {boolean}
 */
function staticResultsStale(lastRun) {
	const hadStatic = Object.values(lastRun.files).some(function(file) {
		return(file.mutants.some(function(mutant) {
			return(mutant.static === true);
		}));
	});
	return(hadStatic && globSync([...module.tests]).some(function(path) {
		return(lastRun.testFiles[path]?.source !== readFileSync(path, 'utf8'));
	}));
}

/**
 * Whether an input Stryker does not track is newer than the last run, or the
 * results of its static mutants are stale, after which every mutant runs
 * again.
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
	const untracked = globSync(UNTRACKED_INPUTS).some(function(path) {
		return(!path.endsWith('.test.ts') && !tracked.has(path) && statSync(path).mtimeMs > lastRun);
	});
	return(untracked || staticResultsStale(JSON.parse(readFileSync(incrementalFile, 'utf8'))));
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
	 * One runner, a single vitest worker with its own Postgres cluster: beside
	 * a running node's page cache, a second runner took the workspace past
	 * 10 GiB of its 12 GiB memory cap.
	 */
	concurrency: 1,
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
	ignorePatterns: ['/.stryker', '/dist', '/build', '/reference', '/result', '/.direnv', '/.private', '/.superpowers', '/.claude', '/.coverage'],
	thresholds: { high: 90, low: 90, break: null }
};
