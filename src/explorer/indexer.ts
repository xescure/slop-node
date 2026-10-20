import { readdir } from 'node:fs/promises';
import type pg from 'pg';
import type { LogEntry, LogTarget } from '@keetanetwork/keetanet-client/lib/log/common.js';
import type { LogLevel } from '@keetanetwork/keetanet-client/lib/log/index.js';
import { describeError } from '../ledger/storage/errors.js';
import { SCHEMA_MIGRATIONS } from '../ledger/storage/postgres/migrations.js';
import { assertNever } from '../util/assert-never.js';
import { addressesOf, decodeBlock, type Address, type DecodedBlock } from './decode.js';
import { advanceWatermark, toStapleSequence, type StapleSequence, type Watermark } from './watermark.js';

export type IndexerSettings = {
	readonly batchStaples: number;
	readonly batchPauseMilliseconds: number;
	readonly pollMilliseconds: number;
	readonly reconcileMilliseconds: number;
	readonly holdingsCheckMilliseconds: number;
};

export const DEFAULT_INDEXER_SETTINGS: IndexerSettings = {
	batchStaples: 200,
	batchPauseMilliseconds: 50,
	pollMilliseconds: 1000,
	reconcileMilliseconds: 3_600_000,
	holdingsCheckMilliseconds: 86_400_000
};

export type IndexerState =
	| { readonly kind: 'running'; readonly watermark: Watermark }
	| { readonly kind: 'paused'; readonly reason: 'node-schema-newer'; readonly nodeVersion: number; readonly newestKnown: number };

export type BatchResult = { readonly indexed: number; readonly state: IndexerState };

export type Freshness = {
	readonly newestIndexed: { sequence: bigint; stapleTime: Date } | null;
	readonly newestNode: { sequence: bigint; stapleTime: Date } | null;
	readonly behind: number;
	readonly paused: string | null;
};

/** What a backstop found that the indexing of each staple should have prevented. */
export type IndexerFault =
	| { readonly kind: 'missed-staple'; readonly blocksHash: string; readonly sequence: bigint }
	| { readonly kind: 'holding-differs'; readonly accountID: string; readonly tokenID: string; readonly node: string | null; readonly explorer: string | null };

export type IndexerProblem =
	| { readonly kind: 'undecodable-block'; readonly staple: string; readonly block: string }
	| { readonly kind: 'unknown-account'; readonly staple: string; readonly address: Address }
	| { readonly kind: 'unchained-block'; readonly staple: string; readonly block: string };

const describeProblem = function(problem: IndexerProblem): string {
	switch (problem.kind) {
		case 'undecodable-block':
			return(`staple ${problem.staple}: block ${problem.block} does not decode`);
		case 'unknown-account':
			return(`staple ${problem.staple}: ${problem.address} has no id in public.accounts`);
		case 'unchained-block':
			return(`staple ${problem.staple}: block ${problem.block} has no height in public.chain`);
		default:
			return(assertNever(problem));
	}
};

/** A staple the indexer cannot index; it stops on that staple rather than pass it. */
export class IndexerError extends Error {
	readonly problem: IndexerProblem;

	constructor(problem: IndexerProblem, options?: ErrorOptions) {
		super(describeProblem(problem), options);
		this.name = 'IndexerError';
		this.problem = problem;
	}
}

const NODE_MIGRATION_FILE_NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** The newest version among the node migration files this build ships. */
export const knownNodeVersions = async function(directory: URL = SCHEMA_MIGRATIONS): Promise<number> {
	let newest = 0;
	for (const name of await readdir(directory)) {
		const version = Number(NODE_MIGRATION_FILE_NAME.exec(name)?.[1] ?? 0);
		newest = Math.max(newest, version);
	}
	if (newest === 0) {
		throw(new Error(`no node migrations in ${directory.href}`));
	}
	return(newest);
};

/*
 * The node applies staples in SERIALIZABLE transactions; reading its tables
 * at that level would make the explorer a party to their conflicts.
 */
