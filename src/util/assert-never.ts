/**
 * Ends an exhaustive branch chain: it only type-checks when every member of a
 * union has been handled, and fails loudly if an unexpected value arrives anyway.
 */
export function assertNever(value: never): never {
	throw(new Error(`unexpected value: ${String(value)}`));
}
