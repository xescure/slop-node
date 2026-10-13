import { afterEach } from 'vitest';

/*
 * A test that times out fails, but its body runs on: the runner cannot stop
 * it. A simulation it began goes on moving the clock every test shares
 * (freezeClock, advanceClock), under the tests that run after it.
 */

let running = new AbortController();

/** Aborted once the test running when it was read has ended, however it ended. */
export function testLifetime(): AbortSignal {
	return(running.signal);
}

function endTest(): void {
	running.abort(new Error('the test that made this has ended'));
	running = new AbortController();
}

/*
 * Registered on the file of whichever test imports this, as it collects, so
 * that the lifetime ends however the file is run: "npx vitest run <file>"
 * reads no .vitest.config.js, and so no setup file it names.
 */
afterEach(endTest);