const inTransaction = async function<Result>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<Result>): Promise<Result> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
		const result = await work(client);
		await client.query('COMMIT');
		return(result);
	} catch (error: unknown) {
		await client.query('ROLLBACK').catch(function() {
			// The connection is released either way; the original error is the one to report.
		});
		throw(error);
	} finally {
		client.release();
	}
};

const pausedReason = function(nodeVersion: number, newestKnown: number): string {
	return(`node schema ${String(nodeVersion)} is newer than this build, which knows up to ${String(newestKnown)}`);
};

type StapleRow = { readonly blocks_hash: Buffer; readonly sequence: string; readonly staple_time: Date };

type BlockRow = { readonly hash: Buffer; readonly bytes: Buffer; readonly staple_position: number; readonly height: string | null };

const hexOf = function(bytes: Buffer): string {
	return(bytes.toString('hex').toUpperCase());
};

const decodeRow = function(staple: string, row: BlockRow): DecodedBlock {
	try {
		return(decodeBlock(row.bytes));
	} catch (error: unknown) {
		throw(new IndexerError({ kind: 'undecodable-block', staple, block: hexOf(row.hash) }, { cause: error }));
	}
};

const accountIDs = async function(client: pg.PoolClient, staple: string, blocks: readonly DecodedBlock[]): Promise<ReadonlyMap<Address, string>> {
	const named = new Set<Address>();
	for (const block of blocks) {
		for (const address of addressesOf(block)) {
			named.add(address);
		}
	}
	const rows = await client.query<{ id: string; public_key: Address }>('SELECT id, public_key FROM public.accounts WHERE public_key = ANY($1::text[])', [[...named]]);
	const ids = new Map(rows.rows.map(function(row): [Address, string] {
		return([row.public_key, row.id]);
	}));
	for (const address of named) {
		if (!ids.has(address)) {
			throw(new IndexerError({ kind: 'unknown-account', staple, address }));
		}
	}
	return(ids);
};

const idOf = function(ids: ReadonlyMap<Address, string>, address: Address): string {
	const id = ids.get(address);
	if (id === undefined) {
		throw(new Error(`internal error: ${address} was not resolved`));
	}
	return(id);
};

const optionalIDOf = function(ids: ReadonlyMap<Address, string>, address: Address | null): string | null {
	if (address === null) {
		return(null);
	}
	return(idOf(ids, address));
};

