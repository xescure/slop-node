import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PATCH_DIRECTORY } from './list.js';
import type { Canary } from './list.js';
import { CanariesRefused, runCanaries, runTests, SCRATCH_DIRECTORY } from './run.js';

const run = promisify(execFile);

/*
 * Each run starts vitest in a clone of a small repository of its own, whose
 * tests time out in half a second, twice per canary.
 */
const RUN_TIMEOUT = 180_000;

const FIX = `
export function sum(left: number, right: number): number {
	return(left + right);
}

export function settled(): Promise<void> {
	return(Promise.resolve());
}

export function connect(): void {
	// Connected.
}
`;

const FIX_TEST = `
import { beforeEach, describe, expect, test } from 'vitest';
import { connect, settled, sum } from './fix.js';

describe('the fix', function() {
	test('adds', function() {
		expect(sum(1, 2)).toBe(3);
	});

	test('settles', async function() {
		await settled();
	});

	test('throws a range error', function() {
		if (sum(1, 2) !== 3) {
			throw(new RangeError('out of range'));
		}
	});

	test('is red', function() {
		expect(sum(1, 2)).toBe(4);
	});
});

describe('a connected fix', function() {
	beforeEach(function() {
		connect();
	});

	test('connects', function() {
		expect(sum(2, 2)).toBe(4);
	});
});
`;

const CONFIG = `
export default {
	test: {
		testTimeout: 500,
		hookTimeout: 500,
		projects: [{ extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } }]
	}
};
`;

/** A patch of src/fix.ts that replaces one line of it, with a line of context on either side. */
function patchOf(before: string, after: string): string {
	const lines = FIX.split('\n');
	const at = lines.indexOf(before);
	if (at < 1) {
		throw(new Error(`src/fix.ts has no line ${before} after its first`));
	}
	return([
		'--- a/src/fix.ts',
		'+++ b/src/fix.ts',
		`@@ -${String(at)},3 +${String(at)},3 @@`,
		` ${lines[at - 1] ?? ''}`,
		`-${before}`,
		`+${after}`,
		` ${lines[at + 1] ?? ''}`,
		''
	].join('\n'));
}

const PATCHES: Readonly<Record<string, string>> = {
	'subtracts': patchOf('\treturn(left + right);', '\treturn(left - right);'),
	'never-settles': patchOf('\treturn(Promise.resolve());', '\treturn(new Promise(function() {}));'),
	'range-error': patchOf('\treturn(left + right);', '\treturn(left * right);'),
	'cannot-connect': patchOf('\t// Connected.', '\tthrow(new Error(\'connect ENOENT /tmp/postgres/socket\'));'),
	'red-before': patchOf('\treturn(left + right);', '\treturn(left - right);'),
	'drifted': patchOf('\treturn(left + right);', '\treturn(right + left);').replace('-\treturn(left + right);', '-\treturn(left + right + 0);')
};

function canary(name: string, test: string, block = 'the fix'): Canary {
	return({ name, fix: { kind: 'commit', commit: '0000000' }, reverts: name, catchers: [{ file: 'src/fix.test.ts', name: [block, test], titlesIn: ['src/fix.test.ts'] }] });
}

const CANARIES: readonly Canary[] = [
	canary('subtracts', 'adds'),
	canary('never-settles', 'settles'),
	canary('range-error', 'throws a range error'),
	canary('cannot-connect', 'connects', 'a connected fix'),
	canary('red-before', 'is red'),
	canary('drifted', 'adds')
];

let root = '';

async function write(path: string, text: string): Promise<void> {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), text);
}

async function git(...args: readonly string[]): Promise<void> {
	await run('git', ['-c', 'user.name=canary', '-c', 'user.email=canary@example.invalid', ...args], { cwd: root });
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return(true);
	} catch {
		return(false);
	}
}

beforeAll(async function() {
	root = await mkdtemp(join(tmpdir(), 'slop-node-canaries-'));
	await write('.gitignore', 'node_modules\nbuild/\n');
	await write('.vitest.config.js', CONFIG);
	await write('src/fix.ts', FIX);
	await write('src/fix.test.ts', FIX_TEST);
	await mkdir(join(root, 'utils/canaries'), { recursive: true });
	await copyFile('utils/canaries/reporter.ts', join(root, 'utils/canaries/reporter.ts'));
	for (const [name, patch] of Object.entries(PATCHES)) {
		await write(`${PATCH_DIRECTORY}/${name}.patch`, patch);
	}
	await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'));
	await git('init', '--quiet');
	await git('add', '.');
	await git('commit', '--quiet', '-m', 'A fix and its canaries');
});

