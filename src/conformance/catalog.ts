/*
 * The catalog of vote decisions the corpus covers, row by row, as IDs. A row
 * that combines several situations, such as "C1/C3", names each of them; the
 * corpus gives each its own case. The write-mode rows and the evaluation
 * order carry no IDs in the catalog, so their cases are declared as extras.
 */

export const CATALOG_ROWS = [
	// Kind selection and the recovery vote
	['V1'], ['V2'], ['V3'], ['V3b'], ['V3c'], ['V4'], ['V4b'], ['V5'], ['V6'], ['V6b'], ['V6c'],
	['P1'], ['P2'], ['P3'], ['P4'], ['P5'], ['P6'], ['P7'], ['P8'], ['P9'], ['P9c'],
	// Quorum; the Q15 row also names Q16, the delegation that is voted on but never added
	['Q1'], ['Q2'], ['Q3'], ['Q3b'], ['Q6'], ['Q7'], ['Q8'], ['Q9'], ['Q5'], ['Q10'], ['Q11'], ['Q12'], ['Q13'], ['Q14'], ['Q15', 'Q16'],
	// Clock window
	['C1', 'C3'], ['C2', 'C4'], ['C6'], ['C5'], ['C7'], ['C8'], ['C9'], ['C10'], ['C11'], ['CE5'],
	// Conflicts
	['K1'], ['K1b'], ['K1c'], ['K1d'], ['K1f'], ['K2'], ['K3'], ['K1e', 'K8'], ['K4'], ['K5'], ['K5b'], ['K6'], ['K6b'], ['K6c'], ['K7'],
	// Balances and supply
	['B1', 'B2'], ['B3'], ['B4'], ['B5'], ['B6'], ['B6b'], ['B7'], ['B8'], ['T5'], ['T6', 'T7'],
	// Permissions
	['PM1'], ['PM2'], ['PM3'], ['PM4'], ['PM5'], ['PM6'], ['S4'], ['S2', 'S3', 'S3b'], ['T1'], ['T2', 'T3', 'T4'], ['T8', 'T10'], ['SI3'],
	['MS1', 'MS2', 'MS3', 'MS4'], ['O1', 'O2', 'O3', 'O4'], ['CE3'], ['CE4'], ['OP1', 'OP2'], ['OP3', 'OP4'], ['TR1', 'TR2'], ['R1', 'R2'],
	// Fees
	['F0'], ['F1'], ['F2'], ['F3'], ['F4', 'F4b'], ['F5a', 'F5b'], ['F5c'], ['F6'], ['F7'], ['F8'], ['F9', 'F9b'], ['F10'], ['E3'], ['F11', 'F12'], ['F13'], ['QT1'],
	// Network, subnet and idempotent keys
	['N1', 'N6'], ['N2'], ['N3', 'N5'], ['N4'], ['I1'], ['I2'], ['I3'], ['I3b'], ['I4'], ['I5'], ['I6']
] as const;

export type CatalogID = (typeof CATALOG_ROWS)[number][number];

/**
 * A case the catalog does not number: a further outcome or neighbor of the
 * row it extends, a storage-contract variant of one, or, with no row, a case
 * that pins the evaluation order or a write mode.
 */
export type CorpusExtra = {
	readonly id: string;
	readonly row: CatalogID | null;
};

export const CORPUS_EXTRAS: readonly CorpusExtra[] = [
	// Evaluation order: each puts two failing conditions in one request
	{ id: 'EO1', row: null }, { id: 'EO2', row: null }, { id: 'EO3', row: null }, { id: 'EO4', row: null }, { id: 'EO5', row: null }, { id: 'EO6', row: null }, { id: 'EO7', row: null }, { id: 'EO8', row: null },
	{ id: 'EO9', row: null }, { id: 'EO10', row: null }, { id: 'EO11', row: null }, { id: 'EO12', row: null }, { id: 'EO13', row: null }, { id: 'EO14', row: null }, { id: 'EO15', row: null }, { id: 'EO16', row: null },
	{ id: 'EO17', row: null }, { id: 'EO18', row: null }, { id: 'EO19', row: null }, { id: 'EO20', row: null }, { id: 'EO21', row: null }, { id: 'EO22', row: null }, { id: 'EO23', row: null }, { id: 'EO24', row: null },
	{ id: 'EO25', row: null }, { id: 'EO26', row: null }, { id: 'EO27', row: null }, { id: 'EO28', row: null }, { id: 'EO29', row: null }, { id: 'EO30', row: null }, { id: 'EO31', row: null },
	// Write modes, one per mode and one for a node without a key
	{ id: 'W1', row: null }, { id: 'W2', row: null }, { id: 'W3', row: null }, { id: 'W4', row: null }, { id: 'W5', row: null },
	// Storage-contract variants
	{ id: 'C11-D4', row: 'C11' }, { id: 'I3-D12', row: 'I3' }, { id: 'I3c-D12', row: 'I3' },
	// Further outcomes and neighbors of catalog rows
	{ id: 'B6c', row: 'B6' },
	{ id: 'PM2b', row: 'PM2' }, { id: 'PM4b', row: 'PM4' },
	{ id: 'S2b', row: 'S2' }, { id: 'S2c', row: 'S2' },
	{ id: 'T3b', row: 'T3' }, { id: 'T10b', row: 'T10' },
	{ id: 'CE3b', row: 'CE3' },
	{ id: 'F7b', row: 'F7' },
	{ id: 'F9c', row: 'F9b' }, { id: 'F9d', row: 'F9b' }, { id: 'F9e', row: 'F9' }, { id: 'F9f', row: 'F9' },
	{ id: 'F10b', row: 'F10' },
	{ id: 'E3b', row: 'E3' }, { id: 'E3c', row: 'E3' },
	{ id: 'QT1b', row: 'QT1' }, { id: 'QT1c', row: 'QT1' },
	{ id: 'N2b', row: 'N2' }
];

/**
 * IDs that the catalog's cross-reference to Keeta's own test suites
 * (client/client_common_tests.d.ts) cites, but that name no row and so no
 * situation: there is nothing for a case or an exclusion to answer.
 */
export const CITED_WITHOUT_ROWS: readonly string[] = ['T9', 'S1', 'MS5'];
