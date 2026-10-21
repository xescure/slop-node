import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import {
	createMultisigBlock,
	createStorageBlock,
	createTokenBlock,
	manageCertificateBlock,
	modifyPermissionsBlock,
	multisigSendBlock,
	operationsBlock,
	receiveBlock,
	sendBlock,
	setInfoBlock,
	setRepresentativeBlock,
	tokenSupplyBlock
} from '../testing/blocks.js';
import { createTestNetwork, freezeClock, type TestNetwork } from '../testing/network.js';
import { certificateFor, DEFAULT_WEIGHTS, GENESIS_MOMENT } from '../ledger/storage/suite/support.js';
import { addressesOf, decodeBlock, type Address, type DecodedBlock, type DecodedOperation } from './decode.js';

const lib = KeetaNet.lib;

let network: TestNetwork;

beforeAll(async function() {
	freezeClock(GENESIS_MOMENT);
	network = await createTestNetwork({ representativeWeights: DEFAULT_WEIGHTS });
	vi.useRealTimers();
});

afterEach(function() {
	vi.useRealTimers();
});

function user(index: number): Account {
	const account = network.users[index];
	if (account === undefined) {
		throw(new Error(`the test network has no user ${String(index)}`));
	}
	return(account);
}

function addressOf(account: { readonly publicKeyString: { get(): string } }): Address {
	return(account.publicKeyString.get() as Address);
}

function decoded(block: Block): DecodedBlock {
	return(decodeBlock(new Uint8Array(block.toBytes())));
}

function onlyOperation(block: Block): DecodedOperation {
	const operations = decoded(block).operations;
	expect(operations).toHaveLength(1);
	return(operations[0] as DecodedOperation);
}

const BASE = { previous: null, network: 0n } as const;