const insertBlocks = async function(client: pg.PoolClient, staple: StapleRow, rows: readonly BlockRow[], blocks: readonly DecodedBlock[], ids: ReadonlyMap<Address, string>): Promise<void> {
	const stapleHex = hexOf(staple.blocks_hash);
	const heights = rows.map(function(row): string {
		if (row.height === null) {
			throw(new IndexerError({ kind: 'unchained-block', staple: stapleHex, block: hexOf(row.hash) }));
		}
		return(row.height);
	});
	// A reconcile may index again a staple whose rows were left in part, so they are written afresh.
	const hashes = rows.map(function(row) {
		return(row.hash);
	});
	await client.query('DELETE FROM explorer.operations WHERE block_hash = ANY($1::bytea[])', [hashes]);
	await client.query('DELETE FROM explorer.blocks WHERE hash = ANY($1::bytea[])', [hashes]);
	await client.query(`
		INSERT INTO explorer.blocks (hash, account_id, height, date, version, purpose, signer_id, staple, staple_time, position, operation_count)
		SELECT hash, account_id, height, date, version, purpose, signer_id, $8, $9, position, operation_count
		FROM unnest($1::bytea[], $2::bigint[], $3::bigint[], $4::timestamptz[], $5::smallint[], $6::smallint[], $7::bigint[], $10::integer[], $11::integer[])
			AS block (hash, account_id, height, date, version, purpose, signer_id, position, operation_count)`, [
		hashes,
		blocks.map(function(block) {
			return(idOf(ids, block.account));
		}),
		heights,
		blocks.map(function(block) {
			return(block.date);
		}),
		blocks.map(function(block) {
			return(block.version);
		}),
		blocks.map(function(block) {
			return(block.purpose);
		}),
		blocks.map(function(block) {
			return(idOf(ids, block.signer));
		}),
		staple.blocks_hash,
		staple.staple_time,
		rows.map(function(row) {
			return(row.staple_position);
		}),
		blocks.map(function(block) {
			return(block.operations.length);
		})
	]);
	const operations = blocks.flatMap(function(block, position) {
		return(block.operations.map(function(operation) {
			return({ blockHash: rows[position]?.hash, operation });
		}));
	});
	await client.query(`
		INSERT INTO explorer.operations (block_hash, idx, type, account_id, counterparty_id, token_id, amount, staple_time, details)
		SELECT block_hash, idx, type, account_id, counterparty_id, token_id, amount, $8, details::jsonb
		FROM unnest($1::bytea[], $2::integer[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::numeric[], $9::text[])
			AS operation (block_hash, idx, type, account_id, counterparty_id, token_id, amount, details)`, [
		operations.map(function(row) {
			return(row.blockHash);
		}),
		operations.map(function(row) {
			return(row.operation.index);
		}),
		operations.map(function(row) {
			return(row.operation.type);
		}),
		operations.map(function(row) {
			return(idOf(ids, row.operation.account));
		}),
		operations.map(function(row) {
			return(optionalIDOf(ids, row.operation.counterparty));
		}),
		operations.map(function(row) {
			return(optionalIDOf(ids, row.operation.token));
		}),
		operations.map(function(row) {
			return(row.operation.amount?.toString() ?? null);
		}),
		staple.staple_time,
		operations.map(function(row) {
			return(JSON.stringify(row.operation.details));
		})
	]);
};

/*
 * Every balance a staple changes is of an account one of its blocks names:
 * a block's own, a send's or receive's counterparty, or the token whose
 * supply it changes, which addressesOf includes.
 */
const replaceHoldings = async function(client: pg.PoolClient, accounts: readonly string[]): Promise<void> {
	await client.query('DELETE FROM explorer.holdings WHERE account_id = ANY($1::bigint[])', [accounts]);
	await client.query(`
		INSERT INTO explorer.holdings (token_id, account_id, balance)
		SELECT token_id, account_id, balance FROM public.balances WHERE account_id = ANY($1::bigint[]) AND balance <> 0`, [accounts]);
};

const indexStaple = async function(writer: pg.Pool, staple: StapleRow, now: () => number): Promise<void> {
	const stapleHex = hexOf(staple.blocks_hash);
	await inTransaction(writer, async function(client) {
		const rows = await client.query<BlockRow>(`
			SELECT block.hash, block.bytes, block.staple_position, chain.height
			FROM public.blocks block LEFT JOIN public.chain chain ON chain.block_hash = block.hash
			WHERE block.staple = $1 AND block.ledger = 'main'
			ORDER BY block.staple_position`, [staple.blocks_hash]);
		const blocks = rows.rows.map(function(row) {
			return(decodeRow(stapleHex, row));
		});
		const ids = await accountIDs(client, stapleHex, blocks);
		await insertBlocks(client, staple, rows.rows, blocks, ids);
		await client.query(`
			INSERT INTO explorer.indexed_staples (blocks_hash, sequence, staple_time, block_count, indexed_at)
			VALUES ($1, $2, $3, $4, $5)`, [staple.blocks_hash, staple.sequence, staple.staple_time, blocks.length, new Date(now())]);
		await replaceHoldings(client, [...new Set(ids.values())]);
	});
};

const nodeVersionOf = async function(writer: pg.Pool): Promise<number> {
	const rows = await inTransaction(writer, function(client) {
		return(client.query<{ version: number | null }>('SELECT max(version) AS version FROM public.schema_version'));
	});
	return(rows.rows[0]?.version ?? 0);
};

const storedWatermark = async function(client: pg.Pool): Promise<StapleSequence> {
	const rows = await client.query<{ watermark: string }>('SELECT watermark FROM explorer.progress');
	return(toStapleSequence(BigInt(rows.rows[0]?.watermark ?? '0')));
};

