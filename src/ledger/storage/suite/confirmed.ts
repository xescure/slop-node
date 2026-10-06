import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Ledger, PaginatedVotes } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { ACLRow } from '@keetanetwork/keetanet-client/lib/ledger/types.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { LedgerInternals } from '../../../upstream/internals.js';
import { assertNever } from '../../../util/assert-never.js';
import { advanceClock } from '../../../testing/network.js';
import type { TestNetwork } from '../../../testing/network.js';
import {
	confirmedStaple,
	createMultisigBlock,
	createTokenBlock,
	manageCertificateBlock,
	modifyPermissionsBlock,
	sendBlock,
	setInfoBlock,
	setRepresentativeBlock,
	tokenSupplyBlock
} from '../../../testing/blocks.js';
import { computeConfirmedStapleChange } from '../confirmed.js';
import type { ConfirmedStapleChange } from '../confirmed.js';
import { toBlockHashKey } from '../keys.js';
import {
	ChainCursor,
	GENESIS_MOMENT,
	TESTING_KEY,
	certificateFor,
	blockHashesOf,
	blocksHashesOf,
	chainLengthOf,
	headOf,
	publicKeysOf,
	readStorage,
	requireAt,
	useFixtures
} from './support.js';
import type { DriverUnderTest } from './types.js';

const lib = KeetaNet.lib;

const NEWCOMER_SEED = '7d3b9e05a1c64f28b0e9d7c6a5b4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6';

type PermissionFlags = ConstructorParameters<typeof lib.Permissions>[0];

type ACLSummary = {
	readonly principal: string;
	readonly entity: string;
	readonly target: string;
	readonly permissions: readonly [bigint, bigint];
};

function permissionsOf(flags: PermissionFlags): readonly [bigint, bigint] {
	return(new lib.Permissions(flags).toJSON());
}

function summarizeACL(row: ACLRow): ACLSummary {
	let principal: string;
	switch (row.principalType) {
		case 'ACCOUNT':
			principal = row.principal.publicKeyString.get();
			break;
		case 'CERTIFICATE':
			principal = `${row.principal.certificate.toString()}:${row.principal.certificateAccount.publicKeyString.get()}`;
			break;
		default:
			return(assertNever(row));
	}
	return({
		principal,
		entity: row.entity.publicKeyString.get(),
		target: row.target.publicKeyString.get(),
		permissions: row.permissions.toJSON()
	});
}

function byTarget(left: ACLSummary, right: ACLSummary): number {
	return(left.target.localeCompare(right.target));
}

function newcomerAccount(): Account {
	return(lib.Account.fromSeed(NEWCOMER_SEED, 0));
}

/** The staple each vote of a page belongs to, in page order. */
function staplesOfPage(page: PaginatedVotes): string[] {
	return(page.votes.map(function(vote): string {
		return(lib.Vote.VoteBlocksHash.fromVote(vote).toString());
	}));
}

async function addEach(ledger: Ledger, staples: readonly VoteStaple[]): Promise<void> {
	for (const staple of staples) {
		await ledger.add(staple);
	}
}

async function headHash(ledger: Ledger, account: GenericAccount): Promise<string | undefined> {
	return((await ledger.getHeadBlock(account, 'main'))?.hash.toString());
}

/*
 * Each modification of a principal's ACLs goes into a staple of its own, so
 * that every resolution reads the rows the previous staple stored.
 */
async function applyPermissionChanges(network: TestNetwork, ledger: Ledger, cursor: ChainCursor, entity: Account, changes: readonly Omit<Parameters<typeof modifyPermissionsBlock>[0], 'account' | 'previous' | 'network'>[]): Promise<void> {
	for (const change of changes) {
		const block = cursor.append(await modifyPermissionsBlock({ account: entity, previous: cursor.previous(entity), network: network.network, ...change }));
		await ledger.add(await confirmedStaple([block], network.representatives));
	}
}

async function aclsOf(ledger: Ledger, principal: GenericAccount, entity: GenericAccount): Promise<ACLSummary[]> {
	return((await ledger.listACLsByPrincipal(principal, [entity])).map(summarizeACL).sort(byTarget));
}

function rowFor(principal: GenericAccount, entity: GenericAccount, target: GenericAccount, flags: PermissionFlags): ACLSummary {
	return({
		principal: principal.publicKeyString.get(),
		entity: entity.publicKeyString.get(),
		target: target.publicKeyString.get(),
		permissions: permissionsOf(flags)
	});
}