describe('decoding a confirmed block', function() {
	test('a block names its hash, account, signer, date, version and purpose', async function() {
		const sender = user(0);
		const block = await sendBlock({ ...BASE, from: sender, to: user(1), amount: 5n, token: network.baseToken, date: GENESIS_MOMENT });

		expect(decoded(block)).toMatchObject({
			hash: block.hash.toString(),
			account: addressOf(sender),
			signer: addressOf(sender),
			date: GENESIS_MOMENT,
			version: 1,
			purpose: 0
		});
	});

	test('the signer of a multisig block is the multisig account', async function() {
		const owner = user(0);
		const cosigner = user(1);
		const { multisig } = await createMultisigBlock({ ...BASE, owner, signers: [owner, cosigner], quorum: 2n });

		const block = await multisigSendBlock({ ...BASE, from: owner, signer: [multisig, [owner, cosigner]], to: user(2), amount: 1n, token: network.baseToken });

		expect(decoded(block).signer).toBe(addressOf(multisig));
		expect(decoded(block).version).toBe(2);
	});

	test('a send names its recipient, token and amount', async function() {
		const [sender, recipient] = [user(0), user(1)];
		const block = await sendBlock({ ...BASE, from: sender, to: recipient, amount: 5n, token: network.baseToken });

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'SEND',
			account: addressOf(sender),
			counterparty: addressOf(recipient),
			token: addressOf(network.baseToken),
			amount: 5n,
			details: { external: null }
		});
	});

	test('a send keeps its external reference', async function() {
		const block = await operationsBlock({
			...BASE,
			account: user(0),
			operations: [{ type: lib.Block.OperationType.SEND, to: user(1), amount: 1n, token: network.baseToken, external: 'invoice 7' }]
		});

		expect(onlyOperation(block).details).toEqual({ external: 'invoice 7' });
	});

	test('a representative change names the representative', async function() {
		const [account, representative] = [user(0), user(1)];
		const block = await setRepresentativeBlock({ ...BASE, account, representative });

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'SET_REP',
			account: addressOf(account),
			counterparty: addressOf(representative),
			token: null,
			amount: null,
			details: {}
		});
	});

	test('an info change keeps every field and the default permission as decimal strings', async function() {
		const owner = user(0);
		const { token } = await createTokenBlock({ ...BASE, owner });
		const block = await setInfoBlock({
			...BASE,
			account: token,
			signer: owner,
			name: 'COIN',
			description: 'a coin',
			metadata: 'b25l',
			defaultPermission: new lib.Permissions(['ACCESS'])
		});

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'SET_INFO',
			account: addressOf(token),
			counterparty: null,
			token: null,
			amount: null,
			details: { name: 'COIN', description: 'a coin', metadata: 'b25l', defaultBase: '1', defaultExternal: '0' }
		});
	});

	test('an info change without a default permission states none', async function() {
		const block = await setInfoBlock({ ...BASE, account: user(0), name: 'ME', description: '', metadata: '' });

		expect(onlyOperation(block).details).toEqual({ name: 'ME', description: '', metadata: '', defaultBase: null, defaultExternal: null });
	});

	test('a permission change names the principal, target and permission sets', async function() {
		const [account, principal] = [user(0), user(1)];
		const block = await modifyPermissionsBlock({
			...BASE,
			account,
			principal,
			method: lib.Block.AdjustMethod.ADD,
			permissions: new lib.Permissions(['SEND_ON_BEHALF']),
			target: network.baseToken
		});

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'MODIFY_PERMISSIONS',
			account: addressOf(account),
			counterparty: addressOf(principal),
			token: null,
			amount: null,
			details: {
				method: 'ADD',
				certificateHash: null,
				target: addressOf(network.baseToken),
				base: '17',
				external: '0'
			}
		});
	});

	test('a permission change for the holders of a certificate names the certificate and its account', async function() {
		const [account, holder] = [user(0), user(1)];
		const authority = await certificateFor(user(2), 1);
		const block = await modifyPermissionsBlock({
			...BASE,
			account,
			principal: { usingCertificate: true, certificateHash: authority.hash(), certificateAccount: holder },
			method: lib.Block.AdjustMethod.SET,
			permissions: null
		});

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'MODIFY_PERMISSIONS',
			account: addressOf(account),
			counterparty: addressOf(holder),
			token: null,
			amount: null,
			details: { method: 'SET', certificateHash: authority.hash().toString(), target: null, base: null, external: null }
		});
	});

	test('creating a token names the token', async function() {
		const owner = user(0);
		const { block, token } = await createTokenBlock({ ...BASE, owner });

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'CREATE_IDENTIFIER',
			account: addressOf(owner),
			counterparty: addressOf(token),
			token: null,
			amount: null,
			details: { signers: null, quorum: null }
		});
	});

	test('creating a storage account names the storage account', async function() {
		const owner = user(0);
		const { block, storage } = await createStorageBlock({ ...BASE, owner });

		expect(onlyOperation(block)).toMatchObject({ type: 'CREATE_IDENTIFIER', counterparty: addressOf(storage), details: { signers: null, quorum: null } });
	});

	test('creating a multisig names its signers and quorum', async function() {
		const [owner, cosigner] = [user(0), user(1)];
		const { block, multisig } = await createMultisigBlock({ ...BASE, owner, signers: [owner, cosigner], quorum: 2n });

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'CREATE_IDENTIFIER',
			account: addressOf(owner),
			counterparty: addressOf(multisig),
			token: null,
			amount: null,
			details: { signers: [addressOf(owner), addressOf(cosigner)], quorum: '2' }
		});
	});

	test('a supply change takes the token to be the block account', async function() {
		const owner = user(0);
		const { token } = await createTokenBlock({ ...BASE, owner });
		const block = await tokenSupplyBlock({ ...BASE, owner, token, amount: 100n, method: lib.Block.AdjustMethod.SUBTRACT });

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'TOKEN_ADMIN_SUPPLY',
			account: addressOf(token),
			counterparty: null,
			token: addressOf(token),
			amount: 100n,
			details: { method: 'SUBTRACT' }
		});
		expect(decoded(block).signer).toBe(addressOf(owner));
	});

	test('a balance change names the token, amount and method', async function() {
		const account = user(0);
		const block = await operationsBlock({
			...BASE,
			account,
			operations: [{ type: lib.Block.OperationType.TOKEN_ADMIN_MODIFY_BALANCE, token: network.baseToken, amount: 7n, method: lib.Block.AdjustMethod.SET }]
		});

		expect(onlyOperation(block)).toEqual({
			index: 0,
			type: 'TOKEN_ADMIN_MODIFY_BALANCE',
			account: addressOf(account),
			counterparty: null,
			token: addressOf(network.baseToken),
			amount: 7n,
			details: { method: 'SET' }
		});
	});

	test('a receive names the sender, token and amount, and whether it is exact and forwarded', async function() {
		const [account, sender, forward] = [user(0), user(1), user(2)];
		const plain = await receiveBlock({ ...BASE, account, from: sender, token: network.baseToken, amount: 3n });
		const forwarded = await operationsBlock({
			...BASE,
			account,
			operations: [{ type: lib.Block.OperationType.RECEIVE, from: sender, token: network.baseToken, amount: 3n, exact: true, forward }]
		});

		expect(onlyOperation(plain)).toEqual({
			index: 0,
			type: 'RECEIVE',
			account: addressOf(account),
			counterparty: addressOf(sender),
			token: addressOf(network.baseToken),
			amount: 3n,
			details: { exact: false, forward: null }
		});
		expect(onlyOperation(forwarded).details).toEqual({ exact: true, forward: addressOf(forward) });
	});

	test('storing a certificate names its hash', async function() {
		const account = user(0);
		const held = await certificateFor(account, 2);
		const stored = await manageCertificateBlock({ ...BASE, account, method: lib.Block.AdjustMethod.ADD, certificateOrHash: held });
		const removed = await manageCertificateBlock({ ...BASE, account, method: lib.Block.AdjustMethod.SUBTRACT, certificateOrHash: held.hash() });

		const expected = { index: 0, type: 'MANAGE_CERTIFICATE', account: addressOf(account), counterparty: null, token: null, amount: null };
		expect(onlyOperation(stored)).toEqual({ ...expected, details: { method: 'ADD', certificateHash: held.hash().toString() } });
		expect(onlyOperation(removed)).toEqual({ ...expected, details: { method: 'SUBTRACT', certificateHash: held.hash().toString() } });
	});

	test('the operations of a block keep their order in the index', async function() {
		const [account, first, second] = [user(0), user(1), user(2)];
		const block = await operationsBlock({
			...BASE,
			account,
			operations: [
				{ type: lib.Block.OperationType.SEND, to: first, amount: 1n, token: network.baseToken },
				{ type: lib.Block.OperationType.SET_REP, to: second },
				{ type: lib.Block.OperationType.SEND, to: second, amount: 2n, token: network.baseToken }
			]
		});

		expect(decoded(block).operations.map(function(operation) {
			return([operation.index, operation.type, operation.counterparty, operation.amount]);
		})).toEqual([
			[0, 'SEND', addressOf(first), 1n],
			[1, 'SET_REP', addressOf(second), null],
			[2, 'SEND', addressOf(second), 2n]
		]);
	});

	test('bytes cut short are refused', async function() {
		const block = await sendBlock({ ...BASE, from: user(0), to: user(1), amount: 5n, token: network.baseToken });
		const bytes = new Uint8Array(block.toBytes());

		expect(function() {
			decodeBlock(bytes.subarray(0, bytes.length - 10));
		}).toThrow();
	});
});