/** The state a newly started indexer resumes from: the persisted watermark, with no gap timed yet. */
export const startingState = async function(writer: pg.Pool): Promise<IndexerState> {
	return({ kind: 'running', watermark: { through: await storedWatermark(writer), missingSince: new Map() } });
};

// Both run every poll, so each writes only when the reason changes.
const pause = async function(writer: pg.Pool, nodeVersion: number, newestKnown: number): Promise<BatchResult> {
	await writer.query('UPDATE explorer.progress SET paused_reason = $1 WHERE paused_reason IS DISTINCT FROM $1', [pausedReason(nodeVersion, newestKnown)]);
	return({ indexed: 0, state: { kind: 'paused', reason: 'node-schema-newer', nodeVersion, newestKnown } });
};

const resume = async function(writer: pg.Pool, state: IndexerState): Promise<Watermark> {
	await writer.query('UPDATE explorer.progress SET paused_reason = NULL WHERE paused_reason IS NOT NULL');
	switch (state.kind) {
		case 'running':
			return(state.watermark);
		case 'paused':
			return({ through: await storedWatermark(writer), missingSince: new Map() });
		default:
			return(assertNever(state));
	}
};

/** The staples past the watermark that the loop indexes next, or those at or below it that it passed. */
type StapleRange =
	| { readonly kind: 'above'; readonly through: StapleSequence; readonly limit: number }
	| { readonly kind: 'passed'; readonly through: StapleSequence };

const rangeCondition = function(range: StapleRange): { readonly where: string; readonly limit: number | null } {
	switch (range.kind) {
		case 'above':
			return({ where: 'staple.sequence > $1', limit: range.limit });
		case 'passed':
			return({ where: 'staple.sequence <= $1', limit: null });
		default:
			return(assertNever(range));
	}
};

const staplesToIndex = async function(writer: pg.Pool, range: StapleRange): Promise<readonly StapleRow[]> {
	const { where, limit } = rangeCondition(range);
	const rows = await inTransaction(writer, function(client) {
		return(client.query<StapleRow>(`
			SELECT staple.blocks_hash, staple.sequence, staple.staple_time FROM public.staples staple
			WHERE ${where}
				AND NOT EXISTS (SELECT FROM explorer.indexed_staples indexed WHERE indexed.blocks_hash = staple.blocks_hash)
			ORDER BY staple.sequence
			LIMIT $2`, [range.through, limit]));
	});
	return(rows.rows);
};

/** Indexes the next staples past the watermark, then advances the watermark over every sequence indexed or long missing. */
export const indexBatch = async function(writer: pg.Pool, state: IndexerState, settings: IndexerSettings, now: () => number): Promise<BatchResult> {
	const nodeVersion = await nodeVersionOf(writer);
	const newestKnown = await knownNodeVersions();
	if (nodeVersion > newestKnown) {
		return(await pause(writer, nodeVersion, newestKnown));
	}
	const current = await resume(writer, state);

	const staples = await staplesToIndex(writer, { kind: 'above', through: current.through, limit: settings.batchStaples });
	for (const staple of staples) {
		await indexStaple(writer, staple, now);
	}

	const above = await writer.query<{ sequence: string }>('SELECT sequence FROM explorer.indexed_staples WHERE sequence > $1 ORDER BY sequence', [current.through]);
	const watermark = advanceWatermark(current, above.rows.map(function(row) {
		return(toStapleSequence(BigInt(row.sequence)));
	}), now());
	if (watermark.through !== current.through) {
		// A second indexer may have run for a while during a deploy; the watermark never moves back.
		await writer.query('UPDATE explorer.progress SET watermark = GREATEST(watermark, $1)', [watermark.through]);
	}
	return({ indexed: staples.length, state: { kind: 'running', watermark } });
};

const ignoreFault = function(): void {
	// A caller that passes no report counts the faults by the result alone.
};

