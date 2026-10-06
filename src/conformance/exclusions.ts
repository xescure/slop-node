import type { CatalogID } from './catalog.js';

/*
 * Catalog rows, or halves of rows, that no case can carry. A node only ever
 * parses the blocks a client sends, and parsing runs the same validation as
 * building: the block constructor checks every operation, the purpose and
 * the idempotent key, whether its input is JSON or bytes.
 * [Keeta TS] index.js:63826-63827, 63985-64000, 64046-64051
 * So a block the builder refuses reaches a node only as bytes encoded and
 * signed by hand, and its outcome is a parse-time rejection that says
 * nothing about the ledger. A case that shares an ID with an entry here
 * carries the other half of the row.
 */

/**
 * A catalog row, by its catalog ID, and why the public API cannot reach it:
 * the whole row, or a part of it whose other part a case of the same ID
 * carries.
 */
export type ExcludedRow = {
	readonly id: CatalogID;
	readonly extent: 'row' | 'part';
	readonly reason: string;
};

export const EXCLUDED_ROWS: readonly ExcludedRow[] = [
	{
		id: 'B8',
		extent: 'part',
		reason: 'The construction half: a SEND of a negative amount dated from 2025-11-21 on is refused with BLOCK_AMOUNT_BELOW_ZERO by the block builder and by the block parser alike ([Keeta TS] index.js:67139-67148), so only hand-encoded bytes would reach the parse-time rejection. Case B8 records the ledger\'s own refusal of a negative amount dated before that cutoff.'
	},
	{
		id: 'T6',
		extent: 'part',
		reason: 'The construction half: one TOKEN_ADMIN_SUPPLY of 10^200, above the maximum supply, is refused with BLOCK_SUPPLY_INVALID by the block builder and by the block parser alike ([Keeta TS] index.js:67133-67138), so only hand-encoded bytes would reach the parse-time rejection. Case T6 records the same code raised by the ledger for a supply that grows past the maximum across blocks.'
	},
	{
		id: 'I5',
		extent: 'part',
		reason: 'The 37-byte half: an idempotent key longer than 36 bytes is refused with BLOCK_INVALID_IDEMPOTENT_LENGTH by the block builder and by the block parser alike ([Keeta TS] index.js:63362-63367, 64046-64051), so only hand-encoded bytes would reach the parse-time rejection. Case I5 records a key of exactly 36 bytes.'
	},
	{
		id: 'F8',
		extent: 'row',
		reason: 'A fee block with an operation other than SEND is refused with BLOCK_INVALID_PURPOSE_VALIDATION by the block builder and by the block parser alike ([Keeta TS] index.js:63993-63996), so only hand-encoded bytes would reach the parse-time rejection; the ledger never sees such a block.'
	}
];
