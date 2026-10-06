import type { Account, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { ACLRow, CertificateWithIntermediates } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { Permissions } from '@keetanetwork/keetanet-client/lib/permissions.js';
import type { Vote, VoteBlockHash, VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { LedgerInternals } from '../../../upstream/internals.js';
import type {
	ACLScopeKey,
	AccountKey,
	BlockHashKey,
	CertificateHashKey,
	IdempotentKeyString,
	PrincipalKey,
	StapleKey,
	VoteKey
} from '../keys.js';

/** A block on the main ledger, with its place in its account's chain. */
export type ConfirmedBlockRow = {
	readonly block: Block;
	readonly height: bigint;
	readonly staple: StapleKey;
};

/** A confirmed staple: its blocks in order, its votes, and when this node confirmed it. */
export type StapleRow = {
	readonly blocksHash: VoteBlockHash;
	readonly blocks: readonly BlockHashKey[];
	readonly votes: ReadonlyMap<VoteKey, Vote>;
	readonly moment: Date;
	/** Node-local confirmation order; breaks ties between equal moments. */
	readonly sequence: bigint;
};

export type BalanceRow = {
	readonly token: TokenAddress;
	readonly balance: bigint;
};

type UpstreamAccountInfoRow = NonNullable<Parameters<InstanceType<typeof LedgerInternals.LedgerStorageBase>['_formatAccountInfoFromRow']>[1]>;

/** Stored account info, in the row shape upstream's formatter reads. */
export type AccountInfoRow = {
	readonly name?: string;
	readonly description?: string;
	readonly metadata?: string;
	readonly supply?: bigint;
	readonly multisigQuorum?: bigint;
	readonly defaultBasePermission?: Permissions['base'];
	readonly defaultExternalPermission?: Permissions['external'];
};

type AssertExtends<Narrow extends Wide, Wide> = Narrow;
// Fails to compile if a stored row stops being something the formatter accepts.
type _AccountInfoRowFitsFormatter = AssertExtends<AccountInfoRow, UpstreamAccountInfoRow>;

/** An account this node has seen in a confirmed staple. */
export type AccountRow = {
	readonly firstStaple: StapleKey;
};

/**
 * One of this node's own pending votes with the blocks it covers, in vote
 * order. The row keeps the blocks itself, so the vote can still be read as a
 * staple after its blocks have moved to main.
 */
export type SideVoteRow = {
	readonly vote: Vote;
	readonly blocks: readonly Block[];
};

export type DeferredStapleRow = {
	readonly staple: VoteStaple;
	readonly waitingOn: readonly BlockHashKey[];
};

type Table<Key extends string, Value> = {
	readonly key: Key;
	readonly value: Value;
};

/**
 * Every table of the memory ledger. One-to-many relations are stored as
 * immutable inner maps or lists that a write replaces, so a table value is
 * never mutated in place and a transaction can never leak into committed state.
 */
export type LedgerTables = {
	readonly blocks: Table<BlockHashKey, ConfirmedBlockRow>;
	/** The confirmed successor of each block, including the opening sentinel. */
	readonly successors: Table<BlockHashKey, BlockHashKey>;
	readonly chainHeads: Table<AccountKey, BlockHashKey>;
	readonly staples: Table<StapleKey, StapleRow>;
	readonly balances: Table<AccountKey, ReadonlyMap<AccountKey, BalanceRow>>;
	readonly accountInfo: Table<AccountKey, AccountInfoRow>;
	readonly representatives: Table<AccountKey, Account>;
	readonly weights: Table<AccountKey, bigint>;
	readonly acls: Table<PrincipalKey, ReadonlyMap<ACLScopeKey, ACLRow>>;
	readonly certificates: Table<AccountKey, ReadonlyMap<CertificateHashKey, CertificateWithIntermediates>>;
	readonly idempotentKeys: Table<IdempotentKeyString, BlockHash>;
	readonly accounts: Table<AccountKey, AccountRow>;
	/** Staples involving each account, oldest first. */
	readonly history: Table<AccountKey, readonly StapleKey[]>;
	readonly deferredStaples: Table<StapleKey, DeferredStapleRow>;
	readonly deferredWaiters: Table<BlockHashKey, ReadonlySet<StapleKey>>;
	/** This node's own pending votes, expired ones included until they are collected. */
	readonly sideVotes: Table<VoteKey, SideVoteRow>;
	/** Side copies of the blocks our pending votes cover, until those blocks move to main. */
	readonly sideBlocks: Table<BlockHashKey, Block>;
	/** The pending votes covering each block. */
	readonly sideVotesByBlock: Table<BlockHashKey, ReadonlySet<VoteKey>>;
	/** The pending votes covering a block whose previous is the key, including the opening sentinel. */
	readonly sideVotesByPrevious: Table<BlockHashKey, ReadonlySet<VoteKey>>;
	readonly sideVotesByStaple: Table<StapleKey, ReadonlySet<VoteKey>>;
	/** The side blocks claiming each idempotent key. */
	readonly sideIdempotentKeys: Table<IdempotentKeyString, ReadonlySet<BlockHashKey>>;
};

type TableName = keyof LedgerTables;
type KeyOf<Name extends TableName> = LedgerTables[Name]['key'];
type ValueOf<Name extends TableName> = LedgerTables[Name]['value'];

/** The committed state: one map per table. */
export type CommittedLedger = {
	readonly [Name in TableName]: Map<KeyOf<Name>, ValueOf<Name>>;
};

/** Where a table's rows live: the committed maps, or an enclosing overlay. */
export type TableStore<Key extends string, Value> = {
	get(key: Key): Value | undefined;
	set(key: Key, value: Value): void;
	delete(key: Key): void;
	entries(): Iterable<[Key, Value]>;
};

/** Every table, held in some kind of store. */
type LedgerStores = {
	readonly [Name in TableName]: TableStore<KeyOf<Name>, ValueOf<Name>>;
};

const deleted: unique symbol = Symbol('deleted');

/**
 * One table seen through pending writes: reads fall through to the underlying
 * store unless the key was written here, and writes reach the store only on
 * commit. All operations are synchronous, so calls that upstream runs
 * concurrently within one transaction interleave only between whole reads and
 * whole writes.
 */
export class TableOverlay<Key extends string, Value> implements TableStore<Key, Value> {
	readonly #underlying: TableStore<Key, Value>;
	readonly #writes = new Map<Key, Value | typeof deleted>();

	constructor(underlying: TableStore<Key, Value>) {
		this.#underlying = underlying;
	}

	get(key: Key): Value | undefined {
		const written = this.#writes.get(key);
		if (written === deleted) {
			return(undefined);
		}
		if (written !== undefined) {
			return(written);
		}
		return(this.#underlying.get(key));
	}

	set(key: Key, value: Value): void {
		this.#writes.set(key, value);
	}

	delete(key: Key): void {
		this.#writes.set(key, deleted);
	}

	*entries(): Generator<[Key, Value]> {
		for (const [key, value] of this.#underlying.entries()) {
			if (!this.#writes.has(key)) {
				yield([key, value]);
			}
		}
		for (const [key, value] of this.#writes) {
			if (value !== deleted) {
				yield([key, value]);
			}
		}
	}

	commit(): void {
		for (const [key, value] of this.#writes) {
			if (value === deleted) {
				this.#underlying.delete(key);
			} else {
				this.#underlying.set(key, value);
			}
		}
		this.#writes.clear();
	}
}

/**
 * The state as one transaction sees it. An overlay can also open over another
 * overlay, which stages a group of writes that must land together.
 */
export type LedgerOverlay = {
	readonly [Name in TableName]: TableOverlay<KeyOf<Name>, ValueOf<Name>>;
};

export function createCommittedLedger(): CommittedLedger {
	return({
		blocks: new Map(),
		successors: new Map(),
		chainHeads: new Map(),
		staples: new Map(),
		balances: new Map(),
		accountInfo: new Map(),
		representatives: new Map(),
		weights: new Map(),
		acls: new Map(),
		certificates: new Map(),
		idempotentKeys: new Map(),
		accounts: new Map(),
		history: new Map(),
		deferredStaples: new Map(),
		deferredWaiters: new Map(),
		sideVotes: new Map(),
		sideBlocks: new Map(),
		sideVotesByBlock: new Map(),
		sideVotesByPrevious: new Map(),
		sideVotesByStaple: new Map(),
		sideIdempotentKeys: new Map()
	});
}

export function openOverlay(underlying: LedgerStores): LedgerOverlay {
	return({
		blocks: new TableOverlay(underlying.blocks),
		successors: new TableOverlay(underlying.successors),
		chainHeads: new TableOverlay(underlying.chainHeads),
		staples: new TableOverlay(underlying.staples),
		balances: new TableOverlay(underlying.balances),
		accountInfo: new TableOverlay(underlying.accountInfo),
		representatives: new TableOverlay(underlying.representatives),
		weights: new TableOverlay(underlying.weights),
		acls: new TableOverlay(underlying.acls),
		certificates: new TableOverlay(underlying.certificates),
		idempotentKeys: new TableOverlay(underlying.idempotentKeys),
		accounts: new TableOverlay(underlying.accounts),
		history: new TableOverlay(underlying.history),
		deferredStaples: new TableOverlay(underlying.deferredStaples),
		deferredWaiters: new TableOverlay(underlying.deferredWaiters),
		sideVotes: new TableOverlay(underlying.sideVotes),
		sideBlocks: new TableOverlay(underlying.sideBlocks),
		sideVotesByBlock: new TableOverlay(underlying.sideVotesByBlock),
		sideVotesByPrevious: new TableOverlay(underlying.sideVotesByPrevious),
		sideVotesByStaple: new TableOverlay(underlying.sideVotesByStaple),
		sideIdempotentKeys: new TableOverlay(underlying.sideIdempotentKeys)
	});
}

/*
 * Writes are applied table by table without yielding, so nothing can observe a
 * half-applied overlay. A transaction overlay commits under the lock, so the
 * committed state has not moved since it opened.
 */
export function commitOverlay(overlay: LedgerOverlay): void {
	const tables: readonly { commit(): void }[] = Object.values<{ commit(): void }>(overlay);
	for (const table of tables) {
		table.commit();
	}
}
