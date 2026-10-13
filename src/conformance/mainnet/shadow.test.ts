import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockOperations, BlockOperationSEND } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import type { ACLPermissionRequirement } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { confirmedStaple, operationsBlock, sendBlock } from '../../testing/blocks.js';
import { LedgerInternals } from '../../upstream/internals.js';
import { loadMainnetFixture, MAINNET_NETWORK, mainnetTrustedRoot } from './fixture.js';
import { UnexplainedRefusal, explainRefusal, renderShadowVoteExceptions, sendRequirements, shadowVoteExceptions } from './shadow.js';
import type { LedgerRefusal, NetworkAnchors, RefusedStaple } from './shadow.js';

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

/** The publication of 0.18.0, the first release whose SEND lists its recipient's ACCESS. */
const RECIPIENT_ACCESS_RELEASE = new Date('2026-05-23T16:44:23.024Z');

const BEFORE_RECIPIENT_ACCESS = new Date(RECIPIENT_ACCESS_RELEASE.valueOf() - 1);

const AFTER_RECIPIENT_ACCESS = new Date('2026-10-01T00:00:00.000Z');

function vouchedBy(issuer: Account, blocks: readonly Block[], validityFrom: Date = AFTER_RECIPIENT_ACCESS): RefusedStaple {
	return({ blocks, votes: [{ issuer, validityFrom }] });
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

	describe('a send to a recipient without access on the token', function() {
		test('voted before 0.18.0 was published, it was voted without the recipient\'s requirement', async function() {
			const staple = vouchedBy(representative, [await blockOf(user, user, [
				{ type: lib.Block.OperationType.SEND, to: delegate, amount: 1n, token }
			])], BEFORE_RECIPIENT_ACCESS);

			expect(explainRefusal(staple, lacking(delegate, token, 'ACCESS'), anchors).reason).toBe('send-recipient-access');
		});

		test('voted once 0.18.0 was published, its refusal is unexplained', async function() {
			const staple = vouchedBy(representative, [await blockOf(user, user, [
				{ type: lib.Block.OperationType.SEND, to: delegate, amount: 1n, token }
			])], RECIPIENT_ACCESS_RELEASE);

			expect(function() {
				return(explainRefusal(staple, lacking(delegate, token, 'ACCESS'), anchors));
			}).toThrow('0 reasons explain');
		});

		test('a staple with any vote cast once 0.18.0 was published is unexplained', async function() {
			const blocks = [await blockOf(user, user, [
				{ type: lib.Block.OperationType.SEND, to: delegate, amount: 1n, token }
			])];
			const staple: RefusedStaple = { blocks, votes: [{ issuer: representative, validityFrom: BEFORE_RECIPIENT_ACCESS }, { issuer: trustedRoot, validityFrom: AFTER_RECIPIENT_ACCESS }] };

			expect(function() {
				return(explainRefusal(staple, lacking(delegate, token, 'ACCESS'), anchors));
			}).toThrow('0 reasons explain');
		});

		test('a staple without votes is unexplained', async function() {
			const blocks = [await blockOf(user, user, [
				{ type: lib.Block.OperationType.SEND, to: delegate, amount: 1n, token }
			])];

			expect(function() {
				return(explainRefusal({ blocks, votes: [] }, lacking(delegate, token, 'ACCESS'), anchors));
			}).toThrow('0 reasons explain');
		});

		test('a recipient that is also a block\'s account in the staple may owe the access for its own operation, so it is unexplained', async function() {
			const staple = vouchedBy(representative, [
				await blockOf(user, user, [
					{ type: lib.Block.OperationType.SEND, to: delegate, amount: 1n, token }
				]),
				await blockOf(delegate, delegate, [
					{ type: lib.Block.OperationType.RECEIVE, amount: 1n, token, from: user, exact: true }
				])
			], BEFORE_RECIPIENT_ACCESS);

			expect(function() {
				return(explainRefusal(staple, lacking(delegate, token, 'ACCESS'), anchors));
			}).toThrow('0 reasons explain');
		});

		test('a token sending its own token is the early return\'s alone', async function() {
			const staple = vouchedBy(representative, [await blockOf(token, owner, [
				{ type: lib.Block.OperationType.SEND, to: user, amount: 10n, token }
			])], BEFORE_RECIPIENT_ACCESS);

			expect(explainRefusal(staple, lacking(user, token, 'ACCESS'), anchors).reason).toBe('self-requirement-return');
		});

		/*
		 * Airdrops that mainnet confirmed on 2025-12-30: each sends one unit of a
		 * token with no default permission to 500 accounts holding no permission
		 * on it, and a 0.18.7 ledger refuses each for its first recipient.
		 */
		test.each([0, 1, 2])('explains the airdrop staple %i that mainnet confirmed', async function(index) {
			const staple: VoteStaple | undefined = (await loadMainnetFixture('recipient-access'))[index];
			const [block] = staple?.blocks ?? [];
			const [send] = block?.operations ?? [];
			if (staple === undefined || send?.type !== lib.Block.OperationType.SEND) {
				throw(new Error('each airdrop staple opens with a send'));
			}
			const mainnet: NetworkAnchors = { initialTrustedAccount: mainnetTrustedRoot(), ...lib.Account.generateBaseAddresses(MAINNET_NETWORK) };

			expect(explainRefusal(staple, lacking(send.to, send.token, 'ACCESS'), mainnet).reason).toBe('send-recipient-access');
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

describe('a shadow-vote refusal for a block\'s date', function() {
	const VOTED = new Date('2026-10-08T19:54:38.360Z');
	const expired = function(date: Date): LedgerRefusal {
		return({ code: 'LEDGER_BLOCK_EXPIRED', message: `Refusing to issue vote for block dated ${date.toISOString()}` });
	};
	const datedBlock = function(date: Date): Promise<Block> {
		return(operationsBlock({ account: user, signer: user, previous: null, network: NETWORK, date, operations: [{ type: lib.Block.OperationType.SET_REP, to: representative }] }));
	};

	test('is explained when a block is dated more than five minutes before the staple\'s earliest vote, as the representatives voted without the date check', async function() {
		const blockDate = new Date('2026-10-08T19:48:47.109Z');
		const staple: RefusedStaple = { blocks: [await datedBlock(blockDate)], votes: [{ issuer: representative, validityFrom: new Date(VOTED.valueOf() + 240) }, { issuer: delegate, validityFrom: VOTED }] };

		expect(explainRefusal(staple, expired(blockDate), anchors)).toEqual({ reason: 'permanent-vote-block-age', requirement: null });
	});

	test.each([
		['five minutes before the earliest vote', -5 * 60_000],
		['within five minutes before it', -4 * 60_000],
		['after it', 60_000],
		['more than five minutes after it, in the future of the votes', 6 * 60_000]
	])('is unexplained for a staple whose one block is dated %s', async function(_, offset) {
		const blockDate = new Date(VOTED.valueOf() + offset);
		const staple: RefusedStaple = { blocks: [await datedBlock(blockDate)], votes: [{ issuer: representative, validityFrom: VOTED }] };

		expect(function() {
			return(explainRefusal(staple, expired(blockDate), anchors));
		}).toThrow(UnexplainedRefusal);
	});

	test('is explained for a staple whose one block is older than five minutes and the other as new as its votes, as 1BE261B781FE0DF70EAC7FA5F6076197416F0A5AB01D42FD5D4781F81728DFF4 on the main network', async function() {
		const old = new Date('2026-10-08T19:48:47.109Z');
		const staple: RefusedStaple = {
			blocks: [await datedBlock(old), await datedBlock(new Date('2026-10-08T19:54:38.145Z'))],
			votes: [{ issuer: representative, validityFrom: new Date('2026-10-08T19:54:38.363Z') }, { issuer: delegate, validityFrom: new Date('2026-10-08T19:54:38.384Z') }]
		};

		expect(explainRefusal(staple, expired(old), anchors)).toEqual({ reason: 'permanent-vote-block-age', requirement: null });
	});

	test('is unexplained when any block is dated after the earliest vote, however old the others', async function() {
		const old = new Date(VOTED.valueOf() - 10 * 60_000);
		for (const offset of [1, 6 * 60_000]) {
			const staple: RefusedStaple = { blocks: [await datedBlock(old), await datedBlock(new Date(VOTED.valueOf() + offset))], votes: [{ issuer: representative, validityFrom: VOTED }] };

			expect(function() {
				return(explainRefusal(staple, expired(old), anchors));
			}).toThrow(UnexplainedRefusal);
		}
	});

	test('is no exception the head replay lists, as only a vote beside the staple\'s permanent votes confirms it', async function() {
		const blockDate = new Date(VOTED.valueOf() - 10 * 60_000);
		const staple = await confirmedStaple([await datedBlock(blockDate)], [representative], { voteDelays: [10 * 60_000] });

		expect(function() {
			return(shadowVoteExceptions([{ outcome: 'refused', staple, refusal: expired(blockDate) }], anchors));
		}).toThrow('a refusal for a block\'s date is explained only by a vote beside the staple\'s permanent votes');
	});
});

describe('the requirements a SEND puts on its account', function() {
	function described(requirements: readonly ACLPermissionRequirement[]): Set<string> {
		return(new Set(requirements.map(function({ principal, entity, target, permissions }): string {
			return(JSON.stringify([key(principal), key(entity), target?.publicKeyString.get() ?? null, permissions.base.flags, permissions.external.trueOffsets]));
		})));
	}

	function isOnItself(requirement: ACLPermissionRequirement): boolean {
		return(requirement.entity.comparePublicKey(requirement.principal));
	}

	function isSend(operation: BlockOperations): operation is BlockOperationSEND {
		return(operation.type === lib.Block.OperationType.SEND);
	}

	/** A signer other than the account is required to hold permissions of its own, which no SEND lists. */
	function isAccountRequirement(block: Block): (requirement: ACLPermissionRequirement) => boolean {
		return(function(requirement): boolean {
			return(block.account.comparePublicKey(block.principal) || !requirement.principal.comparePublicKey(block.principal));
		});
	}

	/*
	 * The classifier reads these lists in upstream's order, so they are checked
	 * against what upstream records for the same block, in each shape the
	 * classifier tells apart: 0.18.7 records every listed requirement except one
	 * of an account on itself, which it skips, and keeps the ones after it.
	 * [Keeta TS] index.js:69682-69684
	 */
	test.each([
		{ shape: 'a keyed account to a keyed account', onItself: 0, block: () => sendBlock({ from: user, to: delegate, amount: 10n, token, previous: null, network: NETWORK }) },
		{ shape: 'a keyed account to a storage account', onItself: 0, block: () => sendBlock({ from: user, to: storage, amount: 10n, token, previous: null, network: NETWORK }) },
		{ shape: 'a token to a keyed account', onItself: 1, block: () => blockOf(token, owner, [
			{ type: lib.Block.OperationType.SEND, to: user, amount: 10n, token }
		]) },
		{ shape: 'a minting token to a storage account', onItself: 1, block: () => blockOf(token, owner, [
			{ type: lib.Block.OperationType.TOKEN_ADMIN_SUPPLY, amount: 10n, method: lib.Block.AdjustMethod.ADD },
			{ type: lib.Block.OperationType.SEND, to: storage, amount: 10n, token }
		]) }
	])('are, for a send from $shape, what upstream records for it once it skips each requirement of an account on itself', async function({ onItself, block: makeBlock }) {
		const block = await makeBlock();
		const listed = block.operations.filter(isSend).flatMap(function(operation): ACLPermissionRequirement[] {
			return(sendRequirements(block, operation));
		});

		const recorded = Object.values(LedgerInternals.computeEffectOfBlocks([block], anchors).accounts).flatMap(function(effect): ACLPermissionRequirement[] {
			return(effect.fields.permissionRequirements ?? []);
		}).filter(isAccountRequirement(block));

		const [first] = listed;
		if (first === undefined) {
			throw(new Error('a send lists at least two requirements'));
		}
		const kept = listed.filter(function(requirement): boolean {
			return(!isOnItself(requirement));
		});
		expect(isOnItself(first)).toBe(onItself > 0);
		expect(listed.length - kept.length).toBe(onItself);
		expect(recorded).toHaveLength(kept.length);
		expect(described(recorded)).toEqual(described(kept));
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
