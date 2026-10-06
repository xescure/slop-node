import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { ACLRow } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import { LedgerInternals } from '../../../upstream/internals.js';
import { chainLengthOf, headOf, publicKeysOf, requireAt, useFixtures } from './support.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

const genesisShapes = [
	{ name: 'three representatives', weights: [400n, 300n, 300n] },
	{ name: 'one representative', weights: [1000n] }
] as const;

function describeACL(row: ACLRow): string {
	const [base, external] = row.permissions.toJSON();
	return(`${row.principalType} ${row.entity.publicKeyString.get()} -> ${row.target.publicKeyString.get()} ${String(base)}/${String(external)}`);
}

function sum(values: readonly bigint[]): bigint {
	return(values.reduce(function(total, value): bigint {
		return(total + value);
	}, 0n));
}

export function defineGenesisCases(driver: DriverUnderTest): void {
	describe.each(genesisShapes)('genesis with $name', function({ weights }) {
		const startNetwork = useFixtures(driver);

		test('Keeta Ledger adds genesis through the driver', async function() {
			const { network, ledger } = await startNetwork(weights);

			const applied = await ledger.add(network.genesis);

			expect(applied.map(function(staple): string {
				return(staple.blocksHash.toString());
			})).toEqual([network.genesis.blocksHash.toString()]);
		});

		test('genesis state reads back', async function() {
			const { network, ledger } = await startNetwork(weights);
			const { baseToken, networkAddress, genesis, trustedRoot } = network;
			const owner = new lib.Permissions(['OWNER']);
			const totalSupply = sum(weights);

			await ledger.add(genesis);

			for (const [index, weight] of weights.entries()) {
				const user = requireAt(network.users, index);
				const representative = requireAt(network.representatives, index);
				expect(await ledger.getBalance(user, baseToken)).toBe(weight);
				const balances = await ledger.getAllBalances(user);
				expect(balances.map(function({ token, balance }) {
					return({ token: token.publicKeyString.get(), balance });
				})).toEqual([{ token: baseToken.publicKeyString.get(), balance: weight }]);
				expect(await ledger.votingPower(representative)).toBe(weight);
				expect((await ledger.getAccountRep(user))?.publicKeyString.get()).toBe(representative.publicKeyString.get());
			}
			expect(await ledger.votingPower()).toBe(totalSupply);
			expect(await ledger.getBalance(baseToken, baseToken)).toBe(0n);
			expect(await ledger.getAllBalances(baseToken)).toEqual([]);

			const baseTokenInfo = await ledger.getAccountInfo(baseToken);
			expect(baseTokenInfo).toMatchObject({ name: 'TEST', description: 'Test Token', supply: totalSupply });
			expect(baseTokenInfo.defaultPermission?.toJSON()).toEqual(new lib.Permissions(['ACCESS']).toJSON());
			const networkInfo = await ledger.getAccountInfo(networkAddress);
			expect(networkInfo).toMatchObject({ name: 'KEETANET', description: 'Network Address For KeetaNet', metadata: '' });
			expect(networkInfo.defaultPermission?.toJSON()).toEqual(new lib.Permissions(['ACCESS', 'STORAGE_CREATE', 'TOKEN_ADMIN_CREATE']).toJSON());

			const accounts: GenericAccount[] = [networkAddress, baseToken, ...network.users];
			for (const account of accounts) {
				const head = await ledger.getHeadBlock(account, 'main');
				expect(head?.hash.toString()).toBe(headOf(genesis, account).toString());
				expect(await ledger.getHeadBlock(account, 'side')).toBeNull();
				const heightInfo = await ledger.getAccountsBlockHeightInfo([{ account }]);
				expect(heightInfo[account.publicKeyString.get()]).toEqual({ blockHash: headOf(genesis, account), height: chainLengthOf(genesis, account) - 1n });
			}

			const ownerRows = await ledger.listACLsByPrincipal(trustedRoot);
			expect(ownerRows.map(describeACL).sort()).toEqual([networkAddress, baseToken].map(function(entity): string {
				return(describeACL({ principalType: 'ACCOUNT', principal: trustedRoot, entity, target: entity, permissions: owner }));
			}).sort());

			for (const block of genesis.blocks) {
				expect((await ledger.getBlock(block.hash, 'main'))?.hash.toString()).toBe(block.hash.toString());
				const votes = await ledger.getVotes(block.hash, 'main');
				expect(votes?.map(function(vote): string {
					return(vote.$uid);
				})).toEqual(genesis.votes.map(function(vote): string {
					return(vote.$uid);
				}));
				expect(publicKeysOf(votes?.map(function(vote) {
					return(vote.issuer);
				}) ?? [])).toEqual([trustedRoot.publicKeyString.get()]);
			}
		});

		test('adding genesis twice is rejected with LEDGER_BLOCK_ALREADY_EXISTS', async function() {
			const { network, storage, ledger } = await startNetwork(weights);
			await ledger.add(network.genesis);

			// Keeta's Ledger refuses the replay earlier, at its quorum check, because
			// genesis votes carry no weight once weight exists, so the driver's own
			// duplicate check is exercised directly.
			await expect(ledger.add(network.genesis)).rejects.toMatchObject({ code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT' });
			const transaction = await storage.beginTransaction({ identifier: 'suite-genesis-twice', readOnly: false });
			const replay = storage.adjust(transaction, network.genesis, LedgerInternals.computeEffectOfBlocks(network.genesis.blocks, ledger));
			await expect(replay).rejects.toMatchObject({ code: 'LEDGER_BLOCK_ALREADY_EXISTS', shouldRetry: false });
			await storage.abortTransaction(transaction);

			expect(await ledger.votingPower()).toBe(sum(weights));
		});
	});
}
