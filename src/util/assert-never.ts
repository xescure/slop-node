/**
 * Ends an exhaustive branch chain: it only type-checks when every member of a
 * union has been handled, and fails loudly if an unexpected value arrives anyway.
 */
export function assertNever(value: never): never {
	throw(new Error(`unexpected value: ${String(value)}`));
}

/** Type-checks only when the type is never: each member of a union it is given names a mismatch. */
export type AssertNever<T extends never> = T;
