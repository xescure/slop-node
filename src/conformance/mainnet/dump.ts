import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { ACLRow, AccountInfo, CertificateWithIntermediates } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { Permissions } from '@keetanetwork/keetanet-client/lib/permissions.js';
import { assertNever } from '../../util/assert-never.js';
import { compareText } from './replay.js';
import type { ReplayResult } from './replay.js';

const lib = KeetaNet.lib;

export const STATE_DUMP_FORMAT = 'slop-node/state-dump@1';

type LedgerReader = Parameters<Parameters<Ledger['runReadOnly']>[1]>[0];

type PublicKeyText = `keeta_${string}`;
type DecimalText = string & { readonly __decimalText: never };
type HashText = string & { readonly __hashText: never };
type Base64Text = string & { readonly __base64Text: never };

type PermissionBits = {
	readonly base: DecimalText;
	readonly external: DecimalText;
};

type AccountRecordFields = {
	readonly kind: 'account';
	readonly account: PublicKeyText;
	readonly name: string;
	readonly description: string;
	readonly metadata: string;
	readonly representative: PublicKeyText | null;
};

type IdentifierFields = {
	readonly defaultPermission: PermissionBits | null;
};

type MultisigFields = IdentifierFields & {
	readonly multisigQuorum: DecimalText | null;
};

type AccountRecord = AccountRecordFields | (AccountRecordFields & IdentifierFields) | (AccountRecordFields & MultisigFields);

type ACLGrantFields = {
	readonly entity: PublicKeyText;
	readonly target: PublicKeyText;
	readonly base: DecimalText;
	readonly external: DecimalText;
};

type ACLRecord =
	({ readonly kind: 'acl'; readonly principalType: 'ACCOUNT'; readonly principal: PublicKeyText } & ACLGrantFields) |
	({ readonly kind: 'acl'; readonly principalType: 'CERTIFICATE'; readonly principal: PublicKeyText; readonly certificate: HashText } & ACLGrantFields);

type BalanceRecord = { readonly kind: 'balance'; readonly account: PublicKeyText; readonly token: PublicKeyText; readonly amount: DecimalText };
type CertificateRecord = { readonly kind: 'certificate'; readonly account: PublicKeyText; readonly hash: HashText; readonly certificate: Base64Text; readonly intermediates: readonly Base64Text[] | null };
type ChecksumRecord = { readonly kind: 'checksum'; readonly ledgerChecksum: HashText };
type HeadRecord = { readonly kind: 'head'; readonly account: PublicKeyText; readonly height: DecimalText; readonly block: HashText };
type SupplyRecord = { readonly kind: 'supply'; readonly token: PublicKeyText; readonly amount: DecimalText };
type WeightRecord = { readonly kind: 'weight'; readonly representative: PublicKeyText; readonly weight: DecimalText };

/*
 * Each record's fields are written in the order its type lists them, kind and
 * key fields first, which is what makes the byte order of the lines the order
 * by kind and key.
 */
export type StateDumpRecord = AccountRecord | ACLRecord | BalanceRecord | CertificateRecord | ChecksumRecord | HeadRecord | SupplyRecord | WeightRecord;

export type StateDumpKind = StateDumpRecord['kind'];

const CHECKSUM_BITS = 256n;

function isPublicKeyText(text: string): text is PublicKeyText {
	return(text.startsWith('keeta_'));
}

function publicKeyText(account: GenericAccount): PublicKeyText {
	const text = account.publicKeyString.get();
	if (!isPublicKeyText(text)) {
		throw(new Error(`not a public key string: ${text}`));
	}
	return(text);
}

function decimalText(value: bigint): DecimalText {
	if (value < 0n) {
		throw(new Error(`a dumped quantity is negative: ${value.toString()}`));
	}
	// The brand marks the decimal of a non-negative integer, which has no leading zeros.
	return(value.toString() as DecimalText);
}