/** Indexes every staple at or below the watermark that is not indexed; each one is a fault of the watermark. */
export const reconcile = async function(writer: pg.Pool, report: (fault: IndexerFault) => void = ignoreFault): Promise<number> {
	const through = await storedWatermark(writer);
	const missed = await staplesToIndex(writer, { kind: 'passed', through });
	for (const staple of missed) {
		report({ kind: 'missed-staple', blocksHash: hexOf(staple.blocks_hash), sequence: BigInt(staple.sequence) });
		await indexStaple(writer, staple, Date.now);
	}
	return(missed.length);
};

type HoldingDifference = { readonly account_id: string; readonly token_id: string; readonly node: string | null; readonly explorer: string | null };

type HoldingPairs = { readonly accounts: readonly string[]; readonly tokens: readonly string[] };

const pairsOf = function(rows: readonly HoldingDifference[]): HoldingPairs {
	return({
		accounts: rows.map(function(row) {
			return(row.account_id);
		}),
		tokens: rows.map(function(row) {
			return(row.token_id);
		})
	});
};

// With no pairs given, every row of both tables is compared.
const holdingDifferences = async function(client: pg.PoolClient, pairs: HoldingPairs | null): Promise<readonly HoldingDifference[]> {
	const rows = await client.query<HoldingDifference>(`
		SELECT coalesce(node.account_id, held.account_id) AS account_id, coalesce(node.token_id, held.token_id) AS token_id,
			node.balance::text AS node, held.balance::text AS explorer
		FROM (SELECT account_id, token_id, balance FROM public.balances WHERE balance <> 0) node
		FULL JOIN explorer.holdings held ON held.account_id = node.account_id AND held.token_id = node.token_id
		WHERE node.balance IS DISTINCT FROM held.balance
			AND ($1::bigint[] IS NULL OR (coalesce(node.account_id, held.account_id), coalesce(node.token_id, held.token_id)) IN (
				SELECT pair.account_id, pair.token_id FROM unnest($1::bigint[], $2::bigint[]) AS pair (account_id, token_id)))`,
	[pairs?.accounts ?? null, pairs?.tokens ?? null]);
	return(rows.rows);
};

const repairHoldings = async function(client: pg.PoolClient, pairs: HoldingPairs): Promise<void> {
	await client.query(`
		DELETE FROM explorer.holdings held USING unnest($1::bigint[], $2::bigint[]) AS pair (account_id, token_id)
		WHERE held.account_id = pair.account_id AND held.token_id = pair.token_id`, [pairs.accounts, pairs.tokens]);
	await client.query(`
		INSERT INTO explorer.holdings (token_id, account_id, balance)
		SELECT node.token_id, node.account_id, node.balance
		FROM public.balances node JOIN unnest($1::bigint[], $2::bigint[]) AS pair (account_id, token_id)
			ON node.account_id = pair.account_id AND node.token_id = pair.token_id
		WHERE node.balance <> 0`, [pairs.accounts, pairs.tokens]);
};

/*
 * A staple the node applied that the loop has not reached yet differs from
 * the holdings without any fault, so the staples pending are indexed and only
 * the rows that still differ after it are faults.
 */
export const checkHoldings = async function(writer: pg.Pool, report: (fault: IndexerFault) => void = ignoreFault): Promise<number> {
	const suspects = await inTransaction(writer, function(client) {
		return(holdingDifferences(client, null));
	});
	if (suspects.length === 0) {
		return(0);
	}
	let state = await startingState(writer);
	for (;;) {
		const result = await indexBatch(writer, state, DEFAULT_INDEXER_SETTINGS, Date.now);
		state = result.state;
		if (result.indexed < DEFAULT_INDEXER_SETTINGS.batchStaples) {
			break;
		}
	}
	const differences = await inTransaction(writer, async function(client) {
		const still = await holdingDifferences(client, pairsOf(suspects));
		await repairHoldings(client, pairsOf(still));
		return(still);
	});
	for (const row of differences) {
		report({ kind: 'holding-differs', accountID: row.account_id, tokenID: row.token_id, node: row.node, explorer: row.explorer });
	}
	return(differences.length);
};