afterAll(async function() {
	await rm(root, { recursive: true, force: true });
});

describe('the canary reporter', function() {
	test('tells a timeout, a failed hook, an expectation and an error apart, as vitest runs them', { timeout: RUN_TIMEOUT }, async function() {
		await write('src/kinds.test.ts', `
			import { beforeEach, describe, expect, test } from 'vitest';

			describe('kinds', function() {
				test('hangs', async function() {
					await new Promise(function() {});
				});

				test('expects', function() {
					expect(1).toBe(2);
				});

				test('checks', function() {
					throw(new Error('the configuration was accepted'));
				});

				test('ranges', function() {
					throw(new RangeError('out of range'));
				});

				test('passes', function() {});

				test.skip('is skipped', function() {});
			});

			describe('hooked', function() {
				beforeEach(function() {
					throw(new Error('connect ENOENT /tmp/postgres/socket'));
				});

				test('after a throwing hook', function() {});
			});

			describe('hung', function() {
				beforeEach(async function() {
					await new Promise(function() {});
				});

				test('after a hanging hook', function() {});
			});
		`);
		try {
			const report = await runTests(root, ['src/kinds.test.ts'], 'kinds');

			expect(report.tests.map(function(result) {
				return([result.name.join(' > '), result.status, result.failure?.kind]);
			})).toEqual([
				['kinds > hangs', 'failed', 'timeout'],
				['kinds > expects', 'failed', 'assertion'],
				['kinds > checks', 'failed', 'assertion'],
				['kinds > ranges', 'failed', 'unknown'],
				['kinds > passes', 'passed', undefined],
				['kinds > is skipped', 'skipped', undefined],
				['hooked > after a throwing hook', 'failed', 'hook'],
				['hung > after a hanging hook', 'failed', 'timeout']
			]);
		} finally {
			await rm(join(root, 'src/kinds.test.ts'));
			await rm(join(root, 'canary-kinds.json'), { force: true });
			await rm(join(root, 'canary-kinds.log'), { force: true });
		}
	});
});

describe('a run of the canaries', function() {
	test('catches only a revert a named test fails by assertion after passing before it, keeping the clone of each other', { timeout: RUN_TIMEOUT }, async function() {
		const lines: string[] = [];

		const caught = await runCanaries({ root, canaries: CANARIES, keep: false, write: function(line) {
			lines.push(line);
		} });

		expect(caught).toBe(false);
		const verdicts = lines.filter(function(line): boolean {
			return(!line.startsWith('  failed: '));
		});
		const clone = function(name: string): string {
			return(join(root, SCRATCH_DIRECTORY, name));
		};
		expect(verdicts.slice(1)).toEqual([
			'subtracts (reverts commit 0000000): caught',
			`never-settles (reverts commit 0000000): NOT CAUGHT, its clone kept at ${clone('never-settles')}`,
			'  the fix > settles failed by a timeout: Error: Test timed out in 500ms.',
			`range-error (reverts commit 0000000): NOT CAUGHT, its clone kept at ${clone('range-error')}`,
			'  the fix > throws a range error failed by no assertion: RangeError: out of range',
			`cannot-connect (reverts commit 0000000): NOT CAUGHT, its clone kept at ${clone('cannot-connect')}`,
			'  a connected fix > connects failed by a hook: Error: connect ENOENT /tmp/postgres/socket (in beforeEach)',
			`red-before (reverts commit 0000000): NOT CAUGHT, its clone kept at ${clone('red-before')}`,
			'  before the patch, the fix > is red failed: AssertionError: expected 3 to be 4 // Object.is equality',
			`drifted (reverts commit 0000000): NOT CAUGHT, its clone kept at ${clone('drifted')}`,
			expect.stringMatching(/^ {2}the patch utils\/canaries\/patches\/drifted\.patch no longer applies: error: patch failed: src\/fix\.ts:\d+/u),
			'1 of 6 canaries caught'
		]);
		expect(lines).toContain('  failed: src/fix.test.ts: the fix > adds (assertion: AssertionError: expected -1 to be 3 // Object.is equality)');
		expect(await exists(clone('subtracts'))).toBe(false);
		expect(await exists(clone('never-settles'))).toBe(true);
	});

	test('refuses to run while the working tree differs from HEAD, whose patches a clone applies', async function() {
		await write(`${PATCH_DIRECTORY}/subtracts.patch`, `${PATCHES['subtracts'] ?? ''}\n`);
		try {
			await expect(runCanaries({ root, canaries: CANARIES, keep: false, write: function() {
				// Nothing runs.
			} })).rejects.toThrow(CanariesRefused);
		} finally {
			await git('checkout', '--', '.');
		}
	});
});
