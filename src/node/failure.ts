import { assertNever } from '../util/assert-never.js';
import { MigrationError } from '../ledger/storage/postgres/migrations.js';
import type { Environment } from './config.js';

/** A failure of the node's surroundings, as opposed to a bug: the operator can fix it. */
export type OperationalFailure =
	| { readonly kind: 'postgres-unreachable'; readonly address: string | undefined; readonly port: number | undefined }
	| { readonly kind: 'port-in-use'; readonly port: number }
	| { readonly kind: 'migration'; readonly error: MigrationError };

/** Errors nest this deep at most: a ledger error wraps the driver's, which wraps the system's. */
const MAXIMUM_CAUSE_DEPTH = 8;

/** Codes of the system errors that say a server cannot be reached. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

/** What pg-pool raises when a server accepts no connection within the timeout. */
const CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

const DEFAULT_POSTGRES_PORT = '5432';

function causesOf(error: unknown): unknown[] {
	const causes: unknown[] = [];
	let current = error;
	while (causes.length < MAXIMUM_CAUSE_DEPTH && current !== undefined) {
		causes.push(current);
		if (!(current instanceof Error)) {
			break;
		}
		current = current.cause;
	}
	return(causes);
}

function codeOf(error: unknown): string | undefined {
	if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
		return(error.code);
	}
	return(undefined);
}

function numberOf(error: unknown, property: 'port'): number | undefined {
	if (error instanceof Error && property in error && typeof error[property] === 'number') {
		return(error[property]);
	}
	return(undefined);
}

function addressOf(error: unknown): string | undefined {
	if (error instanceof Error && 'address' in error && typeof error.address === 'string') {
		return(error.address);
	}
	return(undefined);
}

function isUnreachable(error: unknown): boolean {
	const code = codeOf(error);
	if (code !== undefined && UNREACHABLE_CODES.has(code)) {
		return(true);
	}
	return(error instanceof Error && error.message === CONNECT_TIMEOUT_MESSAGE);
}

/** The first of the error and its causes that the operator can act on. */
export function operationalFailureOf(error: unknown): OperationalFailure | undefined {
	for (const cause of causesOf(error)) {
		if (cause instanceof MigrationError) {
			return({ kind: 'migration', error: cause });
		}
		const port = numberOf(cause, 'port');
		if (codeOf(cause) === 'EADDRINUSE' && port !== undefined) {
			return({ kind: 'port-in-use', port });
		}
		if (isUnreachable(cause)) {
			return({ kind: 'postgres-unreachable', address: addressOf(cause), port });
		}
	}
	return(undefined);
}

/** The host and port the connection string names, without its user or password. */
function postgresEndpointOf(environment: Environment): string | undefined {
	const text = environment['KEETANET_LOCAL_NODE_POSTGRES_URL'];
	if (text === undefined) {
		return(undefined);
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return(undefined);
	}
	if (url.hostname === '') {
		return(undefined);
	}
	let port = url.port;
	if (port === '') {
		port = DEFAULT_POSTGRES_PORT;
	}
	return(`${decodeURIComponent(url.hostname)}:${port}`);
}

/** One line, naming nothing secret: the connection string's password is never repeated. */
export function describeOperationalFailure(failure: OperationalFailure, environment: Environment): string {
	switch (failure.kind) {
		case 'postgres-unreachable': {
			const endpoint = postgresEndpointOf(environment) ?? `${failure.address ?? 'an unknown host'}:${String(failure.port ?? DEFAULT_POSTGRES_PORT)}`;
			return(`cannot reach Postgres at ${endpoint}`);
		}
		case 'port-in-use':
			return(`port ${String(failure.port)} in use`);
		case 'migration':
			return(failure.error.message);
		default:
			return(assertNever(failure));
	}
}
