import { defineConfig } from 'vitest/config';
import suite from '../.vitest.config.js';
import { selectedModule } from './modules.js';

/*
 * The runner runs one test file at a time to stay within the memory cap. The
 * module's tests are chosen here rather than with Stryker's testFiles, under
 * which Stryker 10.0.0 activates a mutant only after the modules have loaded,
 * so a mutant in code that runs as a module loads would never run.
 */
export default defineConfig({
	test: {
		testTimeout: suite.test.testTimeout,
		globalSetup: suite.test.globalSetup,
		maxWorkers: 1,
		include: [...selectedModule().tests]
	}
});
