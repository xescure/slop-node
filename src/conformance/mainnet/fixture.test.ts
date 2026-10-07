import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { MemoryLedgerStorage } from '../../ledger/storage/memory/driver.js';
import { MAINNET_NETWORK, MAINNET_TRUSTED_ROOT, loadMainnetFixture, mainnetLedgerConfig } from './fixture.js';
import type { MainnetFixtureName } from './fixture.js';

const lib = KeetaNet.lib;

const FIXTURES = [
	{ name: 'head', file: 'head.jsonl.gz', staples: 2037, blocks: 4327 },
	{ name: 'edge-cases', file: 'edge-cases.jsonl.gz', staples: 90, blocks: 180 }
] as const satisfies readonly { name: MainnetFixtureName; file: string; staples: number; blocks: number }[];

/*
 * Parsing the head's 2,037 staples took about
 * 4 s on an idle machine, close to the default timeout of 5 s, and make -j8
 * runs the other tests beside it.
 */
const PARSE_TIMEOUT_MILLISECONDS = 60_000;

const DIRECTORY = new URL('../../../conformance/mainnet/', import.meta.url);

describe.each(FIXTURES)('the $name fixture', function({ name, file, staples, blocks }) {
	test('parses into the documented number of distinct staples and blocks', { timeout: PARSE_TIMEOUT_MILLISECONDS }, async function() {
		const loaded = await loadMainnetFixture(name);

		expect(loaded).toHaveLength(staples);
		expect(new Set(loaded.map(function(staple): string {
			return(staple.blocksHash.toString());
		})).size).toBe(staples);
		expect(loaded.reduce(function(total, staple): number {
			return(total + staple.blocks.length);
		}, 0)).toBe(blocks);
	});

	test('has the sha256 that conformance/MAINNET.md states', async function() {
		const digest = createHash('sha256').update(await readFile(new URL(file, DIRECTORY))).digest('hex');
		const document = await readFile(new URL('../MAINNET.md', DIRECTORY), 'utf8');

		expect(document).toContain(`| \`mainnet/${file}\` | ${staples.toLocaleString('en-US')} | ${blocks.toLocaleString('en-US')} |`);
		expect(document).toContain(`\`${digest}\``);
	});
});

describe('the mainnet ledger settings', function() {
	test('name mainnet, its trusted root and a representative key only when asked for one', function() {
		const storage = new MemoryLedgerStorage();

		const representative = mainnetLedgerConfig(storage, lib.Ledger.Kind.REPRESENTATIVE);
		const account = mainnetLedgerConfig(storage, lib.Ledger.Kind.ACCOUNT);

		expect(representative.network).toBe(MAINNET_NETWORK);
		expect(representative.initialTrustedAccount.publicKeyString.get()).toBe(MAINNET_TRUSTED_ROOT);
		expect(representative.privateKey?.hasPrivateKey).toBe(true);
		expect(account.privateKey).toBeUndefined();
	});
});