describe('the addresses of a block', function() {
	test('a multisig creation names its owner, the multisig and every signer', async function() {
		const [owner, cosigner, third] = [user(0), user(1), user(2)];
		const { block, multisig } = await createMultisigBlock({ ...BASE, owner, signers: [owner, cosigner, third], quorum: 2n });

		expect(addressesOf(decoded(block))).toEqual(new Set([owner, cosigner, third, multisig].map(addressOf)));
	});

	test('a send names the sender, the recipient and the token', async function() {
		const [recipient, signer] = [user(1), user(2)];
		const { token } = await createTokenBlock({ ...BASE, owner: signer });
		const block = await sendBlock({ ...BASE, from: token, signer, to: recipient, amount: 1n, token });

		expect(addressesOf(decoded(block))).toEqual(new Set([token, signer, recipient].map(addressOf)));
	});

	test('a permission change names its target and a receive names its forward', async function() {
		const [account, principal, forward] = [user(0), user(1), user(2)];
		const { token: target } = await createTokenBlock({ ...BASE, owner: account });
		const block = await operationsBlock({
			...BASE,
			account,
			operations: [
				{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, principal, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['SEND_ON_BEHALF']), target },
				{ type: lib.Block.OperationType.RECEIVE, from: principal, token: network.baseToken, amount: 1n, exact: true, forward }
			]
		});

		expect(addressesOf(decoded(block))).toEqual(new Set([account, principal, network.baseToken, forward, target].map(addressOf)));
	});
});
