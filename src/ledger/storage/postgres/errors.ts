import type { KeetaNetLedgerError } from '@keetanetwork/keetanet-client/lib/error/ledger.js';
import pg from 'pg';
import { createLedgerError, describeError } from '../errors.js';

/** An error a query raised, as Ledger.run should see it. */
export type MappedDatabaseError =
	| { readonly kind: 'conflict'; readonly error: KeetaNetLedgerError }
	| { readonly kind: 'other'; readonly error: unknown };

const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';
const UNIQUE_VIOLATION = '23505';

/*
 * The tables where two processes of one node can insert the same row at once:
 * the same staple, block, vote or idempotent key arriving through both, or one
 * account interned by both. A unique violation anywhere else is a bug, and
 * retrying it would only repeat it.
 */
const CONCURRENTLY_INSERTED_TABLES: ReadonlySet<string> = new Set(['staples', 'blocks', 'votes', 'idempotent_keys', 'accounts']);

const conflictWith = function(error: pg.DatabaseError, reason: string): MappedDatabaseError {
	const conflict = createLedgerError('LEDGER_TRANSACTION_ABORTED', `${reason}: ${describeError(error)}`, { retry: true });
	conflict.cause = error;
	return({ kind: 'conflict', error: conflict });
};

/**
 * A conflict with a concurrent transaction becomes a retryable
 * LEDGER_TRANSACTION_ABORTED: the database rolled the statement back, and a
 * new attempt reads the winner's writes. Every other error is returned
 * unchanged, and evaluateError makes it a non-retryable LEDGER_OTHER. That
 * includes a connection lost during COMMIT, after which nobody knows whether
 * the transaction committed.
 */
export function mapDatabaseError(error: unknown): MappedDatabaseError {
	if (!(error instanceof pg.DatabaseError)) {
		return({ kind: 'other', error });
	}
	switch (error.code) {
		case SERIALIZATION_FAILURE:
			return(conflictWith(error, 'serialization failure with a concurrent transaction'));
		case DEADLOCK_DETECTED:
			return(conflictWith(error, 'deadlock with a concurrent transaction'));
		case UNIQUE_VIOLATION:
			if (error.table !== undefined && CONCURRENTLY_INSERTED_TABLES.has(error.table)) {
				return(conflictWith(error, `concurrent insert into ${error.table}`));
			}
			return({ kind: 'other', error });
		default:
			return({ kind: 'other', error });
	}
}
