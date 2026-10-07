import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { firstDifference } from '../conformance/mainnet/dump.js';
import { Devnet } from './harness.js';
import { nodeCommandOf } from './process.js';

/*
 * The command as built, which "make test" builds first, so that what runs is
 * what the package runs.
 */
const BUILT_CLI = new URL('../../dist/main.js', import.meta.url);

/** A bound on a test or hook, with why it is as long as it is. */
export type Timeout = { readonly milliseconds: number; readonly reason: string };

/*
 * Four Postgres clusters, genesis, each node started twice and the four
 * staples that spread the weight took about 3 s alone and up to 15 s beside
 * every other test file; this leaves room for a slower machine.
 */
const START: Timeout = { milliseconds: 180_000, reason: 'starting four clusters and nodes twice, then delegating' };

/** Each node has 20 s to exit, and they stop together, then the clusters. */
const STOP: Timeout = { milliseconds: 60_000, reason: 'stopping the nodes, then their clusters' };

function withLogs(error: unknown, logs: string): unknown {
	if (error instanceof Error) {
		error.message = `${error.message}\n\nThe devnet's logs end:\n${logs}`;
	}
	return(error);
}

export type DevnetTests = {
	/** A test against the devnet of this file, whose failure carries the end of every node's log. */
	readonly test: (name: string, timeout: Timeout, body: (devnet: Devnet) => Promise<void>) => void;
};

/**
 * One devnet for the test file, started before its tests and stopped after
 * them, whether they pass or not. Its logs are kept, and their directory
 * named, when a test failed.
 */
export function useDevnet(): DevnetTests {
	let started: Devnet | undefined;
	let directory: string | undefined;
	let failed = false;

	beforeAll(async function() {
		directory = await mkdtemp(join(tmpdir(), 'slop-devnet-'));
		started = await Devnet.start({ directory, clusterParent: tmpdir(), command: nodeCommandOf(process.env, BUILT_CLI) });
	}, START.milliseconds);

	afterAll(async function() {
		await started?.stop();
		if (directory === undefined) {
			return;
		}
		if (failed) {
			process.stderr.write(`the devnet's logs are kept in ${directory}\n`);
			return;
		}
		await rm(directory, { recursive: true, force: true });
	}, STOP.milliseconds);

	return({
		test: function(name, timeout, body) {
			test(name, async function() {
				const devnet = started;
				if (devnet === undefined) {
					throw(new Error('the devnet did not start'));
				}
				try {
					await body(devnet);
				} catch (error: unknown) {
					failed = true;
					throw(withLogs(error, await devnet.logTails()));
				}
			}, timeout.milliseconds);
		}
	});
}

/** Every node's canonical state is the same as the first's, which a failure shows the first differing line of. */
export async function expectConvergedDumps(devnet: Devnet): Promise<void> {
	const [reference, ...others] = await devnet.dumps();
	if (reference === undefined) {
		throw(new Error('the devnet dumped no node'));
	}
	for (const other of others) {
		expect({ node: other.index, difference: firstDifference(reference.dump, other.dump) }).toEqual({ node: other.index, difference: null });
	}
}