function isHashText(text: string): text is HashText {
	return(/^[0-9A-F]{64}$/u.test(text));
}

function hashText(hash: { toString(): string }): HashText {
	const text = hash.toString();
	if (!isHashText(text)) {
		throw(new Error(`not a 32-byte hash in uppercase hex: ${text}`));
	}
	return(text);
}

function base64Text(bytes: ArrayBuffer): Base64Text {
	// The brand marks the canonical, padded base64 that Buffer writes.
	return(Buffer.from(bytes).toString('base64') as Base64Text);
}

function permissionBits(permissions: Permissions | undefined): PermissionBits | null {
	if (permissions === undefined) {
		return(null);
	}
	return({ base: decimalText(permissions.base.bigint), external: decimalText(permissions.external.bigint) });
}

function accountFields(account: GenericAccount, info: AccountInfo, representative: Account | null): AccountRecordFields {
	let representativeText: PublicKeyText | null = null;
	if (representative !== null) {
		representativeText = publicKeyText(representative);
	}
	return({
		kind: 'account',
		account: publicKeyText(account),
		name: info.name,
		description: info.description,
		metadata: info.metadata,
		representative: representativeText
	});
}

/** Which info fields an account has follows from its key type: identifiers carry default permissions, a token its supply, a multisig its quorum. */
async function accountRecords(reader: LedgerReader, account: GenericAccount, representative: Account | null): Promise<StateDumpRecord[]> {
	if (account.isToken()) {
		const info = await reader.getAccountInfo(account);
		return([
			{ ...accountFields(account, info, representative), defaultPermission: permissionBits(info.defaultPermission) },
			{ kind: 'supply', token: publicKeyText(account), amount: decimalText(info.supply) }
		]);
	}
	if (account.isMultisig()) {
		const info = await reader.getAccountInfo(account);
		let multisigQuorum: DecimalText | null = null;
		if (info.multisigQuorum !== null) {
			multisigQuorum = decimalText(info.multisigQuorum);
		}
		return([{ ...accountFields(account, info, representative), defaultPermission: permissionBits(info.defaultPermission), multisigQuorum }]);
	}
	if (account.isIdentifier()) {
		const info = await reader.getAccountInfo(account);
		return([{ ...accountFields(account, info, representative), defaultPermission: permissionBits(info.defaultPermission) }]);
	}
	return([accountFields(account, await reader.getAccountInfo(account), representative)]);
}

function aclRecord(row: ACLRow): ACLRecord {
	const grant: ACLGrantFields = {
		entity: publicKeyText(row.entity),
		target: publicKeyText(row.target),
		base: decimalText(row.permissions.base.bigint),
		external: decimalText(row.permissions.external.bigint)
	};
	switch (row.principalType) {
		case 'ACCOUNT':
			return({ kind: 'acl', principalType: 'ACCOUNT', principal: publicKeyText(row.principal), ...grant });
		case 'CERTIFICATE':
			return({ kind: 'acl', principalType: 'CERTIFICATE', principal: publicKeyText(row.principal.certificateAccount), certificate: hashText(row.principal.certificate), ...grant });
		default:
			return(assertNever(row));
	}
}

function certificateRecord(account: GenericAccount, entry: CertificateWithIntermediates): CertificateRecord {
	let intermediates: Base64Text[] | null = null;
	if (entry.intermediates !== null) {
		intermediates = entry.intermediates.getCertificates().map(function(certificate): Base64Text {
			return(base64Text(certificate.toDER()));
		});
	}
	return({
		kind: 'certificate',
		account: publicKeyText(account),
		hash: hashText(entry.certificate.hash()),
		certificate: base64Text(entry.certificate.toDER()),
		intermediates
	});
}