export function defineConfirmedCases(driver: DriverUnderTest): void {
	describe('confirmed ledger', function() {
		const startNetwork = useFixtures(driver);

		test('send moves balances and credits the receiver', async function() {
			const { network, ledger } = await startNetwork();
			const sender = requireAt(network.users, 0);
			const receiver = requireAt(network.users, 1);
			const newcomer = newcomerAccount();
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const toReceiver = cursor.append(await sendBlock({ from: sender, previous: cursor.previous(sender), to: receiver, amount: 5n, token: network.baseToken, network: network.network }));
			const toNewcomer = cursor.append(await sendBlock({ from: sender, previous: cursor.previous(sender), to: newcomer, amount: 20n, token: network.baseToken, network: network.network }));
			const staple = await confirmedStaple([toReceiver, toNewcomer], network.representatives);

			expect(blocksHashesOf(await ledger.add(staple))).toEqual(blocksHashesOf([staple]));

			expect(await ledger.getBalance(sender, network.baseToken)).toBe(375n);
			expect(await ledger.getBalance(receiver, network.baseToken)).toBe(305n);
			expect(await ledger.getBalance(newcomer, network.baseToken)).toBe(20n);
			expect((await ledger.getAllBalances(newcomer)).map(function({ token, balance }) {
				return({ token: token.publicKeyString.get(), balance });
			})).toEqual([{ token: network.baseToken.publicKeyString.get(), balance: 20n }]);
			// Weight follows the base token of delegating accounts only; the newcomer has no representative.
			expect(await ledger.votingPower(requireAt(network.representatives, 0))).toBe(375n);
			expect(await ledger.votingPower(requireAt(network.representatives, 1))).toBe(305n);
			expect(await ledger.votingPower()).toBe(980n);

			expect(await headHash(ledger, sender)).toBe(toNewcomer.hash.toString());
			expect(await ledger.getHeadBlock(newcomer, 'main')).toBeNull();
			const heights = await ledger.getAccountsBlockHeightInfo([{ account: sender }, { account: receiver }]);
			expect(heights[sender.publicKeyString.get()]).toEqual({ blockHash: toNewcomer.hash, height: chainLengthOf(network.genesis, sender) + 1n });
			expect(heights[receiver.publicKeyString.get()]).toEqual({ blockHash: headOf(network.genesis, receiver), height: chainLengthOf(network.genesis, receiver) - 1n });
			expect((await ledger.getBlockFromPrevious(toReceiver.hash, 'main'))?.hash.toString()).toBe(toNewcomer.hash.toString());
			expect((await ledger.getBlockFromPrevious(headOf(network.genesis, sender), 'main'))?.hash.toString()).toBe(toReceiver.hash.toString());
			expect((await ledger.getBlock(toReceiver.hash, 'main'))?.hash.toString()).toBe(toReceiver.hash.toString());
			expect((await ledger.getVotes(toNewcomer.hash, 'main'))?.map(function(vote): string {
				return(vote.$uid);
			}).sort()).toEqual(staple.votes.map(function(vote): string {
				return(vote.$uid);
			}).sort());
		});

		test('token creation, supply and token-account balances', async function() {
			const { network, storage, ledger } = await startNetwork();
			const owner = requireAt(network.users, 0);
			const holder = requireAt(network.users, 1);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const created = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
			const { token } = created;
			cursor.append(created.block);
			const minted = cursor.append(await tokenSupplyBlock({ owner, token, previous: cursor.previous(token), amount: 100n, network: network.network }));
			const distributed = cursor.append(await sendBlock({ from: token, signer: owner, previous: cursor.previous(token), to: holder, amount: 30n, token, network: network.network }));
			const burned = cursor.append(await tokenSupplyBlock({ owner, token, previous: cursor.previous(token), amount: 10n, method: lib.Block.AdjustMethod.SUBTRACT, network: network.network }));

			await addEach(ledger, [
				await confirmedStaple([created.block, minted], network.representatives),
				await confirmedStaple([distributed, burned], network.representatives)
			]);

			expect((await ledger.getAccountInfo(token)).supply).toBe(90n);
			expect(await ledger.getBalance(token, token)).toBe(60n);
			expect(await ledger.getBalance(holder, token)).toBe(30n);
			expect((await ledger.getAllBalances(holder)).map(function({ token: held, balance }) {
				return({ token: held.publicKeyString.get(), balance });
			}).sort(function(left, right): number {
				return(left.token.localeCompare(right.token));
			})).toEqual([
				{ token: network.baseToken.publicKeyString.get(), balance: 300n },
				{ token: token.publicKeyString.get(), balance: 30n }
			].sort(function(left, right): number {
				return(left.token.localeCompare(right.token));
			}));
			expect(await ledger.votingPower()).toBe(1000n);
			expect(await headHash(ledger, token)).toBe(burned.hash.toString());

			const owners = await readStorage(storage, async function(transaction) {
				return({
					any: await storage.listOwners(transaction, token),
					onToken: await storage.listOwners(transaction, token, token),
					onHolder: await storage.listOwners(transaction, token, holder)
				});
			});
			expect(publicKeysOf(owners.any)).toEqual([owner.publicKeyString.get()]);
			expect(publicKeysOf(owners.onToken)).toEqual([owner.publicKeyString.get()]);
			expect(owners.onHolder).toEqual([]);
			expect((await ledger.listACLsByEntity(token)).map(summarizeACL)).toEqual([rowFor(owner, token, token, ['OWNER'])]);
			expect(await ledger.listACLsByEntity(token, { principalType: 'CERTIFICATE' })).toEqual([]);
		});

		test('set representative moves weight', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const first = requireAt(network.representatives, 0);
			const second = requireAt(network.representatives, 1);
			const third = requireAt(network.representatives, 2);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const delegation = cursor.append(await setRepresentativeBlock({ account: user, representative: second, previous: cursor.previous(user), network: network.network }));
			await ledger.add(await confirmedStaple([delegation], network.representatives));

			expect((await ledger.getAccountRep(user))?.publicKeyString.get()).toBe(second.publicKeyString.get());
			expect(await ledger.votingPower(first)).toBe(0n);
			expect(await ledger.votingPower(second)).toBe(700n);
			expect(await ledger.votingPower(third)).toBe(300n);

			const spend = cursor.append(await sendBlock({ from: user, previous: cursor.previous(user), to: requireAt(network.users, 2), amount: 10n, token: network.baseToken, network: network.network }));
			await ledger.add(await confirmedStaple([spend], network.representatives));

			expect(await ledger.votingPower(second)).toBe(690n);
			expect(await ledger.votingPower(third)).toBe(310n);
			expect(await ledger.votingPower()).toBe(1000n);
		});

		test('modify permissions: add, set, null deletes, entity-wide fallback', async function() {
			const { network, ledger } = await startNetwork();
			const entity = requireAt(network.users, 0);
			const principal = requireAt(network.users, 1);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);

			await applyPermissionChanges(network, ledger, cursor, entity, [
				{ principal, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['ACCESS']) }
			]);
			expect(await aclsOf(ledger, principal, entity)).toEqual([rowFor(principal, entity, entity, ['ACCESS'])]);

			// A grant on a target starts from the entity-wide row when the target has none.
			await applyPermissionChanges(network, ledger, cursor, entity, [
				{ principal, target: network.baseToken, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['SEND_ON_BEHALF']) }
			]);
			expect(await aclsOf(ledger, principal, entity)).toEqual([
				rowFor(principal, entity, entity, ['ACCESS']),
				rowFor(principal, entity, network.baseToken, ['ACCESS', 'SEND_ON_BEHALF'])
			].sort(byTarget));

			await applyPermissionChanges(network, ledger, cursor, entity, [
				{ principal, method: lib.Block.AdjustMethod.SET, permissions: new lib.Permissions(['SEND_ON_BEHALF']) }
			]);
			expect(await aclsOf(ledger, principal, entity)).toEqual([
				rowFor(principal, entity, entity, ['SEND_ON_BEHALF']),
				rowFor(principal, entity, network.baseToken, ['ACCESS', 'SEND_ON_BEHALF'])
			].sort(byTarget));

			await applyPermissionChanges(network, ledger, cursor, entity, [
				{ principal, target: network.baseToken, method: lib.Block.AdjustMethod.SET, permissions: null }
			]);
			expect(await aclsOf(ledger, principal, entity)).toEqual([rowFor(principal, entity, entity, ['SEND_ON_BEHALF'])]);
			expect((await ledger.listACLsByEntity(entity)).map(summarizeACL)).toEqual([rowFor(principal, entity, entity, ['SEND_ON_BEHALF'])]);
			expect(await ledger.listACLsByPrincipal(principal, [])).toEqual([]);
		});

		test('subtract to empty stores an empty row (entity-wide row does not re-apply)', async function() {
			const { network, ledger } = await startNetwork();
			const entity = requireAt(network.users, 0);
			const principal = requireAt(network.users, 1);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);

			await applyPermissionChanges(network, ledger, cursor, entity, [
				{ principal, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['ACCESS']) },
				{ principal, target: network.baseToken, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['SEND_ON_BEHALF']) },
				{ principal, target: network.baseToken, method: lib.Block.AdjustMethod.SUBTRACT, permissions: new lib.Permissions(['ACCESS', 'SEND_ON_BEHALF']) }
			]);
			expect(await aclsOf(ledger, principal, entity)).toEqual([
				rowFor(principal, entity, entity, ['ACCESS']),
				rowFor(principal, entity, network.baseToken, [])
			].sort(byTarget));
			expect((await ledger.listACLsByEntity(entity)).map(summarizeACL).sort(byTarget)).toEqual([
				rowFor(principal, entity, entity, ['ACCESS']),
				rowFor(principal, entity, network.baseToken, [])
			].sort(byTarget));

			// Had the emptied row been deleted, this grant would inherit ACCESS from the entity-wide row.
			await applyPermissionChanges(network, ledger, cursor, entity, [
				{ principal, target: network.baseToken, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['SEND_ON_BEHALF']) }
			]);
			expect(await aclsOf(ledger, principal, entity)).toEqual([
				rowFor(principal, entity, entity, ['ACCESS']),
				rowFor(principal, entity, network.baseToken, ['SEND_ON_BEHALF'])
			].sort(byTarget));
		});

		test('set info merges defined keys only', async function() {
			const { network, ledger } = await startNetwork();
			const owner = requireAt(network.users, 0);
			const cosigner = requireAt(network.users, 1);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const created = await createTokenBlock({ owner, previous: cursor.previous(owner), network: network.network });
			const { token } = created;
			cursor.append(created.block);
			const described = cursor.append(await setInfoBlock({ account: token, signer: owner, previous: cursor.previous(token), network: network.network, name: 'FIRST', description: 'first', metadata: 'b25l', defaultPermission: new lib.Permissions(['ACCESS']) }));
			const minted = cursor.append(await tokenSupplyBlock({ owner, token, previous: cursor.previous(token), amount: 100n, network: network.network }));
			const renamed = cursor.append(await setInfoBlock({ account: token, signer: owner, previous: cursor.previous(token), network: network.network, name: 'SECOND', description: 'second', metadata: '', defaultPermission: new lib.Permissions(['ACCESS', 'MANAGE_CERTIFICATE']) }));
			const multisigCreated = await createMultisigBlock({ owner, signers: [owner, cosigner], quorum: 2n, previous: cursor.previous(owner), network: network.network });
			const { multisig } = multisigCreated;
			cursor.append(multisigCreated.block);

			await addEach(ledger, [
				await confirmedStaple([created.block, described, minted], network.representatives),
				await confirmedStaple([renamed], network.representatives),
				await confirmedStaple([multisigCreated.block], network.representatives)
			]);
			const tokenInfo = await ledger.getAccountInfo(token);
			const multisigInfo = await ledger.getAccountInfo(multisig);

			// Every field the operation carries is replaced; the supply, which it does not carry, stays.
			expect(tokenInfo).toMatchObject({ name: 'SECOND', description: 'second', metadata: '', supply: 100n });
			expect(tokenInfo.defaultPermission?.toJSON()).toEqual(permissionsOf(['ACCESS', 'MANAGE_CERTIFICATE']));
			// Creating a multisig produces info whose name fields are present but undefined; only the quorum is set.
			expect(multisigInfo).toMatchObject({ name: '', description: '', metadata: '', multisigQuorum: 2n });
			expect((await ledger.listACLsByEntity(multisig)).map(summarizeACL).sort(function(left, right): number {
				return(left.principal.localeCompare(right.principal));
			})).toEqual([owner, cosigner].map(function(signer): ACLSummary {
				return(rowFor(signer, multisig, multisig, ['MULTISIG_SIGNER']));
			}).sort(function(left, right): number {
				return(left.principal.localeCompare(right.principal));
			}));
		});

		test('certificates add and remove', async function() {
			const { network, ledger } = await startNetwork();
			const holder = requireAt(network.users, 0);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const certificate = await certificateFor(holder, 1);
			const hash = certificate.hash();
			const added = cursor.append(await manageCertificateBlock({ account: holder, previous: cursor.previous(holder), network: network.network, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate }));
			const removed = cursor.append(await manageCertificateBlock({ account: holder, previous: cursor.previous(holder), network: network.network, method: lib.Block.AdjustMethod.SUBTRACT, certificateOrHash: hash }));

			await ledger.add(await confirmedStaple([added], network.representatives));
			const listed = await ledger.getAccountCertificates(holder);
			const found = await ledger.getAccountCertificateByHash(holder, hash);
			const otherHolder = await ledger.getAccountCertificateByHash(requireAt(network.users, 1), hash);
			await ledger.add(await confirmedStaple([removed], network.representatives));

			expect(listed.map(function(entry): string {
				return(entry.certificate.hash().toString());
			})).toEqual([hash.toString()]);
			expect(found?.certificate.hash().toString()).toBe(hash.toString());
			expect(found?.intermediates).toBeNull();
			expect(otherHolder).toBeNull();
			expect(await ledger.getAccountCertificates(holder)).toEqual([]);
			expect(await ledger.getAccountCertificateByHash(holder, hash)).toBeNull();
		});

		test('idempotent keys resolve on main', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const other = requireAt(network.users, 1);
			const idempotent = btoa('order-1');
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const keyed = cursor.append(await sendBlock({ from: user, previous: cursor.previous(user), to: other, amount: 1n, token: network.baseToken, network: network.network, idempotent }));
			await ledger.add(await confirmedStaple([keyed], network.representatives));

			expect((await ledger.getIdempotentBlockHash(user, idempotent, 'main'))?.toString()).toBe(keyed.hash.toString());
			expect((await ledger.getBlockFromIdempotent(user, idempotent, 'main'))?.hash.toString()).toBe(keyed.hash.toString());
			expect(await ledger.getIdempotentBlockHash(user, idempotent, 'main', keyed.hash)).toBeNull();
			expect(await ledger.getIdempotentBlockHash(other, idempotent, 'main')).toBeNull();
			expect(await ledger.getIdempotentBlockHash(user, btoa('order-2'), 'main')).toBeNull();

			const reused = await sendBlock({ from: user, previous: cursor.previous(user), to: other, amount: 2n, token: network.baseToken, network: network.network, idempotent });
			await expect(ledger.add(await confirmedStaple([reused], network.representatives))).rejects.toMatchObject({ code: 'LEDGER_IDEMPOTENT_KEY_EXISTS' });
			expect(await headHash(ledger, user)).toBe(keyed.hash.toString());
			expect(await ledger.getBalance(user, network.baseToken)).toBe(399n);

			// Two blocks of one staple may not claim one key either.
			const twice = btoa('order-3');
			const first = await sendBlock({ from: user, previous: cursor.previous(user), to: other, amount: 3n, token: network.baseToken, network: network.network, idempotent: twice });
			const second = await sendBlock({ from: user, previous: first.hash, to: other, amount: 4n, token: network.baseToken, network: network.network, idempotent: twice });
			await expect(ledger.add(await confirmedStaple([first, second], network.representatives))).rejects.toMatchObject({ code: 'LEDGER_IDEMPOTENT_KEY_EXISTS' });
			expect(await headHash(ledger, user)).toBe(keyed.hash.toString());
			expect(await ledger.getIdempotentBlockHash(user, twice, 'main')).toBeNull();
		});

		test('history lists the staple for every touched account, newest first, exclusive start, unknown start empty', async function() {
			const { network, ledger } = await startNetwork();
			const first = requireAt(network.users, 0);
			const second = requireAt(network.users, 1);
			const third = requireAt(network.users, 2);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const firstToSecond = await confirmedStaple([cursor.append(await sendBlock({ from: first, previous: cursor.previous(first), to: second, amount: 1n, token: network.baseToken, network: network.network }))], network.representatives);
			const secondToThird = await confirmedStaple([cursor.append(await sendBlock({ from: second, previous: cursor.previous(second), to: third, amount: 1n, token: network.baseToken, network: network.network }))], network.representatives);
			const firstDelegates = await confirmedStaple([cursor.append(await setRepresentativeBlock({ account: first, representative: requireAt(network.representatives, 2), previous: cursor.previous(first), network: network.network }))], network.representatives);
			for (const staple of [firstToSecond, secondToThird, firstDelegates]) {
				advanceClock(1000);
				await ledger.add(staple);
			}
			const unknown = await confirmedStaple([await sendBlock({ from: third, previous: cursor.previous(third), to: first, amount: 1n, token: network.baseToken, network: network.network })], network.representatives);

			expect(blocksHashesOf(await ledger.getHistory(first, null))).toEqual(blocksHashesOf([firstDelegates, firstToSecond, network.genesis]));
			expect(blocksHashesOf(await ledger.getHistory(second, null))).toEqual(blocksHashesOf([secondToThird, firstToSecond, network.genesis]));
			expect(blocksHashesOf(await ledger.getHistory(third, null))).toEqual(blocksHashesOf([secondToThird, network.genesis]));
			expect(blocksHashesOf(await ledger.getHistory(null, null))).toEqual(blocksHashesOf([firstDelegates, secondToThird, firstToSecond, network.genesis]));
			// A delegation does not touch the representative it names.
			expect(await ledger.getHistory(requireAt(network.representatives, 2), null)).toEqual([]);

			expect(blocksHashesOf(await ledger.getHistory(first, null, 2))).toEqual(blocksHashesOf([firstDelegates, firstToSecond]));
			expect(blocksHashesOf(await ledger.getHistory(first, firstDelegates.blocksHash, 1))).toEqual(blocksHashesOf([firstToSecond]));
			expect(blocksHashesOf(await ledger.getHistory(first, firstToSecond.blocksHash))).toEqual(blocksHashesOf([network.genesis]));
			expect(await ledger.getHistory(first, network.genesis.blocksHash)).toEqual([]);
			expect(blocksHashesOf(await ledger.getHistory(null, secondToThird.blocksHash, 1))).toEqual(blocksHashesOf([firstToSecond]));
			expect(await ledger.getHistory(first, unknown.blocksHash)).toEqual([]);
			expect(await ledger.getHistory(null, unknown.blocksHash)).toEqual([]);
			// A staple the account is not part of is unknown to that account's history.
			expect(await ledger.getHistory(first, secondToThird.blocksHash)).toEqual([]);
		});

		test('getVotesAfter pages on staple boundaries', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const earlier = await confirmedStaple([cursor.append(await sendBlock({ from: user, previous: cursor.previous(user), to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, network: network.network }))], network.representatives);
			const later = await confirmedStaple([cursor.append(await sendBlock({ from: user, previous: cursor.previous(user), to: requireAt(network.users, 2), amount: 1n, token: network.baseToken, network: network.network }))], network.representatives);
			advanceClock(1000);
			const earlierMoment = new Date(Date.now());
			await ledger.add(earlier);
			advanceClock(1000);
			const laterMoment = new Date(Date.now());
			await ledger.add(later);

			const pages = await readStorage(storage, async function(transaction) {
				const first = await storage.getVotesAfter(transaction, earlierMoment, undefined, { maxVotesPerPage: 1 });
				const second = await storage.getVotesAfter(transaction, earlierMoment, first.nextKey, { maxVotesPerPage: 1 });
				return({
					first,
					second,
					fromLater: await storage.getVotesAfter(transaction, laterMoment, undefined, { maxVotesPerPage: 1 }),
					afterAll: await storage.getVotesAfter(transaction, new Date(laterMoment.getTime() + 1), undefined, { maxVotesPerPage: 1 }),
					everything: await storage.getVotesAfter(transaction, GENESIS_MOMENT, undefined, { maxVotesPerPage: 200 })
				});
			});
			expect(staplesOfPage(pages.first)).toEqual(Array<string>(3).fill(earlier.blocksHash.toString()));
			expect(pages.first.nextKey).toBeTypeOf('string');
			expect(staplesOfPage(pages.second)).toEqual(Array<string>(3).fill(later.blocksHash.toString()));
			expect(Object.hasOwn(pages.second, 'nextKey')).toBe(false);
			expect(staplesOfPage(pages.fromLater)).toEqual(Array<string>(3).fill(later.blocksHash.toString()));
			expect(Object.hasOwn(pages.fromLater, 'nextKey')).toBe(false);
			expect(pages.afterAll.votes).toEqual([]);
			expect(Object.hasOwn(pages.afterAll, 'nextKey')).toBe(false);
			expect(pages.everything.votes).toHaveLength(network.genesis.votes.length + 6);
			expect(Object.hasOwn(pages.everything, 'nextKey')).toBe(false);

			const staples = await ledger.getVoteStaplesAfter(GENESIS_MOMENT, 1000, { maxVotesPerPage: 1 });
			expect(blocksHashesOf(staples)).toEqual(blocksHashesOf([network.genesis, earlier, later]));
		});

		test('fork in confirmed history is rejected with LEDGER_PREVIOUS_ALREADY_USED', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const other = requireAt(network.users, 1);
			const genesisHead = headOf(network.genesis, user);
			await ledger.add(network.genesis);
			const kept = await sendBlock({ from: user, previous: genesisHead, to: other, amount: 5n, token: network.baseToken, network: network.network });
			const fork = await sendBlock({ from: user, previous: genesisHead, to: other, amount: 7n, token: network.baseToken, network: network.network });
			const reopened = await sendBlock({ from: user, previous: null, to: other, amount: 9n, token: network.baseToken, network: network.network });
			const twin = await sendBlock({ from: other, previous: headOf(network.genesis, other), to: user, amount: 1n, token: network.baseToken, network: network.network });
			const twinFork = await sendBlock({ from: other, previous: headOf(network.genesis, other), to: user, amount: 2n, token: network.baseToken, network: network.network });
			await ledger.add(await confirmedStaple([kept], network.representatives));

			for (const conflicting of [[fork], [reopened], [twin, twinFork]]) {
				await expect(ledger.add(await confirmedStaple(conflicting, network.representatives))).rejects.toMatchObject({ code: 'LEDGER_PREVIOUS_ALREADY_USED', shouldRetry: false });
			}

			expect(await headHash(ledger, user)).toBe(kept.hash.toString());
			expect(await headHash(ledger, other)).toBe(headOf(network.genesis, other).toString());
			expect((await ledger.getBlockFromPrevious(genesisHead, 'main'))?.hash.toString()).toBe(kept.hash.toString());
			expect(await ledger.getBlock(fork.hash, 'main')).toBeNull();
			expect(await ledger.getBalance(user, network.baseToken)).toBe(395n);
			expect(await ledger.getBalance(other, network.baseToken)).toBe(305n);
		});

		// The ledger refuses duplicates and forks before persisting, so only a direct call shows that the write itself refuses them.
		test('persisting never overwrites a confirmed block or successor', async function() {
			const { network, storage, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const other = requireAt(network.users, 1);
			const genesisHead = headOf(network.genesis, user);
			await ledger.add(network.genesis);
			const kept = await sendBlock({ from: user, previous: genesisHead, to: other, amount: 5n, token: network.baseToken, network: network.network });
			const fork = await sendBlock({ from: user, previous: genesisHead, to: other, amount: 7n, token: network.baseToken, network: network.network });
			const keptStaple = await confirmedStaple([kept], network.representatives);
			const forkStaple = await confirmedStaple([fork], network.representatives);
			await ledger.add(keptStaple);
			const keptHeight = (await ledger.getAccountsBlockHeightInfo([{ account: user }]))[user.publicKeyString.get()]?.height;
			if (keptHeight === undefined || keptHeight === null) {
				throw(new Error('the kept block has no height'));
			}

			const transaction = await storage.beginTransaction({ identifier: 'suite-persist-probe', readOnly: false });
			try {
				const changeAtKeptHeight = function(staple: VoteStaple): Promise<ConfirmedStapleChange> {
					return(computeConfirmedStapleChange({
						transaction,
						staple,
						effects: LedgerInternals.computeEffectOfBlocks(staple.blocks, ledger),
						blockHeights: new Map(staple.blocks.map(function(block) {
							return([toBlockHashKey(block.hash), keptHeight]);
						})),
						storage,
						network: network.network,
						baseToken: network.baseToken,
						moment: transaction.moment
					}));
				};
				const hooks = storage._Testing(TESTING_KEY);

				await expect(hooks.persist(transaction, await changeAtKeptHeight(keptStaple))).rejects.toMatchObject({ code: 'LEDGER_BLOCK_ALREADY_EXISTS', shouldRetry: false });
				await expect(hooks.persist(transaction, await changeAtKeptHeight(forkStaple))).rejects.toMatchObject({ code: 'LEDGER_PREVIOUS_ALREADY_USED', shouldRetry: false });

				// A refused change leaves nothing behind in the transaction.
				expect(await storage.getBlock(transaction, fork.hash, 'main')).toBeNull();
				expect((await storage.getBlockFromPrevious(transaction, genesisHead, 'main'))?.hash.toString()).toBe(kept.hash.toString());
				expect((await storage.getVoteStaples(transaction, [forkStaple.blocksHash], 'main')).get(forkStaple.blocksHash)).toBeNull();
				expect(await storage.getBalance(transaction, user, network.baseToken)).toBe(395n);
				expect(await storage.getBalance(transaction, other, network.baseToken)).toBe(305n);
				expect((await storage.getHistory(transaction, user, null, 25)).map(String)).toEqual(blocksHashesOf([keptStaple, network.genesis]));
			} finally {
				await storage.abortTransaction(transaction);
			}
		});

		test('a cross-account funding gap stores a negative balance that heals', async function() {
			const { network, storage, ledger } = await startNetwork();
			const sponsor = requireAt(network.users, 0);
			const payee = requireAt(network.users, 1);
			const newcomer = newcomerAccount();
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const funding = await confirmedStaple([cursor.append(await sendBlock({ from: sponsor, previous: cursor.previous(sponsor), to: newcomer, amount: 50n, token: network.baseToken, network: network.network }))], network.representatives);
			const spending = await confirmedStaple([cursor.append(await sendBlock({ from: newcomer, previous: cursor.previous(newcomer), to: payee, amount: 20n, token: network.baseToken, network: network.network }))], network.representatives);

			// The spend is on the newcomer's own chain, so nothing defers it.
			expect(blocksHashesOf(await ledger.add(spending))).toEqual(blocksHashesOf([spending]));
			const stored = await readStorage(storage, async function(transaction) {
				return(await storage.getBalance(transaction, newcomer, network.baseToken));
			});
			expect(stored).toBe(-20n);
			// Upstream's ledger interface refuses to report a negative balance; the driver stores it as computed.
			await expect(ledger.getBalance(newcomer, network.baseToken)).rejects.toThrow('negative balance');
			expect(await ledger.getBalance(payee, network.baseToken)).toBe(320n);

			await ledger.add(funding);

			expect(await ledger.getBalance(newcomer, network.baseToken)).toBe(30n);
			expect(await ledger.getBalance(sponsor, network.baseToken)).toBe(350n);
			expect(await ledger.votingPower()).toBe(970n);
		});

		test('map reads return every requested key with null for absent', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const newcomer = newcomerAccount();
			const second = requireAt(network.representatives, 1);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = cursor.append(await sendBlock({ from: user, previous: cursor.previous(user), to: newcomer, amount: 1n, token: network.baseToken, network: network.network }));
			const staple = await confirmedStaple([send], network.representatives);
			await ledger.add(staple);
			const absentBlock = await sendBlock({ from: newcomer, previous: null, to: user, amount: 1n, token: network.baseToken, network: network.network });
			const absentStaple = await confirmedStaple([absentBlock], network.representatives);

			const heads = await ledger.getHeadBlocks([user, newcomer], 'main');
			expect(Object.keys(heads).sort()).toEqual(publicKeysOf([user, newcomer]).sort());
			expect(heads[user.publicKeyString.get()]?.hash.toString()).toBe(send.hash.toString());
			expect(heads[newcomer.publicKeyString.get()]).toBeNull();

			const staples = await ledger.getVoteStaples([staple.blocksHash, absentStaple.blocksHash], 'main');
			expect(staples.size).toBe(2);
			expect(staples.get(staple.blocksHash)?.blocksHash.toString()).toBe(staple.blocksHash.toString());
			expect(blockHashesOf([staples.get(staple.blocksHash) ?? absentStaple])).toEqual([send.hash.toString()]);
			expect(staples.get(absentStaple.blocksHash)).toBeNull();

			const successorVotes = await ledger.getVotesFromMultiplePrevious([genesisHead, absentBlock.hash], 'main');
			expect(Object.keys(successorVotes).sort()).toEqual([genesisHead.toString(), absentBlock.hash.toString()].sort());
			expect(successorVotes[genesisHead.toString()]?.map(function(vote): string {
				return(vote.$uid);
			}).sort()).toEqual(staple.votes.map(function(vote): string {
				return(vote.$uid);
			}).sort());
			expect(successorVotes[absentBlock.hash.toString()] ?? null).toBeNull();
			const fromSecond = await ledger.getVotesFromMultiplePrevious([genesisHead], 'main', second);
			expect(publicKeysOf(fromSecond[genesisHead.toString()]?.map(function(vote) {
				return(vote.issuer);
			}) ?? [])).toEqual([second.publicKeyString.get()]);

			expect(await ledger.getVotes(absentBlock.hash, 'main')).toBeNull();
			expect(await ledger.getBlock(absentBlock.hash, 'main')).toBeNull();
			expect(await ledger.getBlockFromPrevious(send.hash, 'main')).toBeNull();
			const heights = await ledger.getAccountsBlockHeightInfo([{ account: newcomer }, { account: user }]);
			expect(heights[newcomer.publicKeyString.get()]).toBeNull();
			expect(heights[user.publicKeyString.get()]?.height).toBe(chainLengthOf(network.genesis, user));
		});

		test('successor votes filtered to a representative outside the confirming quorum are null', async function() {
			const { network, ledger } = await startNetwork();
			const user = requireAt(network.users, 0);
			const [first, second, leftOut] = network.representatives;
			if (first === undefined || second === undefined || leftOut === undefined) {
				throw(new Error('three representatives expected'));
			}
			await ledger.add(network.genesis);
			const genesisHead = headOf(network.genesis, user);
			const send = await sendBlock({ from: user, previous: genesisHead, to: requireAt(network.users, 1), amount: 1n, token: network.baseToken, network: network.network });
			// 400 and 300 of 1000 are a quorum without the third representative.
			await ledger.add(await confirmedStaple([send], [first, second]));

			expect(await ledger.getVotesFromMultiplePrevious([genesisHead], 'main', leftOut)).toEqual({ [genesisHead.toString()]: null });
			expect(await ledger.getVotesFromMultiplePrevious([genesisHead], 'both', leftOut)).toEqual({ [genesisHead.toString()]: null });
			expect(publicKeysOf((await ledger.getVotesFromMultiplePrevious([genesisHead], 'main', second))[genesisHead.toString()]?.map(function(vote) {
				return(vote.issuer);
			}) ?? [])).toEqual([second.publicKeyString.get()]);
		});

		test('an ACL granted to a certificate this node lacks is rejected', async function() {
			const { network, ledger } = await startNetwork();
			const entity = requireAt(network.users, 0);
			const holder = requireAt(network.users, 1);
			const cursor = new ChainCursor(network.genesis);
			await ledger.add(network.genesis);
			const certificate = await certificateFor(holder, 7);
			const principal = { usingCertificate: true, certificateHash: certificate.hash(), certificateAccount: holder } as const;
			const grant = await confirmedStaple([await modifyPermissionsBlock({ account: entity, previous: cursor.previous(entity), network: network.network, principal, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['ACCESS']) })], network.representatives);

			await expect(ledger.add(grant)).rejects.toMatchObject({ code: 'LEDGER_CERTIFICATE_NOT_FOUND', shouldRetry: false });
			expect(await headHash(ledger, entity)).toBe(headOf(network.genesis, entity).toString());
			expect(await ledger.listACLsByEntity(entity)).toEqual([]);

			const held = cursor.append(await manageCertificateBlock({ account: holder, previous: cursor.previous(holder), network: network.network, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate }));
			await ledger.add(await confirmedStaple([held], network.representatives));
			await ledger.add(grant);

			const expected = {
				principal: `${certificate.hash().toString()}:${holder.publicKeyString.get()}`,
				entity: entity.publicKeyString.get(),
				target: entity.publicKeyString.get(),
				permissions: permissionsOf(['ACCESS'])
			};
			expect((await ledger.listACLsByEntity(entity, { principalType: 'CERTIFICATE' })).map(summarizeACL)).toEqual([expected]);
			expect(await ledger.listACLsByEntity(entity, { principalType: 'ACCOUNT' })).toEqual([]);
			expect((await ledger.listACLsByPrincipal({ usingCertificate: true, certificate: certificate.hash(), certificateAccount: holder })).map(summarizeACL)).toEqual([expected]);
		});
	});
}
