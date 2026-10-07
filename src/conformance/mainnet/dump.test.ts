import { afterEach, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerStorageDriverBase } from '../../ledger/storage/base.js';
import { driversUnderTest } from '../../ledger/storage/suite/drivers.js';
import { ChainCursor, GENESIS_MOMENT, certificateFor, requireAt } from '../../ledger/storage/suite/support.js';
import {
	confirmedStaple,
	createMultisigBlock,
	createTokenBlock,
	manageCertificateBlock,
	modifyPermissionsBlock,
	sendBlock,
	setInfoBlock,
	tokenSupplyBlock
} from '../../testing/blocks.js';
import { createTestNetwork, freezeClock } from '../../testing/network.js';
import type { TestNetwork } from '../../testing/network.js';
import { stateDumpViolations } from '../schema.js';
import { STATE_DUMP_FORMAT, renderStateDump } from './dump.js';
import { compareText } from './replay.js';

const lib = KeetaNet.lib;

const WEIGHTS: readonly bigint[] = [400n, 300n, 300n];

// User 1 sends all of its balance away, which moves its weight to representative 2.
const FINAL_WEIGHTS: readonly bigint[] = [400n, 0n, 600n];

const IDEMPOTENT_KEY = 'c3dlZXA=';

type Built = {
	readonly network: TestNetwork;
	readonly ledger: Ledger;
	readonly staples: readonly VoteStaple[];
};

function key(account: GenericAccount): string {
	return(account.publicKeyString.get());
}

function linesOf(dump: string): string[] {
	expect(dump.endsWith('\n')).toBe(true);
	return(dump.slice(0, -1).split('\n'));
}

function recordsOf(dump: string): string[] {
	const [header, ...records] = linesOf(dump);
	expect(header).toBe(JSON.stringify({ format: STATE_DUMP_FORMAT }));
	return(records);
}

function recordsOfKind(dump: string, kind: string): unknown[] {
	return(recordsOf(dump).map(function(line): unknown {
		return(JSON.parse(line));
	}).filter(function(record): boolean {
		return(Reflect.get(Object(record), 'kind') === kind);
	}));
}

