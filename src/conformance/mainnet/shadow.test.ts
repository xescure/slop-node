import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { ACLPermissionRequirement } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import { operationsBlock, sendBlock } from '../../testing/blocks.js';
import { LedgerInternals } from '../../upstream/internals.js';
import { UnexplainedRefusal, explainRefusal, renderShadowVoteExceptions, sendRequirements } from './shadow.js';
import type { LedgerRefusal, NetworkAnchors } from './shadow.js';

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
function lacking(principal: GenericAccount, entity: GenericAccount, flags: string): LedgerRefusal {
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

		expect(explainRefusal(staple, lacking(token, storage, 'STORAGE_CAN_HOLD, ACCESS'), anchors).reason).toBe('self-requirement-return');
	});

	test('a token that sends its own token skips, under the early return, the access the recipient needs', async function() {
		const staple = vouchedBy(representative, [await blockOf(token, owner, [
			{ type: lib.Block.OperationType.SEND, to: user, amount: 10n, token }
		])]);

		expect(explainRefusal(staple, lacking(user, token, 'ACCESS'), anchors).reason).toBe('self-requirement-return');
	});

	test('the hold permission is not explained when the sender is not the token, since nothing before it is a self requirement', async function() {
		const staple = vouchedBy(representative, [await blockOf(user, user, [
			{ type: lib.Block.OperationType.SEND, to: storage, amount: 10n, token }
		])]);

		expect(function() {
			return(explainRefusal(staple, lacking(token, storage, 'STORAGE_CAN_HOLD, ACCESS'), anchors));
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

		expect(explainRefusal(staple, lacking(delegate, user, 'ADMIN, ACCESS'), anchors).reason).toBe('same-staple-grant-scope');
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
			return(explainRefusal(staple, lacking(delegate, user, 'ADMIN, ACCESS'), anchors));
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

			expect(explainRefusal(staple, lacking(owner, anchors.baseToken, 'OWNER, ACCESS'), anchors).reason).toBe('trusted-account-genesis');
		});

		test('a requirement on an account other than the base token and the network address is not the genesis refusal', async function() {
			const staple = vouchedBy(trustedRoot, [
				...await genesisBlocks(),
				await blockOf(user, delegate, [
					{ type: lib.Block.OperationType.SET_REP, to: representative }
				])
			]);

			expect(function() {
				return(explainRefusal(staple, lacking(delegate, user, 'ADMIN, ACCESS'), anchors));
			}).toThrow('0 reasons explain');
		});

		test('a requirement of the trusted account itself is not the genesis refusal', async function() {
			const [networkOpening, baseTokenOpening] = await genesisBlocks();
			if (networkOpening === undefined || baseTokenOpening === undefined) {
				throw(new Error('the genesis has two blocks'));
			}
			const staple = vouchedBy(trustedRoot, [
				networkOpening,
				await operationsBlock({
					account: anchors.networkAddress,
					signer: trustedRoot,
					previous: networkOpening.hash,
					network: NETWORK,
					operations: [{ type: lib.Block.OperationType.SET_INFO, name: 'KTA', description: '', metadata: '', defaultPermission: new lib.Permissions(['ACCESS']) }]
				}),
				baseTokenOpening
			]);

			expect(function() {
				return(explainRefusal(staple, lacking(trustedRoot, anchors.networkAddress, 'UPDATE_INFO, ACCESS'), anchors));
			}).toThrow('0 reasons explain');
		});

		test('voted by a representative, its refusal is unexplained', async function() {
			const staple = vouchedBy(representative, await genesisBlocks());

			expect(function() {
				return(explainRefusal(staple, lacking(owner, anchors.baseToken, 'OWNER, ACCESS'), anchors));
			}).toThrow(UnexplainedRefusal);
		});
	});

	test('a message that names no requirement of the staple is unexplained', async function() {
		const staple = vouchedBy(representative, [await blockOf(token, owner, [
			{ type: lib.Block.OperationType.SEND, to: user, amount: 10n, token }
		])]);

		expect(function() {
			return(explainRefusal(staple, lacking(delegate, token, 'ACCESS'), anchors));
		}).toThrow(UnexplainedRefusal);
	});

	test('a refusal for anything but permissions is unexplained', async function() {
		const staple = vouchedBy(representative, [await blockOf(token, owner, [
			{ type: lib.Block.OperationType.SEND, to: user, amount: 10n, token }
		])]);

		expect(function() {
			return(explainRefusal(staple, { ...lacking(user, token, 'ACCESS'), code: 'LEDGER_INVALID_BALANCE' }, anchors));
		}).toThrow(UnexplainedRefusal);
	});
});

describe('the requirements a SEND puts on its account', function() {
	function described(requirements: readonly ACLPermissionRequirement[]): Set<string> {
		return(new Set(requirements.map(function({ principal, entity, target, permissions }): string {
			return(JSON.stringify([key(principal), key(entity), target?.publicKeyString.get() ?? null, permissions.base.flags, permissions.external.trueOffsets]));
		})));
	}

	test.each([
		{ kind: 'a keyed account', to: delegate },
		{ kind: 'a storage account', to: storage }
	])('are, for a send to $kind, what upstream records for it', async function({ to }) {
		const block = await sendBlock({ from: user, to, amount: 10n, token, previous: null, network: NETWORK });
		const [operation] = block.operations;
		if (operation?.type !== lib.Block.OperationType.SEND) {
			throw(new Error('the block holds no send'));
		}

		const recorded = Object.values(LedgerInternals.computeEffectOfBlocks([block], anchors).accounts).flatMap(function(effect): ACLPermissionRequirement[] {
			return(effect.fields.permissionRequirements ?? []);
		});

		const listed = sendRequirements(block, operation);
		expect(recorded).toHaveLength(listed.length);
		expect(described(listed)).toEqual(described(recorded));
	});
});

describe('the shadow-vote exceptions file', function() {
	test('lists each refused staple by blocks hash, in code-point order, with its reason, code and refused requirement', function() {
		const text = renderShadowVoteExceptions([
			{ blocksHash: 'B0', reason: 'trusted-account-genesis', code: 'LEDGER_INVALID_PERMISSIONS', requirement: { principal: owner, entity: anchors.baseToken, permissions: new lib.Permissions(['OWNER']) } },
			{ blocksHash: '0A', reason: 'self-requirement-return', code: 'LEDGER_INVALID_PERMISSIONS', requirement: { principal: user, entity: storage, target: token, permissions: new lib.Permissions(['STORAGE_DEPOSIT'], [3]) } }
		]);

		expect(text).toBe([
			'{',
			'  "0A": {',
			'    "reason": "self-requirement-return",',
			'    "code": "LEDGER_INVALID_PERMISSIONS",',
			'    "requirement": {',
			`      "principal": "${key(user)}",`,
			`      "entity": "${key(storage)}",`,
			`      "target": "${key(token)}",`,
			'      "base": [',
			'        "STORAGE_DEPOSIT",',
			'        "ACCESS"',
			'      ],',
			'      "external": [',
			'        3',
			'      ]',
			'    }',
			'  },',
			'  "B0": {',
			'    "reason": "trusted-account-genesis",',
			'    "code": "LEDGER_INVALID_PERMISSIONS",',
			'    "requirement": {',
			`      "principal": "${key(owner)}",`,
			`      "entity": "${key(anchors.baseToken)}",`,
			'      "base": [',
			'        "OWNER",',
			'        "ACCESS"',
			'      ],',
			'      "external": []',
			'    }',
			'  }',
			'}',
			''
		].join('\n'));
	});
});
