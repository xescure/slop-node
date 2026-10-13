import { describe, expect, test } from 'vitest';
import { fillIntegrity, formatLock, parseLock, specOf, uncheckedEntries } from './lock.js';
import type { PackageLock, PinnedPackage } from './lock.js';

/** A well-formed integrity, distinct per digit. */
function integrity(digit: number): string {
	return(`sha512-${String(digit).repeat(86)}==`);
}

const CLIENT = 'node_modules/@keetanetwork/keetanet-client';

/**
 * A lock as npm writes it after an install: the project, a link, entries the
 * lock checks, and the entries a dependency's own shrinkwrap pins, which carry
 * no resolved URL and here no integrity either, one of them twice.
 */
const LOCK_TEXT = `${JSON.stringify({
	name: 'slop-node',
	lockfileVersion: 3,
	requires: true,
	packages: {
		'': { name: 'slop-node', dependencies: { '@keetanetwork/keetanet-client': '0.18.8' } },
		'node_modules/linked': { resolved: 'packages/linked', link: true },
		[CLIENT]: { version: '0.18.8', resolved: 'https://registry.npmjs.org/@keetanetwork/keetanet-client/-/keetanet-client-0.18.8.tgz', integrity: integrity(1), hasShrinkwrap: true },
		[`${CLIENT}/node_modules/secp256k1`]: { version: '5.0.1', hasInstallScript: true, license: 'MIT' },
		[`${CLIENT}/node_modules/@grpc/grpc-js`]: { version: '1.14.3', license: 'Apache-2.0', optional: true },
		[`${CLIENT}/node_modules/@grpc/grpc-js/node_modules/@grpc/proto-loader`]: { version: '0.8.0', license: 'Apache-2.0' },
		[`${CLIENT}/node_modules/@grpc/proto-loader`]: { version: '0.8.0', license: 'Apache-2.0' },
		[`${CLIENT}/node_modules/string-width-cjs`]: { name: 'string-width', version: '4.2.3', license: 'MIT' },
		[`${CLIENT}/node_modules/elliptic`]: { version: '6.6.1', integrity: integrity(2), license: 'MIT' }
	}
}, null, '\t')}\n`;

function lock(): PackageLock {
	return(parseLock(LOCK_TEXT));
}

const REGISTRY: ReadonlyMap<string, string> = new Map([
	['secp256k1@5.0.1', integrity(3)],
	['@grpc/grpc-js@1.14.3', integrity(4)],
	['@grpc/proto-loader@0.8.0', integrity(5)],
	['string-width@4.2.3', integrity(6)]
]);

type Registry = {
	readonly lookup: (pinned: PinnedPackage) => Promise<string>;
	readonly asked: string[];
	readonly mostInFlight: () => number;
};

function registry(answers: ReadonlyMap<string, string> = REGISTRY): Registry {
	const asked: string[] = [];
	let inFlight = 0;
	let most = 0;
	return({
		lookup: async function(pinned: PinnedPackage): Promise<string> {
			asked.push(specOf(pinned));
			inFlight += 1;
			most = Math.max(most, inFlight);
			await Promise.resolve();
			inFlight -= 1;
			return(answers.get(specOf(pinned)) ?? '');
		},
		asked,
		mostInFlight: function(): number {
			return(most);
		}
	});
}

describe('the entries of a lock without integrity', function() {
	test('are every entry the Nix package fetches, named as the registry knows them', function() {
		expect(uncheckedEntries(lock()).map(specOf)).toEqual([
			'secp256k1@5.0.1',
			'@grpc/grpc-js@1.14.3',
			'@grpc/proto-loader@0.8.0',
			'@grpc/proto-loader@0.8.0',
			'string-width@4.2.3'
		]);
	});

	test('leave out the project and a link, which are never fetched', function() {
		expect(uncheckedEntries(lock()).map(function(entry): string {
			return(entry.path);
		})).not.toContain('');
		expect(uncheckedEntries(lock()).map(function(entry): string {
			return(entry.path);
		})).not.toContain('node_modules/linked');
	});

	test('are none once filled', async function() {
		expect(uncheckedEntries(await fillIntegrity(lock(), registry().lookup, 2))).toEqual([]);
	});

	test('are refused without a version, which the registry needs', function() {
		const text = LOCK_TEXT.replace('"version": "5.0.1",', '');
		expect(function() {
			return(uncheckedEntries(parseLock(text)));
		}).toThrow(`the lock's entry ${CLIENT}/node_modules/secp256k1 has no version`);
	});
});

describe('filling a lock', function() {
	test('writes the registry\'s integrity right after the version, as npm does, and changes nothing else', async function() {
		const filled = formatLock(await fillIntegrity(lock(), registry().lookup, 2));
		const expected = LOCK_TEXT
			.replace('"version": "5.0.1",', `"version": "5.0.1",\n\t\t\t"integrity": "${integrity(3)}",`)
			.replace('"version": "1.14.3",', `"version": "1.14.3",\n\t\t\t"integrity": "${integrity(4)}",`)
			.replaceAll('"version": "0.8.0",', `"version": "0.8.0",\n\t\t\t"integrity": "${integrity(5)}",`)
			.replace('"version": "4.2.3",', `"version": "4.2.3",\n\t\t\t"integrity": "${integrity(6)}",`);
		expect(filled).toBe(expected);
	});

	test('asks the registry once for each package, however many entries pin it, with at most the concurrency given in flight', async function() {
		const asked = registry();
		await fillIntegrity(lock(), asked.lookup, 2);
		expect([...asked.asked].sort()).toEqual(['@grpc/grpc-js@1.14.3', '@grpc/proto-loader@0.8.0', 'secp256k1@5.0.1', 'string-width@4.2.3']);
		expect(asked.mostInFlight()).toBe(2);
	});

	test('leaves a lock with nothing to fill as it was', async function() {
		const filled = formatLock(await fillIntegrity(lock(), registry().lookup, 2));
		const asked = registry();
		expect(formatLock(await fillIntegrity(parseLock(filled), asked.lookup, 2))).toBe(filled);
		expect(asked.asked).toEqual([]);
	});

	test.each([
		{ name: 'nothing', answer: '' },
		{ name: 'a sha1 integrity', answer: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=' },
		{ name: 'a sha512 integrity of the wrong length', answer: 'sha512-AAAA==' }
	])('fails when the registry gives $name for a package', async function({ answer }) {
		const answers = new Map(REGISTRY);
		answers.set('secp256k1@5.0.1', answer);
		await expect(fillIntegrity(lock(), registry(answers).lookup, 2)).rejects.toThrow(`the registry gives no sha512 integrity for secp256k1@5.0.1: ${JSON.stringify(answer)}`);
	});

	test('refuses a lock without packages', function() {
		expect(function() {
			return(parseLock('{"lockfileVersion": 3}'));
		}).toThrow('the lock has no packages');
	});
});
