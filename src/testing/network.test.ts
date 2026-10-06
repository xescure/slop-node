import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block, BlockHash } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { MemoryLedgerStorage } from '../ledger/storage/memory/driver.js';
import { advanceClock, createTestNetwork, freezeClock } from './network.js';
import type { TestNetwork } from './network.js';
import {
	createTokenBlock,
	confirmedStaple,
	feeBlock,
	manageCertificateBlock,
	modifyPermissionsBlock,
	sendBlock,
	setInfoBlock,
	setRepresentativeBlock,
	tokenSupplyBlock
} from './blocks.js';

const { Block: BlockClass, Permissions } = KeetaNet.lib;
const OperationType = BlockClass.OperationType;
const FROZEN_AT = new Date(Date.UTC(2026, 9, 6, 12, 0, 0));
const WEIGHTS = [400n, 300n, 300n];

function toHex(staple: VoteStaple): string {
	return(Buffer.from(staple.toBytes()).toString('hex'));
}

function headOf(staple: VoteStaple, account: GenericAccount): BlockHash {
	const head = staple.blocks.filter(function(block): boolean {
		return(block.account.comparePublicKey(account));
	}).at(-1);
	if (head === undefined) {
		throw(new Error(`no block for ${account.publicKeyString.get()}`));
	}
	return(head.hash);
}

function requireAt<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) {
		throw(new Error(`missing element ${String(index)}`));
	}
	return(value);
}

async function sendFromFirstUser(network: TestNetwork): Promise<Block> {
	const from = requireAt(network.users, 0);
	return(await sendBlock({
		from,
		previous: headOf(network.genesis, from),
		to: requireAt(network.users, 1),
		amount: 25n,
		token: network.baseToken,
		network: network.network
	}));
}

describe('test network', function() {
	beforeEach(function() {
		freezeClock(FROZEN_AT);
	});

	afterEach(function() {
		vi.useRealTimers();
	});

	test('the same options build byte-identical genesis staples', async function() {
		const first = await createTestNetwork({ representativeWeights: WEIGHTS });
		const second = await createTestNetwork({ representativeWeights: WEIGHTS });

		expect(toHex(first.genesis)).toBe(toHex(second.genesis));
		expect(first.representatives.map(function(account): string {
			return(account.publicKeyString.get());
		})).toEqual(second.representatives.map(function(account): string {
			return(account.publicKeyString.get());
		}));
	});

	test('genesis is signed by the trusted root and funds every user', async function() {
		const network = await createTestNetwork({ representativeWeights: WEIGHTS });
		const { genesis, trustedRoot, baseToken, networkAddress } = network;

		expect(trustedRoot.hasPrivateKey).toBe(false);
		expect(network.trustedSigner.hasPrivateKey).toBe(true);
		expect(network.trustedSigner.comparePublicKey(trustedRoot)).toBe(true);

		expect(genesis.votes).toHaveLength(1);
		const [vote] = genesis.votes;
		expect(vote?.issuer.comparePublicKey(trustedRoot)).toBe(true);
		expect(vote?.$permanent).toBe(true);

		const networkBlock = genesis.blocks.find(function(block): boolean {
			return(block.account.comparePublicKey(networkAddress));
		});
		const setInfo = networkBlock?.operations.find(function(operation) {
			return(operation.type === OperationType.SET_INFO);
		});
		expect(setInfo?.type === OperationType.SET_INFO && setInfo.defaultPermission?.has(['TOKEN_ADMIN_CREATE'])).toBe(true);

		network.users.forEach(function(user, index) {
			const funding = genesis.blocks.flatMap(function(block) {
				if (!block.account.comparePublicKey(user)) {
					return([]);
				}
				return(block.operations);
			});
			const balanceOperation = funding.find(function(operation) {
				return(operation.type === OperationType.TOKEN_ADMIN_MODIFY_BALANCE);
			});
			const representativeOperation = funding.find(function(operation) {
				return(operation.type === OperationType.SET_REP);
			});

			expect(balanceOperation?.type === OperationType.TOKEN_ADMIN_MODIFY_BALANCE && balanceOperation.amount).toBe(requireAt(WEIGHTS, index));
			expect(balanceOperation?.type === OperationType.TOKEN_ADMIN_MODIFY_BALANCE && balanceOperation.token.comparePublicKey(baseToken)).toBe(true);
			expect(representativeOperation?.type === OperationType.SET_REP && representativeOperation.to.comparePublicKey(requireAt(network.representatives, index))).toBe(true);
		});

		const signedByTrustedRoot = genesis.blocks.filter(function(block): boolean {
			return(!Array.isArray(block.signer) && block.signer.comparePublicKey(trustedRoot));
		});
		expect(signedByTrustedRoot).toHaveLength(genesis.blocks.length - network.users.length);
	});

	test('a single representative uses the upstream genesis generator', async function() {
		const network = await createTestNetwork({ representativeWeights: [1000n] });

		expect(network.users).toHaveLength(1);
		expect(network.representatives).toHaveLength(1);
		expect(network.genesis.votes[0]?.issuer.comparePublicKey(network.trustedRoot)).toBe(true);
		expect(toHex(network.genesis)).toBe(toHex((await createTestNetwork({ representativeWeights: [1000n] })).genesis));
	});

	test('representatives, users and the trusted root are distinct keys', async function() {
		const network = await createTestNetwork({ representativeWeights: WEIGHTS });
		const keys = [network.trustedRoot, ...network.representatives, ...network.users].map(function(account: Account): string {
			return(account.publicKeyString.get());
		});

		expect(new Set(keys).size).toBe(keys.length);
	});

	test('createLedger builds a ledger on the given storage driver', async function() {
		const network = await createTestNetwork({ representativeWeights: WEIGHTS });
		const storageDriver = new MemoryLedgerStorage();
		const init = vi.spyOn(storageDriver, 'init');

		const ledger = network.createLedger(storageDriver, requireAt(network.representatives, 0), { fee: { kind: 'flat', amount: 5n, payTo: requireAt(network.representatives, 0) } });

		expect(ledger).toBeInstanceOf(KeetaNet.lib.Ledger);
		expect(init).toHaveBeenCalledTimes(1);
	});

	test('clock helpers move the system time', function() {
		expect(Date.now()).toBe(FROZEN_AT.getTime());

		advanceClock(1500);

		expect(Date.now()).toBe(FROZEN_AT.getTime() + 1500);
	});

	test('confirmed staples are deterministic under a frozen clock', async function() {
		async function build(): Promise<VoteStaple> {
			freezeClock(FROZEN_AT);
			const network = await createTestNetwork({ representativeWeights: WEIGHTS });
			return(await confirmedStaple([await sendFromFirstUser(network)], network.representatives));
		}

		const first = await build();
		const second = await build();

		expect(toHex(first)).toBe(toHex(second));
		expect(first.votes).toHaveLength(WEIGHTS.length);
		expect(first.votes.every(function(vote): boolean {
			return(vote.$permanent);
		})).toBe(true);
	});

	test('confirmed staples give different blocks different vote serials', async function() {
		const network = await createTestNetwork({ representativeWeights: WEIGHTS });
		const first = await confirmedStaple([await sendFromFirstUser(network)], network.representatives);
		const other = await sendBlock({
			from: requireAt(network.users, 2),
			previous: headOf(network.genesis, requireAt(network.users, 2)),
			to: requireAt(network.users, 1),
			amount: 1n,
			token: network.baseToken,
			network: network.network
		});
		const second = await confirmedStaple([other], network.representatives);

		expect(first.votes[0]?.serial).not.toBe(second.votes[0]?.serial);
	});
});

