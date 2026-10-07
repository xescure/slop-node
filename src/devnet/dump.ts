import * as KeetaNet from '@keetanetwork/keetanet-client';
import { renderStateDump } from '../conformance/mainnet/dump.js';
import { PostgresKVStorage } from '../kv/postgres.js';
import { LEDGER_CHECKSUM_KEY } from '../ledger/storage/base.js';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import type { PostgresPoolSource } from '../ledger/storage/postgres/pool.js';
import { TRUSTED_ACCOUNT } from './genesis.js';

const lib = KeetaNet.lib;

const NETWORK = 0n;

const EPOCH = new Date(0);

/** More staples than a devnet run makes, so that one read lists them all. */
const STAPLE_LIMIT = 100_000;

function sourceOf(connectionString: string): PostgresPoolSource {
	return({ kind: 'connection-string', connectionString });
}

/**
 * The ledger checksum a stopped node left in its database. A running node
 * may hold statistics it has not written there yet, so its own answer is
 * read from its API instead.
 */
export async function storedChecksum(connectionString: string): Promise<bigint> {
	const kv = new PostgresKVStorage(sourceOf(connectionString));
	try {
		const stats = new lib.Stats({ kv });
		return((await stats.getXor(LEDGER_CHECKSUM_KEY)).toBigInt());
	} finally {
		await kv.destroy();
	}
}

/**
 * A node's confirmed state in the canonical dump format, read from its
 * database by a ledger of its own that never writes, over every staple the
 * node holds.
 */
export async function renderNodeDump(connectionString: string, ledgerChecksum: bigint): Promise<string> {
	const storage = new PostgresLedgerStorage(sourceOf(connectionString));
	try {
		const ledger = new lib.Ledger({
			kind: lib.Ledger.Kind.ACCOUNT,
			initialTrustedAccount: TRUSTED_ACCOUNT,
			network: NETWORK,
			computeFeeFromBlocks: function() {
				return(null);
			},
			storageDriver: storage,
			ledgerWriteMode: 'read-only'
		});
		const staples = await ledger.getVoteStaplesAfter(EPOCH, STAPLE_LIMIT);
		if (staples.length >= STAPLE_LIMIT) {
			throw(new Error(`the node holds more staples than one read lists (${String(STAPLE_LIMIT)})`));
		}
		return(await renderStateDump(ledger, staples, ledgerChecksum));
	} finally {
		await storage.destroy();
	}
}
