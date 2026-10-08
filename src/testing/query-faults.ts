import pg from 'pg';

/** A query as a connection of the pool is asked to run it: a prepared statement by name, or SQL text, and its parameters. */
export type IssuedQuery = { readonly name: string | undefined; readonly text: string; readonly values: readonly unknown[] };

const issuedQueryOf = function(config: unknown, parameters: unknown): IssuedQuery {
	if (typeof config === 'string') {
		return({ name: undefined, text: config, values: valuesOf(parameters) });
	}
	if (typeof config !== 'object' || config === null) {
		throw(new Error('the query is neither text nor a query config'));
	}
	const name: unknown = Reflect.get(config, 'name');
	const text: unknown = Reflect.get(config, 'text');
	if (typeof text !== 'string' || (name !== undefined && typeof name !== 'string')) {
		throw(new Error('the query config has no text, or a name that is not a string'));
	}
	return({ name, text, values: valuesOf(Reflect.get(config, 'values') ?? parameters) });
};

function valuesOf(parameters: unknown): readonly unknown[] {
	if (Array.isArray(parameters)) {
		return(parameters);
	}
	return([]);
}

/** Hands every query that the pool's connections run to the interceptor, which runs it by calling run, or fails it. */
export const interceptQueries = function(pool: pg.Pool, intercept: (issued: IssuedQuery, run: () => Promise<unknown>) => Promise<unknown>): void {
	const wrapped = new WeakSet<pg.PoolClient>();
	pool.on('acquire', function(client) {
		if (wrapped.has(client)) {
			return;
		}
		wrapped.add(client);
		const query: unknown = Reflect.get(client, 'query');
		if (typeof query !== 'function') {
			throw(new Error('the client has no query method'));
		}
		Reflect.set(client, 'query', function(...input: unknown[]): Promise<unknown> {
			return(intercept(issuedQueryOf(input[0], input[1]), function(): Promise<unknown> {
				return(Promise.resolve(Reflect.apply(query, client, input)));
			}));
		});
	});
};

/** An error as the server reports one, with its SQLSTATE. */
export const serverError = function(code: string, message: string): pg.DatabaseError {
	const error = new pg.DatabaseError(message, 0, 'error');
	error.code = code;
	return(error);
};