type NewestRow = { readonly sequence: string; readonly staple_time: Date };

const newestOf = function(rows: readonly NewestRow[]): { sequence: bigint; stapleTime: Date } | null {
	const row = rows[0];
	if (row === undefined) {
		return(null);
	}
	return({ sequence: BigInt(row.sequence), stapleTime: row.staple_time });
};

/** The newest staple indexed, the newest the node holds, and how many past the watermark are not indexed yet. */
export const freshness = async function(pool: pg.Pool): Promise<Freshness> {
	return(await inTransaction(pool, async function(client) {
		const indexed = await client.query<NewestRow>('SELECT sequence, staple_time FROM explorer.indexed_staples ORDER BY sequence DESC LIMIT 1');
		const node = await client.query<NewestRow>('SELECT sequence, staple_time FROM public.staples ORDER BY sequence DESC LIMIT 1');
		const progress = await client.query<{ behind: string; paused_reason: string | null }>(`
			SELECT progress.paused_reason, (
				SELECT count(*) FROM public.staples staple
				WHERE staple.sequence > progress.watermark
					AND NOT EXISTS (SELECT FROM explorer.indexed_staples indexed WHERE indexed.blocks_hash = staple.blocks_hash)
			) AS behind
			FROM explorer.progress progress`);
		const row = progress.rows[0];
		return({
			newestIndexed: newestOf(indexed.rows),
			newestNode: newestOf(node.rows),
			behind: Number(row?.behind ?? 0),
			paused: row?.paused_reason ?? null
		});
	}));
};

const LOG_FROM = 'explorer/indexer';

const describeFault = function(fault: IndexerFault): string {
	switch (fault.kind) {
		case 'missed-staple':
			return(`indexer fault: staple ${fault.blocksHash} at sequence ${fault.sequence.toString()} was passed by the watermark but not indexed`);
		case 'holding-differs':
			return(`indexer fault: holding of token ${fault.tokenID} by account ${fault.accountID} was ${fault.explorer ?? 'absent'}, the node holds ${fault.node ?? 'none'}`);
		default:
			return(assertNever(fault));
	}
};

/*
 * A deploy starts the new container before it stops the old one, and two
 * indexers would race on the watermark, so one session lock, held on a
 * connection of its own for the indexer's life, lets one index at a time.
 * Its key is ASCII keetaidx, distinct from both migration locks.
 */
const INDEXER_LOCK_KEY = 0x6b65657461696478n;

type Step = 'index' | 'reconcile' | 'holdings';

const STEP_FAILURES: Readonly<Record<Step, string>> = {
	index: 'indexing stopped',
	reconcile: 'the reconcile failed',
	holdings: 'the holdings check failed'
};

/** Runs the batches, the reconcile and the holdings check on their schedules until stopped, while it holds the indexer lock. */
export class Indexer {
	readonly #writer: pg.Pool;
	readonly #settings: IndexerSettings;
	readonly #log: LogTarget;
	#running: Promise<void> | null = null;
	#stopping = false;
	#wake: (() => void) | null = null;
	readonly #lastErrors = new Map<Step, string>();

	constructor(writer: pg.Pool, settings: IndexerSettings, log: LogTarget) {
		this.#writer = writer;
		this.#settings = settings;
		this.#log = log;
	}

	start(): void {
		if (this.#running !== null) {
			return;
		}
		this.#stopping = false;
		this.#running = this.#run();
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		this.#wake?.();
		await this.#running;
		this.#running = null;
	}

