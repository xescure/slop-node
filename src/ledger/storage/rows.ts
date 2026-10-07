import type { Permissions } from '@keetanetwork/keetanet-client/lib/permissions.js';
import type { LedgerInternals } from '../../upstream/internals.js';

type UpstreamAccountInfoRow = NonNullable<Parameters<InstanceType<typeof LedgerInternals.LedgerStorageBase>['_formatAccountInfoFromRow']>[1]>;

/** Stored account info, in the row shape upstream's formatter reads. */
export type AccountInfoRow = {
	readonly name?: string;
	readonly description?: string;
	readonly metadata?: string;
	readonly supply?: bigint;
	readonly multisigQuorum?: bigint;
	readonly defaultBasePermission?: Permissions['base'];
	readonly defaultExternalPermission?: Permissions['external'];
};

type AssertExtends<Narrow extends Wide, Wide> = Narrow;
// Fails to compile if a stored row stops being something the formatter accepts.
type _AccountInfoRowFitsFormatter = AssertExtends<AccountInfoRow, UpstreamAccountInfoRow>;