/** The checksum is a 256-bit XOR of block hashes, so it is written the way a hash is. */
function checksumRecord(ledgerChecksum: bigint): ChecksumRecord {
	if (ledgerChecksum < 0n || ledgerChecksum >= 1n << CHECKSUM_BITS) {
		throw(new Error(`a ledger checksum is ${CHECKSUM_BITS.toString()} bits: ${ledgerChecksum.toString(16)}`));
	}
	return({ kind: 'checksum', ledgerChecksum: hashText(ledgerChecksum.toString(16).toUpperCase().padStart(Number(CHECKSUM_BITS / 4n), '0')) });
}

async function headRecords(reader: LedgerReader, accounts: readonly GenericAccount[]): Promise<HeadRecord[]> {
	const heads = await reader.getAccountsBlockHeightInfo(accounts.map(function(account) {
		return({ account });
	}));
	const records: HeadRecord[] = [];
	for (const account of accounts) {
		const head = heads[account.publicKeyString.get()];
		if (head === undefined || head === null) {
			continue;
		}
		if (head.height === null) {
			throw(new Error(`the head of ${account.publicKeyString.get()} has no height`));
		}
		records.push({ kind: 'head', account: publicKeyText(account), height: decimalText(head.height), block: hashText(head.blockHash) });
	}
	return(records);
}

/*
 * Every read goes through the ledger's own transaction interface, which reads
 * the main ledger, so any storage driver yields the same records. ACL rows are
 * listed from both sides, so a row whose entity lies outside the set is still
 * found through its principal.
 */
async function readRecords(reader: LedgerReader, accounts: readonly GenericAccount[]): Promise<StateDumpRecord[]> {
	const records: StateDumpRecord[] = [];
	const representatives = new Map<PublicKeyText, Account>();
	for (const account of accounts) {
		const representative = await reader.getAccountRep(account);
		if (representative !== null) {
			representatives.set(publicKeyText(representative), representative);
		}
		records.push(...await accountRecords(reader, account, representative));
		for (const { token, balance } of await reader.getAllBalances(account)) {
			records.push({ kind: 'balance', account: publicKeyText(account), token: publicKeyText(token), amount: decimalText(balance) });
		}
		for (const row of [...await reader.listACLsByEntity(account), ...await reader.listACLsByPrincipal(account)]) {
			records.push(aclRecord(row));
		}
		for (const entry of await reader.getAccountCertificates(account)) {
			records.push(certificateRecord(account, entry));
		}
	}
	records.push(...await headRecords(reader, accounts));
	for (const [key, representative] of representatives) {
		records.push({ kind: 'weight', representative: key, weight: decimalText(await reader.votingPower(representative)) });
	}
	return(records);
}

/*
 * A dump is pure ASCII: JSON's own escapes, plus a \u escape for every UTF-16
 * code unit outside printable ASCII, so its bytes do not depend on how an
 * implementation encodes text.
 */
function renderLine(value: object): string {
	return(JSON.stringify(value).replace(/[\u007f-\uffff]/g, function(unit): string {
		return(`\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
	}));
}

/**
 * The confirmed state a ledger holds for the accounts, in format
 * slop-node/state-dump@1 (conformance/STATE-DUMP.md): the format line, then
 * one record per line in ascending byte order.
 */
export async function renderStateDump(ledger: Ledger, accounts: readonly GenericAccount[], ledgerChecksum: bigint): Promise<string> {
	const distinct = [...new lib.Account.Set(accounts)];
	const records = await ledger.runReadOnly('state-dump', function(reader) {
		return(readRecords(reader, distinct));
	});
	records.push(checksumRecord(ledgerChecksum));
	const lines = [...new Set(records.map(renderLine))].sort(compareText);
	return([renderLine({ format: STATE_DUMP_FORMAT }), ...lines].map(function(line): string {
		return(`${line}\n`);
	}).join(''));
}

/** The dumped set of a replay: every account its staples touched, the base token and the network address. */
export function renderReplayStateDump(result: ReplayResult): Promise<string> {
	return(renderStateDump(result.ledger, [...result.touched, result.baseToken, result.networkAddress], result.ledgerChecksum));
}
