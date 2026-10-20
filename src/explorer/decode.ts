import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { AdjustMethod, Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockOperations, IdentifierCreateArguments, ModifyPermissionsPrincipal, OperationType } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import type { Permissions } from '@keetanetwork/keetanet-client/lib/permissions.js';
import type { Certificate, CertificateHash } from '@keetanetwork/keetanet-client/lib/utils/certificate.js';
import { assertNever } from '../util/assert-never.js';

const lib = KeetaNet.lib;

export type OperationTypeName =
	'SEND' | 'SET_REP' | 'SET_INFO' | 'MODIFY_PERMISSIONS' | 'CREATE_IDENTIFIER' |
	'TOKEN_ADMIN_SUPPLY' | 'TOKEN_ADMIN_MODIFY_BALANCE' | 'RECEIVE' | 'MANAGE_CERTIFICATE';

/** An account's public key string, `keeta_...`, as public_key spells it. */
export type Address = string & { readonly __address: never };

type DetailValue = string | number | boolean | null | readonly string[];

export type DecodedOperation = {
	readonly index: number;
	readonly type: OperationTypeName;
	/** The block's account. */
	readonly account: Address;
	/** The other party: SEND.to, SET_REP.to, RECEIVE.from, CREATE_IDENTIFIER.identifier, the principal of MODIFY_PERMISSIONS. */
	readonly counterparty: Address | null;
	/** What SEND, RECEIVE and TOKEN_ADMIN_MODIFY_BALANCE move; a supply change is of the block's own account. */
	readonly token: Address | null;
	readonly amount: bigint | null;
	/** Everything else, JSON-safe, with bigints as decimal strings. */
	readonly details: Readonly<Record<string, DetailValue>>;
};

export type DecodedBlock = {
	/** Upper-case hex, as BlockHash prints it. */
	readonly hash: string;
	readonly account: Address;
	readonly signer: Address;
	readonly date: Date;
	readonly version: number;
	readonly purpose: number;
	readonly operations: readonly DecodedOperation[];
};

type Named = { readonly publicKeyString: { get(): string } };

type Moved = Pick<DecodedOperation, 'counterparty' | 'token' | 'amount' | 'details'>;

type AdjustMethodName = 'ADD' | 'SUBTRACT' | 'SET';

function addressOf(account: Named): Address {
	return(account.publicKeyString.get() as Address);
}

function optionalAddressOf(account: Named | undefined): Address | null {
	if (account === undefined) {
		return(null);
	}
	return(addressOf(account));
}

function adjustMethodName(method: AdjustMethod): AdjustMethodName {
	switch (method) {
		case lib.Block.AdjustMethod.ADD:
			return('ADD');
		case lib.Block.AdjustMethod.SUBTRACT:
			return('SUBTRACT');
		case lib.Block.AdjustMethod.SET:
			return('SET');
		default:
			return(assertNever(method));
	}
}

/** The base and external bit fields as decimal strings, or null for a permission the operation leaves out. */
function permissionDetails(permissions: Permissions | null | undefined): { readonly base: string | null; readonly external: string | null } {
	if (permissions === null || permissions === undefined) {
		return({ base: null, external: null });
	}
	return({ base: permissions.base.bigint.toString(), external: permissions.external.bigint.toString() });
}

function certificateHashOf(certificateOrHash: Certificate | CertificateHash): string {
	if (lib.Utils.Certificate.CertificateHash.isInstance(certificateOrHash)) {
		return(certificateOrHash.toString());
	}
	return(certificateOrHash.hash().toString());
}

function principalOf(principal: ModifyPermissionsPrincipal): { readonly account: Address; readonly certificateHash: string | null } {
	if ('usingCertificate' in principal) {
		return({ account: addressOf(principal.certificateAccount), certificateHash: principal.certificateHash.toString() });
	}
	return({ account: addressOf(principal), certificateHash: null });
}

function multisigDetails(created: IdentifierCreateArguments | undefined): { readonly signers: readonly string[] | null; readonly quorum: string | null } {
	if (created === undefined) {
		return({ signers: null, quorum: null });
	}
	return({ signers: created.signers.map(addressOf), quorum: created.quorum.toString() });
}

// A multisig block names the multisig account that signs, ahead of the keys that sign for it.
function signerOf(signer: Block['signer']): Address {
	if (Array.isArray(signer)) {
		return(addressOf(signer[0]));
	}
	return(addressOf(signer));
}

