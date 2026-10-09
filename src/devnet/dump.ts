import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { renderStateDump } from '../conformance/mainnet/dump.js';
import { PostgresLedgerStorage } from '../ledger/storage/postgres/driver.js';
import type { PostgresPoolSource } from '../ledger/storage/postgres/pool.js';
import { eachStapleOnce } from '../util/each-staple-once.js';
import { TRUSTED_ACCOUNT } from './genesis.js';

const lib = KeetaNet.lib;

const NETWORK = 0n;

const EPOCH = new Date(0);

/** More staples than a devnet run makes, so that one read lists them all. */
const STAPLE_LIMIT = 100_000;

function sourceOf(connectionString: string): PostgresPoolSource {
	return({ kind: 'connection-string', connectionString });
}

/** The ledger checksum a node's database holds, which is written with the staples it covers. */
export async function storedChecksum(connectionString: string): Promise<bigint> {
	const storage = new PostgresLedgerStorage(sourceOf(connectionString));
	try {
		return((await storage.ledgerChecksum()).checksum);
	} finally {
		await storage.destroy();
	}
}

/**
 * Runs with a ledger of its own over the node's database, which never
 * writes, and every staple the node holds, oldest first.
 */
async function withNodeLedger<Result>(connectionString: string, use: (ledger: Ledger, staples: VoteStaple[]) => Promise<Result>): Promise<Result> {
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
		const listed = await ledger.getVoteStaplesAfter(EPOCH, STAPLE_LIMIT);
		if (listed.length >= STAPLE_LIMIT) {
			throw(new Error(`the node holds more staples than one read lists (${String(STAPLE_LIMIT)})`));
		}
		return(await use(ledger, eachStapleOnce(listed)));
	} finally {
		await storage.destroy();
	}
}

/** A node's confirmed state in the canonical dump format, read from its database. */
export async function renderNodeDump(connectionString: string, ledgerChecksum: bigint): Promise<string> {
	return(await withNodeLedger(connectionString, function(ledger, staples): Promise<string> {
		return(renderStateDump(ledger, staples, ledgerChecksum));
	}));
}

/** Every staple a node holds, read from its database. */
export async function confirmedStaples(connectionString: string): Promise<VoteStaple[]> {
	return(await withNodeLedger(connectionString, function(_ledger, staples): Promise<VoteStaple[]> {
		return(Promise.resolve(staples));
	}));
}
