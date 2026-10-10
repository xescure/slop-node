import { NO_STAGED } from '../stage.js';
import type { BootstrapStage, StagedCounts, StagedStaple } from '../stage.js';
import type { MigratedPostgresPool } from './pool.js';
import { fromInteger, statement } from './sql.js';
import type { IntegerText, SQLValue, Statement } from './sql.js';

type StagedColumns = { readonly blocks_hash: Buffer; readonly first_vote_from: Date; readonly last_vote_from: Date; readonly bytes: Buffer };

type CountColumns = { readonly staples: IntegerText; readonly bytes: IntegerText };

const putStaged: Statement<[Buffer[], Date[], Date[], Buffer[]], CountColumns> = statement('put_staged', `
	WITH kept AS (
		INSERT INTO bootstrap_stage (blocks_hash, first_vote_from, last_vote_from, bytes)
		SELECT * FROM unnest($1::bytea[], $2::timestamptz[], $3::timestamptz[], $4::bytea[])
		ON CONFLICT (blocks_hash) DO NOTHING
		RETURNING octet_length(bytes) AS size
	)
	SELECT count(*) AS staples, COALESCE(sum(size), 0) AS bytes FROM kept`);

const holdsStaged: Statement<[Buffer], { readonly held: boolean }> = statement('holds_staged', `
	SELECT EXISTS (SELECT 1 FROM bootstrap_stage WHERE blocks_hash = $1) AS held`);

const stagedFirstBefore: Statement<[Date, number, Buffer[]], StagedColumns> = statement('staged_first_before', `
	SELECT blocks_hash, first_vote_from, last_vote_from, bytes FROM bootstrap_stage
	WHERE first_vote_from < $1 AND blocks_hash <> ALL($3::bytea[])
	ORDER BY first_vote_from, blocks_hash
	LIMIT $2`);

const stagedLastFrom: Statement<[Date, number], StagedColumns> = statement('staged_last_from', `
	SELECT blocks_hash, first_vote_from, last_vote_from, bytes FROM bootstrap_stage
	WHERE last_vote_from >= $1
	ORDER BY last_vote_from, blocks_hash
	LIMIT $2`);

const removeStaged: Statement<[Buffer[]], CountColumns> = statement('remove_staged', `
	WITH dropped AS (
		DELETE FROM bootstrap_stage WHERE blocks_hash = ANY($1::bytea[])
		RETURNING octet_length(bytes) AS size
	)
	SELECT count(*) AS staples, COALESCE(sum(size), 0) AS bytes FROM dropped`);

const countStaged: Statement<[], CountColumns> = statement('count_staged', `
	SELECT count(*) AS staples, COALESCE(sum(octet_length(bytes)), 0) AS bytes FROM bootstrap_stage`);

function stagedOf(row: StagedColumns): StagedStaple {
	const bytes = row.bytes.buffer.slice(row.bytes.byteOffset, row.bytes.byteOffset + row.bytes.byteLength);
	return({ key: row.blocks_hash.toString('hex').toUpperCase(), bytes, firstVote: row.first_vote_from, lastVote: row.last_vote_from });
}

function countsOf(rows: readonly CountColumns[]): StagedCounts {
	const [row] = rows;
	if (row === undefined) {
		throw(new Error('internal error: a count of the bootstrap stage returned no row'));
	}
	return({ staples: Number(fromInteger(row.staples)), bytes: Number(fromInteger(row.bytes)) });
}

function keyBytes(key: string): Buffer {
	return(Buffer.from(key, 'hex'));
}

/**
 * The bootstrap stage in `bootstrap_stage` (schema/migrations/0010_bootstrap_stage.sql):
 * each call is one statement on a pooled connection, outside every ledger
 * transaction, so what it writes is committed when it returns.
 */
export class PostgresBootstrapStage implements BootstrapStage {
	readonly #pool: MigratedPostgresPool;

	constructor(pool: MigratedPostgresPool) {
		this.#pool = pool;
	}

	async #run<Parameters extends readonly SQLValue[], Row extends object>(query: Statement<Parameters, Row>, parameters: Parameters): Promise<Row[]> {
		const { pool } = await this.#pool.connection();
		return((await pool.query<Row>({ name: query.name, text: query.text, values: [...parameters] })).rows);
	}

	async put(staples: readonly StagedStaple[]): Promise<StagedCounts> {
		if (staples.length === 0) {
			return(NO_STAGED);
		}
		return(countsOf(await this.#run(putStaged, [
			staples.map(function(staple): Buffer {
				return(keyBytes(staple.key));
			}),
			staples.map(function(staple): Date {
				return(staple.firstVote);
			}),
			staples.map(function(staple): Date {
				return(staple.lastVote);
			}),
			staples.map(function(staple): Buffer {
				return(Buffer.from(staple.bytes));
			})
		])));
	}

	async holds(key: string): Promise<boolean> {
		const [row] = await this.#run(holdsStaged, [keyBytes(key)]);
		return(row?.held === true);
	}

	async firstBefore(moment: Date, count: number, leftOut: readonly string[] = []): Promise<StagedStaple[]> {
		return((await this.#run(stagedFirstBefore, [moment, count, leftOut.map(keyBytes)])).map(stagedOf));
	}

	async lastFrom(moment: Date, count: number): Promise<StagedStaple[]> {
		return((await this.#run(stagedLastFrom, [moment, count])).map(stagedOf));
	}

	async remove(keys: readonly string[]): Promise<StagedCounts> {
		if (keys.length === 0) {
			return(NO_STAGED);
		}
		return(countsOf(await this.#run(removeStaged, [keys.map(keyBytes)])));
	}

	async counts(): Promise<StagedCounts> {
		return(countsOf(await this.#run(countStaged, [])));
	}
}
