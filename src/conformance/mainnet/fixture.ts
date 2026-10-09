import { readFile } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { LedgerConfig, LedgerStorageAPI } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { assertNever } from '../../util/assert-never.js';

const lib = KeetaNet.lib;

/**
 * The captured staples: the first 2,037 of the chain, 90 that an independent
 * decoder first refused, and 3 airdrops voted before a send required its
 * recipient's access.
 */
export type MainnetFixtureName = 'head' | 'edge-cases' | 'recipient-access';

export const MAINNET_NETWORK = 0x5382n;

export const MAINNET_TRUSTED_ROOT = 'keeta_aabk62tezl4whordlviamlx3zrdgux6lk63cghay45vkzdatyemzvqqjuj5resa';

/**
 * The representative key of every replay. It is not a key of the network: the
 * replay only adds confirmed staples and, when asked, votes on its own.
 */
const REPLAY_REPRESENTATIVE_SEED = '3d6a0e91f4b7c285a1e30d9f6b4c7a28e5f1d0b39c8a7e6d5f4c3b2a190817fe';

const FIXTURE_FILES = {
	'head': 'head.jsonl.gz',
	'edge-cases': 'edge-cases.jsonl.gz',
	'recipient-access': 'recipient-access.jsonl.gz'
} as const satisfies Record<MainnetFixtureName, string>;

const FIXTURE_DIRECTORY = new URL('../../../conformance/mainnet/', import.meta.url);

function fixtureFile(name: MainnetFixtureName): URL {
	switch (name) {
		case 'head':
		case 'edge-cases':
		case 'recipient-access':
			return(new URL(FIXTURE_FILES[name], FIXTURE_DIRECTORY));
		default:
			return(assertNever(name));
	}
}

async function parseFixture(name: MainnetFixtureName): Promise<readonly VoteStaple[]> {
	const text = (await promisify(gunzip)(await readFile(fixtureFile(name)))).toString('ascii');
	return(text.split('\n').filter(function(line): boolean {
		return(line !== '');
	}).map(function(line): VoteStaple {
		return(new lib.Vote.Staple(Buffer.from(line, 'base64')));
	}));
}

// Parsing the head takes seconds, and a staple is never changed once parsed.
const parsedFixtures = new Map<MainnetFixtureName, Promise<readonly VoteStaple[]>>();

/** Each line is the base64 of one staple's zlib-compressed DER, as the bootstrap endpoint serves it. */
export function loadMainnetFixture(name: MainnetFixtureName): Promise<readonly VoteStaple[]> {
	const parsed = parsedFixtures.get(name) ?? parseFixture(name);
	parsedFixtures.set(name, parsed);
	return(parsed);
}

export function mainnetTrustedRoot(): Account {
	return(lib.Account.fromPublicKeyString(MAINNET_TRUSTED_ROOT));
}

export function mainnetReplayRepresentative(): Account {
	return(lib.Account.fromSeed(REPLAY_REPRESENTATIVE_SEED, 0));
}

/** The settings both a bare ledger and a node's ledger share. Mainnet fees are not charged when a confirmed staple is added. */
export function mainnetLedgerSettings(storageDriver: LedgerStorageAPI): Omit<LedgerConfig, 'kind' | 'network' | 'initialTrustedAccount' | 'privateKey'> {
	return({
		computeFeeFromBlocks: function() {
			return(null);
		},
		storageDriver
	});
}

/** A representative ledger carries the replay key, an account ledger none. */
export function mainnetLedgerConfig(storageDriver: LedgerStorageAPI, kind: LedgerConfig['kind']): LedgerConfig {
	const config: LedgerConfig = {
		...mainnetLedgerSettings(storageDriver),
		kind,
		network: MAINNET_NETWORK,
		initialTrustedAccount: mainnetTrustedRoot()
	};
	switch (kind) {
		case lib.Ledger.Kind.REPRESENTATIVE:
			return({ ...config, privateKey: mainnetReplayRepresentative() });
		case lib.Ledger.Kind.ACCOUNT:
			return(config);
		default:
			return(assertNever(kind));
	}
}

/** A representative of the mainnet holding the replay key, its ledger on the storage. */
export function mainnetNodeConfig(storage: LedgerStorageAPI): NodeConfig {
	return({
		kind: lib.Node.Kind.REPRESENTATIVE,
		// A log without targets discards everything.
		log: new lib.Log(),
		initialTrustedAccount: mainnetTrustedRoot(),
		ledgerPrivateKey: mainnetReplayRepresentative(),
		network: MAINNET_NETWORK,
		networkAlias: 'main',
		ledger: mainnetLedgerSettings(storage),
		stats: { kv: null }
	});
}
