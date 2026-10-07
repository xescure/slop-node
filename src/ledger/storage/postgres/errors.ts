import type { KeetaNetLedgerError } from '@keetanetwork/keetanet-client/lib/error/ledger.js';
import pg from 'pg';
import { createLedgerError, describeError } from '../errors.js';

/** An error a query raised, as Ledger.run should see it. */
export type MappedDatabaseError =
	| { readonly kind: 'conflict'; readonly error: KeetaNetLedgerError }
	| { readonly kind: 'other'; readonly error: unknown };

/**
 * The statement that failed: COMMIT, or one before it. connectionLost says
 * whether pg had already reported the transaction's connection lost.
 */
export type FailedStatement =
	| { readonly kind: 'commit' }
	| { readonly kind: 'before-commit'; readonly connectionLost: boolean };

const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';
const UNIQUE_VIOLATION = '23505';

// The server ending the session while a statement runs: an administrator's or a shutdown's termination, or the idle-in-transaction timeout.
const SESSION_TERMINATED = ['57P01', '57P02', '25P03'] as const;
const CONNECTION_EXCEPTION_CLASS = '08';

/*
 * The unique constraints two processes of one node can race to: the same
 * staple, block or vote arriving through both, two blocks claiming one
 * previous, or two blocks one idempotent key. Account interning cannot race
 * here: its insert skips existing rows, and under SERIALIZABLE a row it
 * cannot see yet fails with 40001 instead. A unique violation anywhere else
 * is a bug, and retrying it would only repeat it.
 */
const RACED_CONSTRAINTS = ['staples_pkey', 'blocks_pkey', 'blocks_main_successor', 'votes_main', 'votes_side', 'idempotent_keys_main'] as const;

type RacedConstraint = typeof RACED_CONSTRAINTS[number];

const isRacedConstraint = function(constraint: string | undefined): constraint is RacedConstraint {
	return(RACED_CONSTRAINTS.some(function(raced): boolean {
		return(raced === constraint);
	}));
};

const isSessionLoss = function(error: unknown): boolean {
	if (!(error instanceof pg.DatabaseError) || error.code === undefined) {
		return(false);
	}
	const { code } = error;
	return(code.startsWith(CONNECTION_EXCEPTION_CLASS) || SESSION_TERMINATED.some(function(terminated): boolean {
		return(terminated === code);
	}));
};

const conflictWith = function(error: unknown, reason: string): MappedDatabaseError {
	const conflict = createLedgerError('LEDGER_TRANSACTION_ABORTED', `${reason}: ${describeError(error)}`, { retry: true });
	conflict.cause = error;
	return({ kind: 'conflict', error: conflict });
};

/**
 * A conflict with a concurrent transaction becomes a retryable
 * LEDGER_TRANSACTION_ABORTED: the database rolled the statement back, and a
 * new attempt reads the winner's writes. So does a connection lost before
 * COMMIT was sent: the server rolls back the transaction of a session that
 * ends, so nothing of the attempt can have committed. Every other error is
 * returned unchanged, and evaluateError makes it a non-retryable
 * LEDGER_OTHER. That includes a connection lost during COMMIT, after which
 * nobody knows whether the transaction committed.
 */
export function mapDatabaseError(error: unknown, statement: FailedStatement): MappedDatabaseError {
	if (statement.kind === 'before-commit' && (statement.connectionLost || isSessionLoss(error))) {
		return(conflictWith(error, 'connection lost before commit'));
	}
	if (!(error instanceof pg.DatabaseError)) {
		return({ kind: 'other', error });
	}
	switch (error.code) {
		case SERIALIZATION_FAILURE:
			return(conflictWith(error, 'serialization failure with a concurrent transaction'));
		case DEADLOCK_DETECTED:
			return(conflictWith(error, 'deadlock with a concurrent transaction'));
		case UNIQUE_VIOLATION:
			if (isRacedConstraint(error.constraint)) {
				return(conflictWith(error, `concurrent insert violating ${error.constraint}`));
			}
			return({ kind: 'other', error });
		default:
			return({ kind: 'other', error });
	}
}