function movedBy(operation: BlockOperations, account: Address): Moved {
	switch (operation.type) {
		case lib.Block.OperationType.SEND:
			return({
				counterparty: addressOf(operation.to),
				token: addressOf(operation.token),
				amount: operation.amount,
				details: { external: operation.external ?? null }
			});
		case lib.Block.OperationType.SET_REP:
			return({ counterparty: addressOf(operation.to), token: null, amount: null, details: {} });
		case lib.Block.OperationType.SET_INFO: {
			const defaults = permissionDetails(operation.defaultPermission);
			return({
				counterparty: null,
				token: null,
				amount: null,
				details: {
					name: operation.name,
					description: operation.description,
					metadata: operation.metadata,
					defaultBase: defaults.base,
					defaultExternal: defaults.external
				}
			});
		}
		case lib.Block.OperationType.MODIFY_PERMISSIONS: {
			const principal = principalOf(operation.principal);
			const granted = permissionDetails(operation.permissions);
			return({
				counterparty: principal.account,
				token: null,
				amount: null,
				details: {
					method: adjustMethodName(operation.method),
					certificateHash: principal.certificateHash,
					target: optionalAddressOf(operation.target),
					base: granted.base,
					external: granted.external
				}
			});
		}
		case lib.Block.OperationType.CREATE_IDENTIFIER: {
			return({ counterparty: addressOf(operation.identifier), token: null, amount: null, details: multisigDetails(operation.createArguments) });
		}
		case lib.Block.OperationType.TOKEN_ADMIN_SUPPLY:
			return({ counterparty: null, token: account, amount: operation.amount, details: { method: adjustMethodName(operation.method) } });
		case lib.Block.OperationType.TOKEN_ADMIN_MODIFY_BALANCE:
			return({
				counterparty: null,
				token: addressOf(operation.token),
				amount: operation.amount,
				details: { method: adjustMethodName(operation.method) }
			});
		case lib.Block.OperationType.RECEIVE:
			return({
				counterparty: addressOf(operation.from),
				token: addressOf(operation.token),
				amount: operation.amount,
				details: { exact: operation.exact, forward: optionalAddressOf(operation.forward) }
			});
		case lib.Block.OperationType.MANAGE_CERTIFICATE:
			return({
				counterparty: null,
				token: null,
				amount: null,
				details: { method: adjustMethodName(operation.method), certificateHash: certificateHashOf(operation.certificateOrHash) }
			});
		default:
			return(assertNever(operation));
	}
}

const OPERATION_NAMES: { readonly [Type in OperationType]: OperationTypeName } = {
	[lib.Block.OperationType.SEND]: 'SEND',
	[lib.Block.OperationType.SET_REP]: 'SET_REP',
	[lib.Block.OperationType.SET_INFO]: 'SET_INFO',
	[lib.Block.OperationType.MODIFY_PERMISSIONS]: 'MODIFY_PERMISSIONS',
	[lib.Block.OperationType.CREATE_IDENTIFIER]: 'CREATE_IDENTIFIER',
	[lib.Block.OperationType.TOKEN_ADMIN_SUPPLY]: 'TOKEN_ADMIN_SUPPLY',
	[lib.Block.OperationType.TOKEN_ADMIN_MODIFY_BALANCE]: 'TOKEN_ADMIN_MODIFY_BALANCE',
	[lib.Block.OperationType.RECEIVE]: 'RECEIVE',
	[lib.Block.OperationType.MANAGE_CERTIFICATE]: 'MANAGE_CERTIFICATE'
};

/** Reads a confirmed block's canonical bytes; bytes that are not a whole block throw. */
export function decodeBlock(bytes: Uint8Array): DecodedBlock {
	const block = new lib.Block(Buffer.from(bytes));
	const account = addressOf(block.account);
	return({
		hash: block.hash.toString(),
		account,
		signer: signerOf(block.signer),
		date: block.date,
		version: block.version,
		purpose: block.purpose,
		operations: block.operations.map(function(operation, index): DecodedOperation {
			return({ index, type: OPERATION_NAMES[operation.type], account, ...movedBy(operation, account) });
		})
	});
}

const ADDRESS_DETAILS: readonly string[] = ['signers', 'target', 'forward'];

/** Every account the block names: its own, its signer, the counterparties and tokens, and the addresses its operations carry in their details. */
export function addressesOf(block: DecodedBlock): ReadonlySet<Address> {
	const named = new Set<Address>([block.account, block.signer]);
	for (const operation of block.operations) {
		for (const address of [operation.counterparty, operation.token]) {
			if (address !== null) {
				named.add(address);
			}
		}
		for (const key of ADDRESS_DETAILS) {
			const value = operation.details[key];
			if (typeof value === 'string') {
				named.add(value as Address);
			} else if (Array.isArray(value)) {
				for (const signer of value as readonly string[]) {
					named.add(signer as Address);
				}
			}
		}
	}
	return(named);
}
