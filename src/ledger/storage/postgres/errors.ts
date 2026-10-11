import type { KeetaNetLedgerError } from '@keetanetwork/keetanet-client/lib/error/ledger.js';
import pg from 'pg';
import { createLedgerError } from '../errors.js';

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
 * The server refusing a message it could not read. As an ERROR it refuses
 * only that message, such as a bind with the wrong number of parameters, and
 * the session goes on, so a new attempt would send the same message; only as
 * a FATAL does it end the session. pg reads only the severity as the server
 * words it in its lc_messages, field S, and never V, which the server leaves
 * in English (pg-protocol 1.16.1 parser.js:307), so under another language a
 * FATAL one is passed through, as an ERROR one is, rather than retried.
 */
const PROTOCOL_VIOLATION = '08P01';

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
	if (code === PROTOCOL_VIOLATION) {
		return(error.severity === 'FATAL');
	}
	return(code.startsWith(CONNECTION_EXCEPTION_CLASS) || SESSION_TERMINATED.some(function(terminated): boolean {
		return(terminated === code);
	}));
};

/** What pg-pool raises when no connection could be checked out within its connection timeout. */
export const POOL_CHECKOUT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

// The server refusing sessions while it starts up, shuts down or recovers.
const CANNOT_CONNECT_NOW = '57P03';

/** How pg words a connection that ended before or while it was being opened. */
const CONNECTION_TERMINATED_PREFIX = 'Connection terminated';

/** System errors of a server that is restarting or a network that dropped the connection, as opposed to a wrong address. */
const TRANSIENT_SYSTEM_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

/**
 * Whether checking a connection out failed for a reason that may pass: the
 * pool's checkout timeout, or a server that refused or dropped the new
 * connection. No statement of the attempt reached the server, so nothing of
 * it can have committed. A refusal that stays, such as a wrong password or
 * a missing database, is not transient.
 */
export function isTransientCheckoutError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return(false);
	}
	if (error.message === POOL_CHECKOUT_TIMEOUT_MESSAGE || error.message.startsWith(CONNECTION_TERMINATED_PREFIX)) {
		return(true);
	}
	if (error instanceof pg.DatabaseError) {
		return(error.code === CANNOT_CONNECT_NOW || isSessionLoss(error));
	}
	return('code' in error && typeof error.code === 'string' && TRANSIENT_SYSTEM_CODES.has(error.code));
}

/**
 * Whether the statement failed in a way that committed nothing, so that the
 * same work may simply be attempted again: a conflict with a concurrent
 * transaction, which the database rolled back, or a connection lost before
 * COMMIT was sent, since the server rolls back the transaction of a session
 * that ends. A connection lost during COMMIT is not: nobody knows whether
 * the transaction committed.
 */
export function isTransientDatabaseError(error: unknown, statement: FailedStatement): boolean {
	if (statement.kind === 'before-commit' && (statement.connectionLost || isSessionLoss(error))) {
		return(true);
	}
	if (!(error instanceof pg.DatabaseError)) {
		return(false);
	}
	return(error.code === SERIALIZATION_FAILURE || error.code === DEADLOCK_DETECTED);
}

/**
 * Ledger.run rethrows the last conflict once its retries run out, and the API
 * answers a ledger error as a refusal with its message. The database's text
 * names hosts, tables and constraints, so it stays in the cause.
 */
export const CONFLICT_MESSAGE = 'The transaction was aborted before it committed';

const conflictWith = function(error: unknown): MappedDatabaseError {
	const conflict = createLedgerError('LEDGER_TRANSACTION_ABORTED', CONFLICT_MESSAGE, { retry: true });
	conflict.cause = error;
	return({ kind: 'conflict', error: conflict });
};

/**
 * A transient failure becomes a retryable LEDGER_TRANSACTION_ABORTED, and so
 * does a unique violation of a constraint two processes race to: a new
 * attempt reads the winner's writes. Every other error is returned
 * unchanged, and evaluateError makes it a non-retryable LEDGER_OTHER.
 */
export function mapDatabaseError(error: unknown, statement: FailedStatement): MappedDatabaseError {
	if (isTransientDatabaseError(error, statement)) {
		return(conflictWith(error));
	}
	if (error instanceof pg.DatabaseError && error.code === UNIQUE_VIOLATION && isRacedConstraint(error.constraint)) {
		return(conflictWith(error));
	}
	return({ kind: 'other', error });
}
