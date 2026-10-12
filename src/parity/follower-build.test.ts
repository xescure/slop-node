import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { followerBuildOf } from './follower-build.js';

const directories: string[] = [];

afterEach(async function() {
	await Promise.all(directories.splice(0).map(function(directory) {
		return(rm(directory, { recursive: true, force: true }));
	}));
});

/** A follower's directory whose node runs the script, as the process table given lists it. */
async function running(namesScript: boolean): Promise<{ readonly directory: string; readonly processes: string; readonly main: string }> {
	const root = await mkdtemp(join(tmpdir(), 'slop-follower-build-'));
	directories.push(root);
	const directory = join(root, 'follower');
	const processes = join(root, 'proc');
	const main = join(root, 'dist', 'main.js');
	await mkdir(directory);
	await mkdir(join(root, 'dist'));
	await mkdir(join(processes, '4242'), { recursive: true });
	await writeFile(main, '');
	await utimes(main, new Date('2026-10-12T14:00:00.000Z'), new Date('2026-10-12T14:00:00.000Z'));
	await writeFile(join(directory, 'node.pid'), '4242\n');
	const commandLine = ['/nix/store/node/bin/node', '--max-old-space-size=1024'];
	if (namesScript) {
		commandLine.push(main);
	}
	await writeFile(join(processes, '4242', 'cmdline'), [...commandLine, 'run', ''].join('\0'));
	return({ directory, processes, main });
}

describe('the follower\'s build', function() {
	test('is the script its node runs and when that was written', async function() {
		const { directory, processes, main } = await running(true);

		expect(await followerBuildOf(directory, processes)).toBe(`${main}@2026-10-12T14:00:00.000Z`);
	});

	test('is unknown when no node runs or its command line names no script', async function() {
		const { directory, processes } = await running(false);
		expect(await followerBuildOf(directory, processes)).toBeNull();
		await rm(join(directory, 'node.pid'));
		expect(await followerBuildOf(directory, processes)).toBeNull();
	});
});
