import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import { operationsBlock } from '../../testing/blocks.js';
import { UnexplainedRefusal, refusalReason, renderShadowVoteExceptions } from './shadow.js';
import type { NetworkAnchors, ShadowRefusal } from './shadow.js';

const lib = KeetaNet.lib;

const NETWORK = 0x5382n;

const SEED = '9c4e1b7a2d8f3065e1a9c7b5d3f1e0a8b6c4d2e0f8a6b4c2d0e8f6a4b2c0d8e6';

const trustedRoot = lib.Account.fromSeed(SEED, 0);
const owner = lib.Account.fromSeed(SEED, 1);
const user = lib.Account.fromSeed(SEED, 2);
const delegate = lib.Account.fromSeed(SEED, 3);

const token: TokenAddress = owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);
const storage: StorageAddress = owner.generateIdentifier(lib.Account.AccountKeyAlgorithm.STORAGE, undefined, 1);

const anchors: NetworkAnchors = {
	initialTrustedAccount: trustedRoot,
	...lib.Account.generateBaseAddresses(NETWORK)
};

function key(account: GenericAccount): string {
	return(account.publicKeyString.get());
}

/** The message a ledger refuses with when the principal lacks the flags on the entity, with no target. */
function lacking(principal: GenericAccount, entity: GenericAccount, flags: string): ShadowRefusal {
	return({ code: 'LEDGER_INVALID_PERMISSIONS', message: `${key(principal)} does not have required permissions to perform action on ${key(entity)}/undefined -- needs [${flags}]/[]` });
}

function blockOf(account: GenericAccount, signer: Account, operations: Parameters<typeof operationsBlock>[0]['operations']): Promise<Block> {
	return(operationsBlock({ account, signer, previous: null, network: NETWORK, operations }));
}

function vouchedBy(issuer: Account, blocks: readonly Block[]): { readonly blocks: readonly Block[]; readonly votes: readonly { readonly issuer: Account }[] } {
	return({ blocks, votes: [{ issuer }] });
}

const representative = lib.Account.fromSeed(SEED, 4);

describe('a shadow-vote refusal is explained by its refused requirement', function() {
	test('a token that mints and sends to a storage account skips, under the early return, the hold permission the storage account must grant', async function() {
		const staple = vouchedBy(representative, [await blockOf(token, owner, [
			{ type: lib.Block.OperationType.TOKEN_ADMIN_SUPPLY, amount: 10n, method: lib.Block.AdjustMethod.ADD },
			{ type: lib.Block.OperationType.SEND, to: storage, amount: 10n, token }
		])]);

		expect(refusalReason(staple, lacking(token, storage, 'STORAGE_CAN_HOLD, ACCESS'), anchors)).toBe('self-requirement-return');
	});

	test('a token that sends its own token skips, under the early return, the access the recipient needs', async function() {
		const staple = vouchedBy(representative, [await blockOf(token, owner, [
			{ type: lib.Block.OperationType.SEND, to: user, amount: 10n, token }
		])]);

		expect(refusalReason(staple, lacking(user, token, 'ACCESS'), anchors)).toBe('self-requirement-return');
	});

	test('the hold permission is not explained when the sender is not the token, since nothing before it is a self requirement', async function() {
		const staple = vouchedBy(representative, [await blockOf(user, user, [
			{ type: lib.Block.OperationType.SEND, to: storage, amount: 10n, token }
		])]);

		expect(function() {
			return(refusalReason(staple, lacking(token, storage, 'STORAGE_CAN_HOLD, ACCESS'), anchors));
		}).toThrow(UnexplainedRefusal);
	});

	test('a grant on another entity, made by an earlier block of the staple, satisfies the requirement only under the old grant scope', async function() {
		const staple = vouchedBy(representative, [
			await blockOf(owner, owner, [
				{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, principal: delegate, method: lib.Block.AdjustMethod.SET, permissions: new lib.Permissions(['ADMIN']) }
			]),
			await blockOf(user, delegate, [
				{ type: lib.Block.OperationType.SET_REP, to: representative }
			])
		]);

		expect(refusalReason(staple, lacking(delegate, user, 'ADMIN, ACCESS'), anchors)).toBe('same-staple-grant-scope');
	});

	test('a grant that lacks the required flag explains nothing', async function() {
		const staple = vouchedBy(representative, [
			await blockOf(owner, owner, [
				{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, principal: delegate, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['UPDATE_INFO']) }
			]),
			await blockOf(user, delegate, [
				{ type: lib.Block.OperationType.SET_REP, to: representative }
			])
		]);

		expect(function() {
			return(refusalReason(staple, lacking(delegate, user, 'ADMIN, ACCESS'), anchors));
		}).toThrow(UnexplainedRefusal);
	});

	describe('the genesis staple', function() {
		async function genesisBlocks(): Promise<Block[]> {
			return([
				await blockOf(anchors.networkAddress, trustedRoot, [
					{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, principal: owner, method: lib.Block.AdjustMethod.SET, permissions: new lib.Permissions(['ADMIN']) }
				]),
				await blockOf(anchors.baseToken, owner, [
					{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, principal: trustedRoot, method: lib.Block.AdjustMethod.SET, permissions: new lib.Permissions(['OWNER']) }
				])
			]);
		}

		test('vouched for by the trusted account alone, it is no representative\'s vote', async function() {
			const staple = vouchedBy(trustedRoot, await genesisBlocks());

			expect(refusalReason(staple, lacking(owner, anchors.baseToken, 'OWNER, ACCESS'), anchors)).toBe('trusted-account-genesis');
		});

		test('voted by a representative, its refusal is unexplained', async function() {
			const staple = vouchedBy(representative, await genesisBlocks());

			expect(function() {
				return(refusalReason(staple, lacking(owner, anchors.baseToken, 'OWNER, ACCESS'), anchors));
			}).toThrow(UnexplainedRefusal);
		});
	});

	test('a message that names no requirement of the staple is unexplained', async function() {
		const staple = vouchedBy(representative, [await blockOf(token, owner, [
			{ type: lib.Block.OperationType.SEND, to: user, amount: 10n, token }
		])]);

		expect(function() {
			return(refusalReason(staple, lacking(delegate, token, 'ACCESS'), anchors));
		}).toThrow(UnexplainedRefusal);
	});

	test('a refusal for anything but permissions is unexplained', async function() {
		const staple = vouchedBy(representative, [await blockOf(token, owner, [
			{ type: lib.Block.OperationType.SEND, to: user, amount: 10n, token }
		])]);

		expect(function() {
			return(refusalReason(staple, { ...lacking(user, token, 'ACCESS'), code: 'LEDGER_INVALID_BALANCE' }, anchors));
		}).toThrow(UnexplainedRefusal);
	});
});

describe('the shadow-vote exceptions file', function() {
	test('lists each refused staple by blocks hash, in code-point order, with its reason and code', function() {
		const text = renderShadowVoteExceptions([
			{ blocksHash: 'B0', reason: 'trusted-account-genesis', code: 'LEDGER_INVALID_PERMISSIONS' },
			{ blocksHash: '0A', reason: 'self-requirement-return', code: 'LEDGER_INVALID_PERMISSIONS' }
		]);

		expect(text).toBe([
			'{',
			'  "0A": {',
			'    "reason": "self-requirement-return",',
			'    "code": "LEDGER_INVALID_PERMISSIONS"',
			'  },',
			'  "B0": {',
			'    "reason": "trusted-account-genesis",',
			'    "code": "LEDGER_INVALID_PERMISSIONS"',
			'  }',
			'}',
			''
		].join('\n'));
	});
});
