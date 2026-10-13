import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { replayOn } from '../conformance/mainnet/replay.js';
import type { ReplayResult } from '../conformance/mainnet/replay.js';
import { shadowVoter } from '../conformance/mainnet/shadow.js';
import type { ShadowVote } from '../conformance/mainnet/shadow.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { TRUSTED_ACCOUNT } from './genesis.js';

const lib = KeetaNet.lib;

const NETWORK = 0n;

/**
 * The key the replaying representative votes with. It is none of the
 * devnet's: the replay only adds the devnet's staples and votes on each of
 * them first, as a representative that had not yet seen it would.
 */
const SHADOW_REPRESENTATIVE_SEED = 'c84e2a6f1d93b70e5a2c8f4d1b6e93a07c5f2d8e4b1a69c3f0d7e25b8a4c16f9';

export type ShadowReplay = {
	readonly result: ReplayResult;
	/** One per staple, in replay order. */
	readonly votes: readonly ShadowVote[];
};

/**
 * Replays the staples into a fresh representative ledger of the devnet's
 * network, putting each staple's blocks to its vote before adding it, with
 * the clock at the staple's moment. The vote asked for is a temporary one,
 * which no fee is checked for [Keeta TS] index.js:70181-70186, so the
 * ledger charges none.
 */
export async function shadowReplay(staples: readonly VoteStaple[]): Promise<ShadowReplay> {
	const node = new lib.Node({
		kind: lib.Node.Kind.REPRESENTATIVE,
		// A log without targets discards everything.
		log: new lib.Log(),
		initialTrustedAccount: TRUSTED_ACCOUNT,
		ledgerPrivateKey: lib.Account.fromSeed(SHADOW_REPRESENTATIVE_SEED, 0),
		network: NETWORK,
		networkAlias: 'test',
		ledger: {
			computeFeeFromBlocks: function() {
				return(null);
			},
			storageDriver: new MemoryLedgerStorage()
		},
		stats: { kv: null }
	});
	const voter = shadowVoter();
	try {
		const result = await replayOn(node, staples, { beforeAdd: voter.beforeAdd });
		return({ result, votes: voter.votes });
	} finally {
		await node.stop();
	}
}