describe('block builders', function() {
	beforeEach(function() {
		freezeClock(FROZEN_AT);
	});

	afterEach(function() {
		vi.useRealTimers();
	});

	test('every builder returns a signed block carrying its operation', async function() {
		const network = await createTestNetwork({ representativeWeights: WEIGHTS });
		const owner = requireAt(network.users, 0);
		const peer = requireAt(network.users, 1);
		const previous = headOf(network.genesis, owner);
		const common = { previous, network: network.network };

		const created = await createTokenBlock({ owner, ...common });
		const token = created.token;
		const certificate = new KeetaNet.lib.Utils.Certificate.CertificateBuilder({
			issuer: owner,
			validFrom: new Date(FROZEN_AT.getTime() - 1000),
			validTo: new Date(FROZEN_AT.getTime() + 1000),
			serial: 1
		}).build({ subjectPublicKey: owner });

		const cases = [
			{ block: await sendBlock({ from: owner, to: peer, amount: 1n, token: network.baseToken, idempotent: btoa('one'), ...common }), type: OperationType.SEND },
			{ block: await setRepresentativeBlock({ account: owner, representative: requireAt(network.representatives, 1), ...common }), type: OperationType.SET_REP },
			{ block: created.block, type: OperationType.CREATE_IDENTIFIER },
			{ block: await tokenSupplyBlock({ owner, token, previous: null, amount: 10n, network: network.network }), type: OperationType.TOKEN_ADMIN_SUPPLY },
			{ block: await modifyPermissionsBlock({ account: owner, principal: peer, method: BlockClass.AdjustMethod.ADD, permissions: new Permissions(['ACCESS']), ...common }), type: OperationType.MODIFY_PERMISSIONS },
			{ block: await setInfoBlock({ account: token, signer: owner, previous: null, network: network.network, name: 'TEST_TOKEN', description: '', metadata: '', defaultPermission: new Permissions(['ACCESS']) }), type: OperationType.SET_INFO },
			{ block: await manageCertificateBlock({ account: owner, method: BlockClass.AdjustMethod.ADD, certificateOrHash: await certificate, ...common }), type: OperationType.MANAGE_CERTIFICATE },
			{ block: await feeBlock({ from: owner, payments: [{ to: requireAt(network.representatives, 0), token: network.baseToken, amount: 5n }], ...common }), type: OperationType.SEND }
		];

		for (const { block, type } of cases) {
			expect(block.signatures).not.toBeNull();
			expect(block.operations.map(function(operation) {
				return(operation.type);
			})).toEqual([type]);
		}
		expect(cases[0]?.block.idempotent).toBeDefined();
		expect(cases[7]?.block.purpose).toBe(BlockClass.Purpose.FEE);
		expect(created.block.operations[0]?.type === OperationType.CREATE_IDENTIFIER && created.block.operations[0].identifier.comparePublicKey(token)).toBe(true);
	});
});