	#emit(level: LogLevel, message: string): void {
		const entry: LogEntry = { options: {}, level, from: LOG_FROM, args: [message] };
		this.#log.emitLogs([entry]).catch(function() {
			// A target that cannot write has nowhere to report that it cannot.
		});
	}

	#fault = (fault: IndexerFault): void => {
		this.#emit('ERROR', describeFault(fault));
	};

	// A failure that persists is logged once, not once a poll, until the step succeeds or fails otherwise.
	async #attempt<Result>(step: Step, work: () => Promise<Result>): Promise<Result | undefined> {
		try {
			const result = await work();
			this.#lastErrors.delete(step);
			return(result);
		} catch (error: unknown) {
			const message = describeError(error);
			if (this.#lastErrors.get(step) !== message) {
				this.#emit('ERROR', `${STEP_FAILURES[step]}: ${message}`);
			}
			this.#lastErrors.set(step, message);
			return(undefined);
		}
	}

	// A stop during a batch finds no sleep to wake, so the sleep that follows the batch ends at once.
	#sleep(milliseconds: number): Promise<void> {
		return(new Promise((resolve) => {
			if (this.#stopping) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, milliseconds);
			this.#wake = function() {
				clearTimeout(timer);
				resolve();
			};
		}));
	}

	async #lock(client: pg.PoolClient): Promise<boolean> {
		let waiting = false;
		while (!this.#stopping) {
			const held = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS locked', [INDEXER_LOCK_KEY.toString()]);
			if (held.rows[0]?.locked === true) {
				return(true);
			}
			if (!waiting) {
				this.#emit('INFO', 'another indexer holds the indexer lock; waiting for it to stop');
				waiting = true;
			}
			await this.#sleep(this.#settings.pollMilliseconds);
		}
		return(false);
	}

	async #connect(): Promise<pg.PoolClient | undefined> {
		while (!this.#stopping) {
			const client = await this.#attempt('index', () => {
				return(this.#writer.connect());
			});
			if (client !== undefined) {
				return(client);
			}
			await this.#sleep(this.#settings.pollMilliseconds);
		}
		return(undefined);
	}

	async #run(): Promise<void> {
		const client = await this.#connect();
		if (client === undefined) {
			return;
		}
		let locked = false;
		try {
			locked = await this.#lock(client);
			if (locked) {
				await this.#index();
			}
		} finally {
			if (locked) {
				await client.query('SELECT pg_advisory_unlock($1::bigint)', [INDEXER_LOCK_KEY.toString()]).catch(function() {
					// The lock ends with the session if the connection is gone.
				});
			}
			client.release();
		}
	}

	async #batch(state: IndexerState | undefined): Promise<BatchResult> {
		const before = state ?? await startingState(this.#writer);
		const result = await indexBatch(this.#writer, before, this.#settings, Date.now);
		if (result.state.kind === 'paused' && before.kind !== 'paused') {
			this.#emit('ERROR', `indexing paused: ${pausedReason(result.state.nodeVersion, result.state.newestKnown)}`);
		}
		return(result);
	}

	// A full batch leaves more to index, so the next comes after the short pause that throttles a backfill.
	#pauseAfter(result: BatchResult | undefined): number {
		if (result !== undefined && result.indexed >= this.#settings.batchStaples) {
			return(this.#settings.batchPauseMilliseconds);
		}
		return(this.#settings.pollMilliseconds);
	}

	async #index(): Promise<void> {
		let state: IndexerState | undefined;
		let reconciled = Date.now();
		let holdingsChecked = Date.now();
		while (!this.#stopping) {
			const result = await this.#attempt('index', () => {
				return(this.#batch(state));
			});
			state = result?.state ?? state;
			// Under a node schema this build does not know, nothing is written.
			const running = state?.kind === 'running';
			if (running && Date.now() - reconciled >= this.#settings.reconcileMilliseconds) {
				reconciled = Date.now();
				await this.#attempt('reconcile', () => {
					return(reconcile(this.#writer, this.#fault));
				});
			}
			if (running && Date.now() - holdingsChecked >= this.#settings.holdingsCheckMilliseconds) {
				holdingsChecked = Date.now();
				await this.#attempt('holdings', () => {
					return(checkHoldings(this.#writer, this.#fault));
				});
			}
			await this.#sleep(this.#pauseAfter(result));
		}
	}
}
