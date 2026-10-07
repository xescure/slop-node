import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { KEETANET_CLIENT_VERSION, NODE_VERSION } from './version.js';

const PACKAGE_FILE = new URL('../package.json', import.meta.url);

function pinnedClientVersion(): unknown {
	const parsed: unknown = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'));
	if (typeof parsed !== 'object' || parsed === null || !('dependencies' in parsed)) {
		throw(new Error('package.json has no dependencies'));
	}
	const { dependencies } = parsed;
	if (typeof dependencies !== 'object' || dependencies === null) {
		throw(new Error('package.json has no dependencies'));
	}
	return(Reflect.get(dependencies, '@keetanetwork/keetanet-client'));
}

test('the node speaks the KeetaNet release the package pins', function() {
	expect(KEETANET_CLIENT_VERSION).toBe(pinnedClientVersion());
});

test('the version is that release, built as this node', function() {
	expect(NODE_VERSION).toBe(`${KEETANET_CLIENT_VERSION}+slop-node`);
});
