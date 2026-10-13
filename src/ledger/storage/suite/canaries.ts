import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { Ledger } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import {
	confirmedStaple,
	createStorageBlock,
	createTokenBlock,
	modifyPermissionsBlock,
	sendBlock,
	setInfoBlock,
	tokenSupplyBlock
} from '../../../testing/blocks.js';
import type { TestNetwork } from '../../../testing/network.js';
import { ChainCursor, requireAt, useFixtures } from './support.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

/** A thief's grant of SEND_ON_BEHALF to itself, followed by a send it signs from the victim's account. */
type DrainAttempt = {
	readonly selfGrant: Block;
	readonly drain: Block;
};

/*
 * The thief grants SEND_ON_BEHALF to itself, on its own account, and in the
 * same request signs a send from the victim. A grant satisfies a requirement
 * only when it is on the account the requirement is for.
 * [Keeta TS] index.js:69068-69097
 */
async function drainAttempt(network: TestNetwork, cursor: ChainCursor): Promise<DrainAttempt> {
	const victim = requireAt(network.users, 0);
	const thief = requireAt(network.users, 1);
	const selfGrant = await modifyPermissionsBlock({
		account: thief,
		previous: cursor.previous(thief),
		network: network.network,
		principal: thief,
		method: lib.Block.AdjustMethod.ADD,
		permissions: new lib.Permissions(['SEND_ON_BEHALF']),
		target: network.baseToken
	});
	const drain = await sendBlock({ from: victim, signer: thief, previous: cursor.previous(victim), to: thief, amount: 100n, token: network.baseToken, network: network.network });
	return({ selfGrant, drain });
}

async function expectNothingPending(ledger: Ledger, blocks: readonly Block[]): Promise<void> {
	for (const block of blocks) {
		expect(await ledger.getVotes(block.hash, 'side')).toBeNull();
	}
}

/*
 * Permission bypasses that an earlier client release accepted. Each must be
 * refused by the ledger running on this driver, which supplies every ACL and
 * account-info read the permission check makes.
 */
export function defineCanaryCases(driver: DriverUnderTest): void {
	describe('permission canaries', function() {
		const startNetwork = useFixtures(driver);

		test('same-staple self-grant is rejected', async function() {
			const { network, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const cursor = new ChainCursor(network.genesis);
			const { selfGrant, drain } = await drainAttempt(network, cursor);

			await expect(ledger.vote([selfGrant, drain])).rejects.toMatchObject({ code: 'LEDGER_INVALID_PERMISSIONS', shouldRetry: false });

			await expectNothingPending(ledger, [selfGrant, drain]);
			// The self-grant alone is acceptable, so the refusal is the drain's.
			expect((await ledger.vote([selfGrant])).$permanent).toBe(false);
			// The same drain with the victim's own grant in the request is authorized.
			const victim = requireAt(network.users, 0);
			const thief = requireAt(network.users, 1);
			const grant = cursor.append(await modifyPermissionsBlock({
				account: victim,
				previous: cursor.previous(victim),
				network: network.network,
				principal: thief,
				method: lib.Block.AdjustMethod.ADD,
				permissions: new lib.Permissions(['SEND_ON_BEHALF']),
				target: network.baseToken
			}));
			const authorized = await sendBlock({ from: victim, signer: thief, previous: grant.hash, to: thief, amount: 100n, token: network.baseToken, network: network.network });
			expect((await ledger.vote([grant, authorized])).$permanent).toBe(false);
		});

		/*
		 * The victim's removal of a flag from the thief, on the victim's own
		 * account, matches the drain's requirement in everything but its
		 * method, so only the method check refuses it.
		 * [Keeta TS] index.js:69071-69079
		 */
		test('subtract does not satisfy a grant requirement', async function() {
			const { network, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const victim = requireAt(network.users, 0);
			const thief = requireAt(network.users, 1);
			const cursor = new ChainCursor(network.genesis);
			const removal = cursor.append(await modifyPermissionsBlock({
				account: victim,
				previous: cursor.previous(victim),
				network: network.network,
				principal: thief,
				method: lib.Block.AdjustMethod.SUBTRACT,
				permissions: new lib.Permissions(['SEND_ON_BEHALF']),
				target: network.baseToken
			}));
			const drain = await sendBlock({ from: victim, signer: thief, previous: removal.hash, to: thief, amount: 100n, token: network.baseToken, network: network.network });

			await expect(ledger.vote([removal, drain])).rejects.toMatchObject({ code: 'LEDGER_INVALID_PERMISSIONS', shouldRetry: false });

			await expectNothingPending(ledger, [removal, drain]);
			// The removal alone is acceptable, so the refusal is the drain's.
			expect((await ledger.vote([removal])).$permanent).toBe(false);
		});

		/*
		 * A token's send of itself skips the token's own ACCESS check, and must
		 * still need the storage account's STORAGE_CAN_HOLD and STORAGE_DEPOSIT.
		 * [Keeta TS] index.js:69497-69527, 69682-69684
		 */
		test('token self-send into storage is rejected', async function() {
			const { network, ledger } = await startNetwork();
			await ledger.add(network.genesis);
			const owner = requireAt(network.users, 0);
			const cursor = new ChainCursor(network.genesis);
			const createdToken = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
			const { token } = createdToken;
			cursor.append(createdToken.block);
			const minted = cursor.append(await tokenSupplyBlock({ owner, token, previous: cursor.previous(token), amount: 100n, network: network.network }));
			// Everyone may hold the token, so only the storage account's permissions are missing.
			const opened = cursor.append(await setInfoBlock({ account: token, signer: owner, previous: cursor.previous(token), network: network.network, name: 'CANARY', description: '', metadata: '', defaultPermission: new lib.Permissions(['ACCESS']) }));
			const createdStorage = await createStorageBlock({ owner, previous: cursor.previous(owner), network: network.network });
			const { storage } = createdStorage;
			cursor.append(createdStorage.block);
			await ledger.add(await confirmedStaple([createdToken.block, minted, opened, createdStorage.block], network.representatives));
			const deposit = await sendBlock({ from: token, signer: owner, previous: cursor.previous(token), to: storage, amount: 10n, token, network: network.network });

			await expect(ledger.vote([deposit])).rejects.toMatchObject({ code: 'LEDGER_INVALID_PERMISSIONS', shouldRetry: false });

			await expectNothingPending(ledger, [deposit]);
			// Once the storage account admits the token, the same send is accepted.
			const canHold = cursor.append(await modifyPermissionsBlock({ account: storage, signer: owner, previous: cursor.previous(storage), network: network.network, principal: token, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['STORAGE_CAN_HOLD']) }));
			const mayDeposit = cursor.append(await modifyPermissionsBlock({ account: storage, signer: owner, previous: cursor.previous(storage), network: network.network, principal: token, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['STORAGE_DEPOSIT']), target: token }));
			await ledger.add(await confirmedStaple([canHold, mayDeposit], network.representatives));
			expect((await ledger.vote([deposit])).$permanent).toBe(false);
		});
	});
}