describe.each(driversUnderTest)('the canonical state dump on the $name driver', function(driver) {
	const created: LedgerStorageDriverBase[] = [];

	afterEach(async function() {
		vi.useRealTimers();
		for (const storage of created.splice(0)) {
			await driver.destroy(storage);
		}
	});

	async function build(): Promise<Built & { readonly holder: Account; readonly entity: Account; readonly owner: Account; readonly certificate: Awaited<ReturnType<typeof certificateFor>>; readonly token: GenericAccount; readonly multisig: GenericAccount; readonly cursor: ChainCursor; readonly sweep: Block }> {
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: WEIGHTS });
		const storage = await driver.create();
		created.push(storage);
		const ledger = network.createLedger(storage, requireAt(network.representatives, 0));
		const holder = requireAt(network.users, 0);
		const entity = requireAt(network.users, 1);
		const owner = requireAt(network.users, 2);
		const cursor = new ChainCursor(network.genesis);
		const staples: VoteStaple[] = [network.genesis];
		async function confirm(block: Block): Promise<void> {
			const staple = await confirmedStaple([cursor.append(block)], network.representatives);
			await ledger.add(staple);
			staples.push(staple);
		}

		await ledger.add(network.genesis);
		const certificate = await certificateFor(holder, 1);
		await confirm(await manageCertificateBlock({ account: holder, previous: cursor.previous(holder), network: network.network, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate }));
		await confirm(await modifyPermissionsBlock({
			account: entity,
			previous: cursor.previous(entity),
			network: network.network,
			principal: { usingCertificate: true, certificateHash: certificate.hash(), certificateAccount: holder },
			method: lib.Block.AdjustMethod.ADD,
			permissions: new lib.Permissions(['ACCESS'])
		}));
		await confirm(await setInfoBlock({ account: holder, previous: cursor.previous(holder), network: network.network, name: 'HOLDER', description: 'says "it\u2018s" \\ here', metadata: '' }));
		const { block: tokenBlock, token } = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
		await confirm(tokenBlock);
		await confirm(await tokenSupplyBlock({ owner, token, amount: 25n, previous: cursor.previous(token), network: network.network }));
		const { block: multisigBlock, multisig } = await createMultisigBlock({ owner, signers: [holder, entity], quorum: 2n, previous: cursor.previous(owner), network: network.network });
		await confirm(multisigBlock);

		await confirm(await modifyPermissionsBlock({ account: holder, previous: cursor.previous(holder), network: network.network, principal: owner, method: lib.Block.AdjustMethod.SET, permissions: new lib.Permissions([]) }));
		const sweep = await sendBlock({ from: entity, to: owner, amount: requireAt(WEIGHTS, 1), token: network.baseToken, previous: cursor.previous(entity), network: network.network, idempotent: IDEMPOTENT_KEY });
		await confirm(sweep);

		return({ network, ledger, staples, cursor, holder, entity, owner, certificate, token, multisig, sweep });
	}

	test('starts with the format line, and its records are sorted, distinct and valid under the published schema', async function() {
		const { ledger, staples } = await build();

		const dump = await renderStateDump(ledger, staples, 0n);
		const records = recordsOf(dump);

		expect(records.length).toBeGreaterThan(0);
		expect(records).toEqual([...new Set(records)].sort());
		for (const line of linesOf(dump)) {
			expect(stateDumpViolations(JSON.parse(line))).toEqual([]);
		}
	});

	test('records a certificate with its bytes, and an ACL granted to its holders', async function() {
		const { ledger, staples, holder, entity, certificate } = await build();
		const hash = certificate.hash().toString();

		const dump = await renderStateDump(ledger, staples, 0n);

		expect(recordsOfKind(dump, 'certificate')).toEqual([{
			kind: 'certificate',
			account: key(holder),
			hash,
			certificate: Buffer.from(certificate.toDER()).toString('base64'),
			intermediates: null
		}]);
		expect(recordsOfKind(dump, 'acl')).toContainEqual({
			kind: 'acl',
			principalType: 'CERTIFICATE',
			principal: key(holder),
			certificate: hash,
			entity: key(entity),
			target: key(entity),
			base: new lib.Permissions(['ACCESS']).base.bigint.toString(),
			external: '0'
		});
	});

	test('records identifier settings by account type, the supply of a token, and every representative weight', async function() {
		const { network, ledger, staples, cursor, holder, entity, owner, token, multisig } = await build();

		const dump = await renderStateDump(ledger, staples, 0n);
		const accountRecords = recordsOfKind(dump, 'account');

		expect(accountRecords).toContainEqual({ kind: 'account', account: key(multisig), name: '', description: '', metadata: '', representative: null, defaultPermission: { base: '0', external: '0' }, multisigQuorum: '2' });
		expect(accountRecords).toContainEqual({ kind: 'account', account: key(token), name: '', description: '', metadata: '', representative: null, defaultPermission: { base: '0', external: '0' } });
		expect(accountRecords).toContainEqual({ kind: 'account', account: key(holder), name: 'HOLDER', description: 'says "it\u2018s" \\ here', metadata: '', representative: key(requireAt(network.representatives, 0)) });
		expect(recordsOfKind(dump, 'supply')).toContainEqual({ kind: 'supply', token: key(token), amount: '25' });
		expect(recordsOfKind(dump, 'balance')).toContainEqual({ kind: 'balance', account: key(token), token: key(token), amount: '25' });
		expect(recordsOfKind(dump, 'weight')).toEqual(network.representatives.map(function(representative, index) {
			return({ kind: 'weight', representative: key(representative), weight: requireAt(FINAL_WEIGHTS, index).toString() });
		}).sort(function(left, right): number {
			return(compareText(left.representative, right.representative));
		}));
		expect(recordsOfKind(dump, 'head').filter(function(record): boolean {
			return([holder, entity, owner, token].map(key).includes(String(Reflect.get(Object(record), 'account'))));
		}).map(function(record): unknown {
			return(Reflect.get(Object(record), 'block'));
		}).sort()).toEqual([holder, entity, owner, token].map(function(account): string {
			return(String(cursor.previous(account)));
		}).sort());
	});

	test('writes text outside printable ASCII as escapes, so every line is ASCII', async function() {
		const { ledger, staples } = await build();

		const dump = await renderStateDump(ledger, staples, 0n);

		expect(dump).toMatch(/^[\x20-\x7e\n]*$/u);
		expect(dump).toContain(String.raw`"description":"says \"it\u2018s\" \\ here"`);
	});

	test('records the ledger checksum as 64 uppercase hex digits', async function() {
		const { ledger, staples } = await build();

		const dump = await renderStateDump(ledger, staples, 0xabcdefn);

		expect(recordsOfKind(dump, 'checksum')).toEqual([{ kind: 'checksum', ledgerChecksum: `${'0'.repeat(58)}ABCDEF` }]);
		await expect(renderStateDump(ledger, staples, 1n << 256n)).rejects.toThrow();
		await expect(renderStateDump(ledger, staples, -1n)).rejects.toThrow();
	});

	test('does not depend on the order of the staples or on repeats', async function() {
		const { ledger, staples } = await build();

		const forward = await renderStateDump(ledger, staples, 7n);
		const reversed = await renderStateDump(ledger, [...staples].reverse(), 7n);
		const repeated = await renderStateDump(ledger, [...staples, ...staples], 7n);

		expect(reversed).toBe(forward);
		expect(repeated).toBe(forward);
	});
	test('records the block that holds each idempotent key of the applied blocks', async function() {
		const { ledger, staples, entity, sweep } = await build();

		const dump = await renderStateDump(ledger, staples, 0n);

		expect(recordsOfKind(dump, 'idempotent')).toEqual([{ kind: 'idempotent', account: key(entity), key: IDEMPOTENT_KEY, block: sweep.hash.toString() }]);
	});

	test('omits a balance of zero, and writes an ACL row without permissions', async function() {
		const { network, ledger, staples, holder, entity, owner } = await build();

		const dump = await renderStateDump(ledger, staples, 0n);

		expect(recordsOfKind(dump, 'balance').filter(function(record): boolean {
			return(Reflect.get(Object(record), 'account') === key(entity));
		})).toEqual([]);
		expect(recordsOfKind(dump, 'balance')).toContainEqual({ kind: 'balance', account: key(owner), token: key(network.baseToken), amount: (requireAt(WEIGHTS, 1) + requireAt(WEIGHTS, 2)).toString() });
		expect(recordsOfKind(dump, 'acl')).toContainEqual({ kind: 'acl', principalType: 'ACCOUNT', principal: key(owner), entity: key(holder), target: key(holder), base: '0', external: '0' });
	});
});
