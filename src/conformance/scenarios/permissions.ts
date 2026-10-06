import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, MultisigAddress, StorageAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockJSONOperationMODIFY_PERMISSIONS } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import type { ChainCursor } from '../../ledger/storage/suite/support.js';
import {
	createMultisigBlock,
	createStorageBlock,
	feeBlock,
	manageCertificateBlock,
	modifyPermissionsBlock,
	multisigSendBlock,
	operationsBlock,
	sendBlock,
	setInfoBlock,
	setRepresentativeBlock,
	tokenSupplyBlock
} from '../../testing/blocks.js';
import { TEST_NETWORK_SEEDS } from '../../testing/network.js';
import { toDecimal } from '../case.js';
import { scenario } from '../record.js';
import type { CaseRecorder, RecordingOptions, Scenario } from '../record.js';
import { HOUR, MAXIMUM_SUPPLY, NEGATIVE_AMOUNTS_REFUSED_FROM, chainsOf, confirmed, issueToken } from './support.js';
import type { PublishedToken, TokenOptions } from './support.js';

/*
 * Whether the signers of a request may do what its blocks do. Every
 * operation adds requirements: what its signer needs on the account, and
 * what the accounts involved need on each other. A requirement is met by an
 * earlier grant in the same request, by the entity's default permission,
 * or by a stored ACL row, which overrides the default. The checks run in a
 * fixed order: the operations themselves, then the requirements, then the
 * owner count of every identifier whose owners changed, then the effect on
 * balances and supplies.
 * [Keeta TS] index.js:68032-68076, 68605-68661, 69881-69946, 69989-70095
 */

const lib = KeetaNet.lib;

type Certificate = InstanceType<typeof lib.Utils.Certificate.Certificate>;

type PermissionFlags = ConstructorParameters<typeof lib.Permissions>[0];

const DAY = 24 * HOUR;

const FLAT_FEE = 5n;

const CHARGING: RecordingOptions = { fee: { type: 'flat', amount: toDecimal(FLAT_FEE) } };

// The network's default once T3 narrows it, without TOKEN_ADMIN_CREATE.
const NARROWED_NETWORK_DEFAULT: PermissionFlags = ['ACCESS', 'STORAGE_CREATE'];

/** Keys after the network's own users, from the same seed, that only ever sign for a multisig. */
function extraKey(recorder: CaseRecorder, index: number): Account {
	return(lib.Account.fromSeed(TEST_NETWORK_SEEDS.user, recorder.network.users.length + index));
}

/** `account` changes the permissions of `principal` on itself; an identifier's owner, user 0, signs for it. */
function permissionChange(recorder: CaseRecorder, chains: ChainCursor, account: GenericAccount, change: Omit<BlockJSONOperationMODIFY_PERMISSIONS, 'type'>): Promise<Block> {
	const input = { account, previous: chains.previous(account), network: recorder.network.network, ...change };
	if (account.isIdentifier()) {
		return(modifyPermissionsBlock({ ...input, signer: recorder.user(0) }));
	}
	return(modifyPermissionsBlock(input));
}

/** `from` sends one unit of the base token unless stated, signed by `signer` when given and by its own key otherwise. */
function sendAfter(recorder: CaseRecorder, chains: ChainCursor, from: GenericAccount, options: { readonly to: GenericAccount; readonly amount?: bigint; readonly token?: TokenAddress; readonly signer?: Account }): Promise<Block> {
	const { to, amount = 1n, token = recorder.network.baseToken, signer } = options;
	const input = { from, to, amount, token, previous: chains.previous(from), network: recorder.network.network };
	if (signer !== undefined) {
		return(sendBlock({ ...input, signer }));
	}
	return(sendBlock(input));
}

/** The victim grants the principal SEND_ON_BEHALF of every token, with no target. */
function wildcardSendOnBehalf(recorder: CaseRecorder, chains: ChainCursor, victim: GenericAccount, principal: GenericAccount): Promise<Block> {
	return(permissionChange(recorder, chains, victim, { principal, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['SEND_ON_BEHALF']) }));
}

/** The victim adds or removes the principal's SEND_ON_BEHALF of a token, by default the base token, on its own account. */
function sendOnBehalf(recorder: CaseRecorder, chains: ChainCursor, victim: GenericAccount, principal: GenericAccount, method: BlockJSONOperationMODIFY_PERMISSIONS['method'], target: TokenAddress = recorder.network.baseToken): Promise<Block> {
	return(permissionChange(recorder, chains, victim, { principal, method, permissions: new lib.Permissions(['SEND_ON_BEHALF']), target }));
}

/**
 * User 0 owns a token with a supply of 100 and the default permission given,
 * and the token sends user 0 half of it; all of it, and any further blocks,
 * added on each node given together with genesis.
 */
async function heldToken(recorder: CaseRecorder, nodes: readonly number[], defaultPermission: TokenOptions['defaultPermission'], further?: (published: PublishedToken) => Promise<readonly Block[]>): Promise<PublishedToken> {
	await recorder.addGenesis(...nodes);
	const chains = chainsOf(recorder);
	const { token, blocks } = await issueToken(recorder, chains, recorder.user(0), { supply: 100n, defaultPermission });
	const published = { token, chains };
	const owner = recorder.user(0);
	const allocation = chains.append(await sendAfter(recorder, chains, token, { to: owner, amount: 50n, token, signer: owner }));
	const more = await further?.(published) ?? [];
	const staple = await confirmed(recorder, [...blocks, allocation, ...more]);
	for (const node of nodes) {
		await recorder.add(node, staple);
	}
	return(published);
}

/** A storage account of user 0's, added on node 0 together with genesis. */
async function publishedStorage(recorder: CaseRecorder): Promise<{ readonly storage: StorageAddress; readonly chains: ChainCursor }> {
	await recorder.addGenesis(0);
	const chains = chainsOf(recorder);
	const owner = recorder.user(0);
	const { block, storage } = await createStorageBlock({ owner, previous: chains.previous(owner), network: recorder.network.network });
	await recorder.add(0, await confirmed(recorder, [chains.append(block)]));
	return({ storage, chains });
}

/** The storage account admits holding a token. */
function canHold(recorder: CaseRecorder, chains: ChainCursor, storage: StorageAddress, token: TokenAddress): Promise<Block> {
	return(permissionChange(recorder, chains, storage, { principal: token, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['STORAGE_CAN_HOLD']) }));
}

/** The storage account admits a depositor's deposits of a token. */
function mayDeposit(recorder: CaseRecorder, chains: ChainCursor, storage: StorageAddress, depositor: GenericAccount, token: TokenAddress): Promise<Block> {
	return(permissionChange(recorder, chains, storage, { principal: depositor, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['STORAGE_DEPOSIT']), target: token }));
}

/** The storage account admits the base token, and user 1's deposits of it. */
async function storageGrants(recorder: CaseRecorder, chains: ChainCursor, storage: StorageAddress): Promise<readonly Block[]> {
	const { baseToken } = recorder.network;
	return([
		chains.append(await canHold(recorder, chains, storage, baseToken)),
		chains.append(await mayDeposit(recorder, chains, storage, recorder.user(1), baseToken))
	]);
}

/** A change of the token's owners, signed by user 0, its owner. */
function ownerChange(recorder: CaseRecorder, { token, chains }: PublishedToken, changes: readonly Omit<BlockJSONOperationMODIFY_PERMISSIONS, 'type'>[]): Promise<Block> {
	return(operationsBlock({
		account: token,
		signer: recorder.user(0),
		previous: chains.previous(token),
		network: recorder.network.network,
		operations: changes.map(function(change) {
			return({ type: lib.Block.OperationType.MODIFY_PERMISSIONS, ...change });
		})
	}));
}

function setOwner(principal: GenericAccount): Omit<BlockJSONOperationMODIFY_PERMISSIONS, 'type'> {
	return({ principal, method: lib.Block.AdjustMethod.SET, permissions: new lib.Permissions(['OWNER']) });
}

/** The token sets user 1's ACL row to no permissions at all. */
function freeze(recorder: CaseRecorder, { token, chains }: PublishedToken): Promise<Block> {
	return(permissionChange(recorder, chains, token, { principal: recorder.user(1), method: lib.Block.AdjustMethod.SET, permissions: new lib.Permissions([]) }));
}

function removeAll(principal: GenericAccount): Omit<BlockJSONOperationMODIFY_PERMISSIONS, 'type'> {
	return({ principal, method: lib.Block.AdjustMethod.SET, permissions: null });
}

/** A certificate valid from a day before the case starts, for the days given. */
function certificate(issuer: Account, subject: Account, serial: number, days: number): Promise<Certificate> {
	const start = Date.now();
	return(new lib.Utils.Certificate.CertificateBuilder({
		issuer,
		validFrom: new Date(start - DAY),
		validTo: new Date(start + (days * DAY)),
		serial
	}).build({ subjectPublicKey: subject }));
}

/** The account stores a certificate whose subject it is. */
function storeCertificate(recorder: CaseRecorder, chains: ChainCursor, account: Account, held: Certificate): Promise<Block> {
	return(manageCertificateBlock({ account, previous: chains.previous(account), network: recorder.network.network, method: lib.Block.AdjustMethod.ADD, certificateOrHash: held }));
}

/** The token grants ACCESS to every holder of a certificate that chains to `authority`, held by user 2. */
function certificateGrant(recorder: CaseRecorder, { token, chains }: PublishedToken, authority: Certificate): Promise<Block> {
	return(permissionChange(recorder, chains, token, {
		principal: { usingCertificate: true, certificateHash: authority.hash(), certificateAccount: recorder.user(2) },
		method: lib.Block.AdjustMethod.ADD,
		permissions: new lib.Permissions(['ACCESS'])
	}));
}

/** An account that holds a certificate the authority issued, valid for the days given. */
type CertifiedHolder = {
	readonly holder: Account;
	readonly days: number;
};

/**
 * User 2 is a certificate authority, each holder holds a certificate it
 * issued, and a token without a default permission admits that
 * certificate's holders; added on each node given.
 */
async function certifiedHolders(recorder: CaseRecorder, nodes: readonly number[], holders: readonly CertifiedHolder[]): Promise<PublishedToken> {
	const authorityKey = recorder.user(2);
	const authority = await certificate(authorityKey, authorityKey, 1, 3650);
	const published = await heldToken(recorder, nodes, []);
	const { chains } = published;
	const stored = [chains.append(await storeCertificate(recorder, chains, authorityKey, authority))];
	for (const [index, { holder, days }] of holders.entries()) {
		stored.push(chains.append(await storeCertificate(recorder, chains, holder, await certificate(authorityKey, holder, 2 + index, days))));
	}
	const held = await confirmed(recorder, stored);
	/*
	 * The effect of an ACL for a certificate looks the certificate up in
	 * storage, so the certificate is stored by an earlier staple.
	 * [Keeta TS] index.js:67233-67239, 67456-67460
	 */
	const granted = await confirmed(recorder, [chains.append(await certificateGrant(recorder, published, authority))]);
	for (const node of nodes) {
		await recorder.add(node, held);
		await recorder.add(node, granted);
	}
	return(published);
}

/** A multisig of three extra keys with a quorum of two, created by user 2. */
async function multisigOf(recorder: CaseRecorder, chains: ChainCursor): Promise<{ readonly block: Block; readonly multisig: MultisigAddress }> {
	const creator = recorder.user(2);
	const { block, multisig } = await createMultisigBlock({
		owner: creator,
		signers: [extraKey(recorder, 0), extraKey(recorder, 1), extraKey(recorder, 2)],
		quorum: 2n,
		previous: chains.previous(creator),
		network: recorder.network.network
	});
	return({ block: chains.append(block), multisig });
}

/**
 * A multisig signs user 0's send to user 1 through the signers given; with
 * `granted`, user 0 has given the multisig SEND_ON_BEHALF first.
 */
async function multisigSend(recorder: CaseRecorder, granted: boolean, signers: readonly Account[]): Promise<void> {
	await recorder.addGenesis(0);
	const chains = chainsOf(recorder);
	const victim = recorder.user(0);
	const { block, multisig } = await multisigOf(recorder, chains);
	const setup = [block];
	if (granted) {
		setup.push(chains.append(await sendOnBehalf(recorder, chains, victim, multisig, lib.Block.AdjustMethod.ADD)));
	}
	await recorder.add(0, await confirmed(recorder, setup));
	await recorder.vote(0, [await multisigSendBlock({
		from: victim,
		signer: [multisig, [...signers]],
		to: recorder.user(1),
		amount: 1n,
		token: recorder.network.baseToken,
		previous: chains.previous(victim),
		network: recorder.network.network
	})]);
}

/**
 * User 0 sends user 1 a token that has no default permission and that
 * granted user 1 ACCESS, and representatives 0 and 1 give temporary votes.
 * The grant is then removed on node 0, which is asked for a permanent vote;
 * with a fee block, which the permanent request adds, node 1, which never
 * saw the removal, is asked too.
 */
async function revokedBetweenVotes(recorder: CaseRecorder, withFee: boolean): Promise<void> {
	const recipient = recorder.user(1);
	const published = await heldToken(recorder, [0, 1], [], async function({ token, chains }) {
		return([chains.append(await permissionChange(recorder, chains, token, { principal: recipient, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['ACCESS']) }))]);
	});
	const { token, chains } = published;
	const sent = chains.append(await sendAfter(recorder, chains, recorder.user(0), { to: recipient, token }));
	const temporary = [await recorder.vote(0, [sent]), await recorder.vote(1, [sent])];
	const blocks = [sent];
	if (withFee) {
		blocks.push(await feeBlock({
			from: recorder.user(0),
			previous: sent.hash,
			network: recorder.network.network,
			payments: [0, 1].map(function(representative) {
				return({ to: recorder.representative(representative), token: recorder.network.baseToken, amount: FLAT_FEE });
			})
		}));
	}
	await recorder.add(0, await confirmed(recorder, [await permissionChange(recorder, chains, token, removeAll(recipient))]));
	await recorder.vote(0, blocks, temporary);
	if (withFee) {
		await recorder.vote(1, blocks, temporary);
	}
}

/** The trusted root narrows the network's default permission so that it no longer admits creating tokens. */
function narrowNetworkDefault(recorder: CaseRecorder): Promise<Block> {
	const { networkAddress, network, trustedSigner } = recorder.network;
	return(setInfoBlock({
		account: networkAddress,
		signer: trustedSigner,
		previous: recorder.genesisHead(networkAddress),
		network,
		name: 'KEETANET',
		description: 'Network Address For KeetaNet',
		metadata: '',
		defaultPermission: new lib.Permissions(NARROWED_NETWORK_DEFAULT)
	}));
}

/** One more unit of the base token for user 0, as genesis grants balances, signed by the key given. */
function modifyBalance(recorder: CaseRecorder, signer: Account): Promise<Block> {
	const account = recorder.user(0);
	return(operationsBlock({
		account,
		signer,
		previous: recorder.genesisHead(account),
		network: recorder.network.network,
		operations: [{ type: lib.Block.OperationType.TOKEN_ADMIN_MODIFY_BALANCE, token: recorder.network.baseToken, amount: 1n, method: lib.Block.AdjustMethod.ADD }]
	}));
}

/** The base token's opening block, signed by the key given. */
function baseTokenOpening(recorder: CaseRecorder, signer: Account): Promise<Block> {
	return(setInfoBlock({
		account: recorder.network.baseToken,
		signer,
		previous: null,
		network: recorder.network.network,
		name: 'TEST',
		description: 'Test Token',
		metadata: '',
		defaultPermission: new lib.Permissions(['ACCESS'])
	}));
}

export const permissionScenarios: readonly Scenario[] = [
	scenario('PM1', 'a block signed by a key without rights on the account is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		await recorder.vote(0, [await sendAfter(recorder, chainsOf(recorder), victim, { to: thief, amount: 100n, signer: thief })]);
	}),
	scenario('PM2', 'a block signed by a key the account granted SEND_ON_BEHALF of the token gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		await recorder.add(0, await confirmed(recorder, [chains.append(await sendOnBehalf(recorder, chains, victim, thief, lib.Block.AdjustMethod.ADD))]));
		await recorder.vote(0, [await sendAfter(recorder, chains, victim, { to: thief, amount: 100n, signer: thief })]);
	}),
	/*
	 * A row without a target covers every token: an exact target match is
	 * preferred, and a row whose target is the account itself is the fallback.
	 * [Keeta TS] index.js:67109-67132
	 */
	scenario('PM2b', 'SEND_ON_BEHALF granted without a target covers a send of the base token', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		await recorder.add(0, await confirmed(recorder, [chains.append(await wildcardSendOnBehalf(recorder, chains, victim, thief))]));
		await recorder.vote(0, [await sendAfter(recorder, chains, victim, { to: thief, amount: 100n, signer: thief })]);
	}),
	scenario('PM3', 'SEND_ON_BEHALF granted for another token does not cover a send of the base token', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		const otherToken = recorder.user(2).generateIdentifier(lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0);
		await recorder.add(0, await confirmed(recorder, [chains.append(await sendOnBehalf(recorder, chains, victim, thief, lib.Block.AdjustMethod.ADD, otherToken))]));
		await recorder.vote(0, [await sendAfter(recorder, chains, victim, { to: thief, amount: 100n, signer: thief })]);
	}),
	scenario('PM4', 'a grant earlier in the same request covers a block signed by the grantee', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		const grant = chains.append(await sendOnBehalf(recorder, chains, victim, thief, lib.Block.AdjustMethod.ADD));
		await recorder.vote(0, [grant, await sendAfter(recorder, chains, victim, { to: thief, amount: 100n, signer: thief })]);
	}),
	/*
	 * A grant earlier in the request without a target applies to the whole
	 * account, so it covers a requirement for any token.
	 * [Keeta TS] index.js:68050-68057
	 */
	scenario('PM4b', 'SEND_ON_BEHALF granted without a target earlier in the same request covers a send of the base token', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		const grant = chains.append(await wildcardSendOnBehalf(recorder, chains, victim, thief));
		await recorder.vote(0, [grant, await sendAfter(recorder, chains, victim, { to: thief, amount: 100n, signer: thief })]);
	}),
	/*
	 * A grant satisfies a requirement only when it is on the account the
	 * requirement is for.
	 * [Keeta TS] index.js:68044-68049
	 */
	scenario('PM5', 'a grant of SEND_ON_BEHALF to oneself on one\'s own account does not cover signing another account\'s send in the same request', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		const selfGrant = chains.append(await sendOnBehalf(recorder, chains, thief, thief, lib.Block.AdjustMethod.ADD));
		const drain = await sendAfter(recorder, chains, victim, { to: thief, amount: 100n, signer: thief });
		await recorder.vote(0, [selfGrant, drain]);
		// The self-grant alone is acceptable, so the refusal is the drain's.
		await recorder.vote(0, [selfGrant]);
		// The victim's own grant in the request authorizes the same kind of drain.
		const grant = chains.append(await sendOnBehalf(recorder, chains, victim, thief, lib.Block.AdjustMethod.ADD));
		await recorder.vote(0, [grant, await sendAfter(recorder, chains, victim, { to: thief, amount: 100n, signer: thief })]);
	}),
	/*
	 * The victim's removal of the flag from the thief matches the drain's
	 * requirement in its account, principal, target and flag, and differs
	 * only in its method, so only the method check refuses it.
	 * [Keeta TS] index.js:68035-68043
	 */
	scenario('PM6', 'removing SEND_ON_BEHALF from a key earlier in the request does not let that key sign the account\'s send', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		const removal = chains.append(await sendOnBehalf(recorder, chains, victim, thief, lib.Block.AdjustMethod.SUBTRACT));
		await recorder.vote(0, [removal, await sendAfter(recorder, chains, victim, { to: thief, amount: 100n, signer: thief })]);
		// The removal alone is acceptable, so the refusal is the drain's.
		await recorder.vote(0, [removal]);
	}),
	/*
	 * A token's send of itself skips the token's own ACCESS requirement and
	 * must still meet the storage account's.
	 * [Keeta TS] index.js:68461-68491, 68646-68648
	 */
	scenario('S4', 'a token\'s send of itself into a storage account needs the storage account\'s grants like any other', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const owner = recorder.user(0);
		const { token, blocks } = await issueToken(recorder, chains, owner, { supply: 100n, defaultPermission: ['ACCESS'] });
		const created = await createStorageBlock({ owner, previous: chains.previous(owner), network: recorder.network.network });
		const { storage } = created;
		await recorder.add(0, await confirmed(recorder, [...blocks, chains.append(created.block)]));
		const deposit = await sendAfter(recorder, chains, token, { to: storage, amount: 10n, token, signer: owner });
		await recorder.vote(0, [deposit]);
		// Holding alone is not enough: the token's deposits must be admitted too.
		await recorder.add(0, await confirmed(recorder, [chains.append(await canHold(recorder, chains, storage, token))]));
		await recorder.vote(0, [deposit]);
		await recorder.add(0, await confirmed(recorder, [chains.append(await mayDeposit(recorder, chains, storage, token, token))]));
		await recorder.vote(0, [deposit]);
	}),
	scenario('S2', 'a send into a storage account that granted nothing is refused', {}, async function(recorder) {
		const { storage, chains } = await publishedStorage(recorder);
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(1), { to: storage })]);
	}),
	scenario('S2b', 'a send into a storage account that admits the token but not the sender\'s deposits is refused', {}, async function(recorder) {
		const { storage, chains } = await publishedStorage(recorder);
		await recorder.add(0, await confirmed(recorder, [chains.append(await canHold(recorder, chains, storage, recorder.network.baseToken))]));
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(1), { to: storage })]);
	}),
	scenario('S2c', 'a send into a storage account that admits the sender\'s deposits but not the token is refused', {}, async function(recorder) {
		const { storage, chains } = await publishedStorage(recorder);
		await recorder.add(0, await confirmed(recorder, [chains.append(await mayDeposit(recorder, chains, storage, recorder.user(1), recorder.network.baseToken))]));
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(1), { to: storage })]);
	}),
	scenario('S3', 'a send into a storage account gets a temporary vote once its owner admits the token and the sender\'s deposits', {}, async function(recorder) {
		const { storage, chains } = await publishedStorage(recorder);
		await recorder.add(0, await confirmed(recorder, await storageGrants(recorder, chains, storage)));
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(1), { to: storage })]);
	}),
	scenario('S3b', 'the storage account\'s grants earlier in the same request admit the send', {}, async function(recorder) {
		const { storage, chains } = await publishedStorage(recorder);
		const grants = await storageGrants(recorder, chains, storage);
		await recorder.vote(0, [...grants, await sendAfter(recorder, chains, recorder.user(1), { to: storage })]);
	}),
	scenario('T1', 'creating a token and its opening block with info and supply in one request gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const { blocks } = await issueToken(recorder, chainsOf(recorder), recorder.user(0), { supply: 100n, defaultPermission: ['ACCESS'] });
		await recorder.vote(0, [...blocks]);
	}),
	scenario('T2', 'a token\'s opening block without its creation is refused', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const [, opening] = (await issueToken(recorder, chainsOf(recorder), recorder.user(0), { supply: 100n, defaultPermission: ['ACCESS'] })).blocks;
		await recorder.vote(0, [opening]);
	}),
	scenario('T3', 'creating a token is refused once the network\'s default permission no longer admits it', {}, async function(recorder) {
		await recorder.addGenesis(0, 1);
		const chains = chainsOf(recorder);
		const [creation] = (await issueToken(recorder, chains, recorder.user(0), { supply: 100n, defaultPermission: ['ACCESS'] })).blocks;
		await recorder.vote(1, [creation]);
		await recorder.add(0, await confirmed(recorder, [await narrowNetworkDefault(recorder)]));
		await recorder.vote(0, [creation]);
	}),
	scenario('T3b', 'a network default narrowed earlier in the same request does not refuse a creation the stored default admits', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const [creation] = (await issueToken(recorder, chainsOf(recorder), recorder.user(0), { supply: 100n, defaultPermission: ['ACCESS'] })).blocks;
		await recorder.vote(0, [await narrowNetworkDefault(recorder), creation]);
	}),
	scenario('T4', 'a mint signed by a key that does not own the token is refused', {}, async function(recorder) {
		const { token, chains } = await heldToken(recorder, [0], ['ACCESS']);
		await recorder.vote(0, [await tokenSupplyBlock({ owner: recorder.user(1), token, amount: 1n, previous: chains.previous(token), network: recorder.network.network })]);
	}),
	scenario('T8', 'a send of a token without a default permission to an account without an ACL row is refused', {}, async function(recorder) {
		const { token, chains } = await heldToken(recorder, [0], []);
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(0), { to: recorder.user(1), token })]);
	}),
	scenario('T10', 'storage contract D10: an ACL row emptied by a SET is stored, and overrides the token\'s default ACCESS', { basis: 'contract' }, async function(recorder) {
		const { token, chains } = await heldToken(recorder, [0], ['ACCESS'], async function(published) {
			return([published.chains.append(await freeze(recorder, published))]);
		});
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(0), { to: recorder.user(1), token })]);
	}),
	scenario('T10b', 'an ACL row emptied earlier in the same request does not refuse a send the stored default admits', {}, async function(recorder) {
		const { token, chains } = await heldToken(recorder, [0], ['ACCESS']);
		const frozen = chains.append(await freeze(recorder, { token, chains }));
		await recorder.vote(0, [frozen, await sendAfter(recorder, chains, recorder.user(0), { to: recorder.user(1), token })]);
	}),
	scenario('SI3', 'a default permission set earlier in the same request admits the send that needs it, which alone is refused', {}, async function(recorder) {
		const { token, chains } = await heldToken(recorder, [0], []);
		const owner = recorder.user(0);
		const sent = await sendAfter(recorder, chains, owner, { to: recorder.user(1), token });
		await recorder.vote(0, [sent]);
		const opened = await setInfoBlock({ account: token, signer: owner, previous: chains.previous(token), network: recorder.network.network, name: 'TOKEN', description: '', metadata: '', defaultPermission: new lib.Permissions(['ACCESS']) });
		await recorder.vote(0, [opened, sent]);
	}),
	scenario('MS1', 'a multisig granted SEND_ON_BEHALF signs through a quorum of its signers', {}, async function(recorder) {
		await multisigSend(recorder, true, [extraKey(recorder, 0), extraKey(recorder, 1)]);
	}),
	scenario('MS2', 'a multisig signing through fewer signers than its quorum is refused', {}, async function(recorder) {
		await multisigSend(recorder, true, [extraKey(recorder, 0)]);
	}),
	scenario('MS3', 'a multisig signing through a key that is not one of its signers is refused', {}, async function(recorder) {
		await multisigSend(recorder, true, [extraKey(recorder, 0), recorder.user(2)]);
	}),
	scenario('MS4', 'a multisig without a grant on the account is refused, though a quorum signs', {}, async function(recorder) {
		await multisigSend(recorder, false, [extraKey(recorder, 0), extraKey(recorder, 1)]);
	}),
	scenario('O1', 'making a second account an owner of a token is refused', {}, async function(recorder) {
		const published = await heldToken(recorder, [0], ['ACCESS']);
		await recorder.vote(0, [await ownerChange(recorder, published, [setOwner(recorder.user(1))])]);
	}),
	scenario('O2', 'handing a token\'s ownership to another account in one block gets a temporary vote', {}, async function(recorder) {
		const published = await heldToken(recorder, [0], ['ACCESS']);
		await recorder.vote(0, [await ownerChange(recorder, published, [setOwner(recorder.user(1)), removeAll(recorder.user(0))])]);
	}),
	scenario('O3', 'adding a flag other than OWNER to the sole owner counts as removing it, and is refused', {}, async function(recorder) {
		const published = await heldToken(recorder, [0], ['ACCESS']);
		await recorder.vote(0, [await ownerChange(recorder, published, [{ principal: recorder.user(0), method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['UPDATE_INFO']) }])]);
	}),
	scenario('O4', 'removing the sole owner of a token is refused', {}, async function(recorder) {
		const published = await heldToken(recorder, [0], ['ACCESS']);
		await recorder.vote(0, [await ownerChange(recorder, published, [removeAll(recorder.user(0))])]);
	}),
	scenario('CE3', 'an ACL for a certificate its account does not hold is refused', {}, async function(recorder) {
		const authorityKey = recorder.user(2);
		const published = await heldToken(recorder, [0], []);
		await recorder.vote(0, [await certificateGrant(recorder, published, await certificate(authorityKey, authorityKey, 1, 3650))]);
	}),
	scenario('CE3b', 'an ACL for a certificate that an earlier block of the same request stores is refused, since the certificate is looked up in storage', {}, async function(recorder) {
		const authorityKey = recorder.user(2);
		const published = await heldToken(recorder, [0], []);
		const authority = await certificate(authorityKey, authorityKey, 1, 3650);
		const { chains } = published;
		const stored = chains.append(await storeCertificate(recorder, chains, authorityKey, authority));
		await recorder.vote(0, [stored, await certificateGrant(recorder, published, authority)]);
	}),
	scenario('CE4', 'a token that admits a certificate\'s holders refuses a recipient without one, and admits one that holds it', {}, async function(recorder) {
		const { token, chains } = await certifiedHolders(recorder, [0], [{ holder: recorder.user(1), days: 3650 }]);
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(0), { to: recorder.representative(1), token })]);
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(0), { to: recorder.user(1), token })]);
	}),
	scenario('CE5', 'a certificate ACL admits a holder while the holder\'s certificate is valid, and refuses it once that certificate has expired, while still admitting a holder whose certificate is valid', {}, async function(recorder) {
		const [expiring, lasting] = [recorder.user(1), recorder.representative(2)];
		const { token, chains } = await certifiedHolders(recorder, [0, 1], [{ holder: expiring, days: 365 }, { holder: lasting, days: 3650 }]);
		await recorder.vote(0, [await sendAfter(recorder, chains, recorder.user(0), { to: expiring, token })]);
		recorder.advance(400 * DAY);
		await recorder.vote(1, [await sendAfter(recorder, chains, recorder.user(0), { to: expiring, token })]);
		await recorder.vote(1, [await sendAfter(recorder, chains, recorder.user(0), { to: lasting, token })]);
	}),
	scenario('OP1', 'a TOKEN_ADMIN_MODIFY_BALANCE, signed by the token\'s owner, is refused as unsupported', {}, async function(recorder) {
		await recorder.addGenesis(0);
		await recorder.vote(0, [await modifyBalance(recorder, recorder.network.trustedSigner)]);
	}),
	scenario('OP4', 'delegating to an account that is no representative and has no weight gets a temporary vote', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const account = recorder.user(0);
		await recorder.vote(0, [await setRepresentativeBlock({ account, representative: recorder.user(1), previous: recorder.genesisHead(account), network: recorder.network.network })]);
	}),
	scenario('TR1', 'on an empty ledger, the trusted root\'s opening block for the base token needs no permission', {}, async function(recorder) {
		await recorder.vote(0, [await baseTokenOpening(recorder, recorder.network.trustedSigner)]);
	}),
	scenario('TR2', 'on an empty ledger, the same opening block signed by another key is refused', {}, async function(recorder) {
		await recorder.vote(0, [await baseTokenOpening(recorder, recorder.user(0))]);
	}),
	/*
	 * A permanent request validates the ledger outcome again only when its
	 * blocks include a fee block.
	 * [Keeta TS] index.js:69324-69330
	 */
	scenario('R1', 'a permanent request without a fee block is given after the recipient lost its ACCESS', {}, async function(recorder) {
		await revokedBetweenVotes(recorder, false);
	}),
	scenario('R2', 'a permanent request with a fee block is refused after the recipient lost its ACCESS, and given by a node that has not seen the loss', CHARGING, async function(recorder) {
		await revokedBetweenVotes(recorder, true);
	}),
	scenario('EO12', 'an unsupported operation and a negative amount, each signed by a key without rights, are refused for the operation before the permissions', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const [victim, thief] = [recorder.user(0), recorder.user(1)];
		await recorder.vote(0, [await modifyBalance(recorder, thief)]);
		await recorder.vote(0, [await sendBlock({
			from: victim,
			signer: thief,
			to: thief,
			amount: -1n,
			token: recorder.network.baseToken,
			previous: recorder.genesisHead(victim),
			network: recorder.network.network,
			date: new Date(NEGATIVE_AMOUNTS_REFUSED_FROM.getTime() - 1)
		})]);
	}),
	scenario('EO13', 'a second owner added by a key without rights is refused for the permissions before the owner count', {}, async function(recorder) {
		const published = await heldToken(recorder, [0], ['ACCESS']);
		await recorder.vote(0, [await operationsBlock({
			account: published.token,
			signer: recorder.user(1),
			previous: published.chains.previous(published.token),
			network: recorder.network.network,
			operations: [{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, ...setOwner(recorder.user(2)) }]
		})]);
	}),
	scenario('EO14', 'an overspend and a second owner are refused for the owner count before the balance', {}, async function(recorder) {
		const published = await heldToken(recorder, [0], ['ACCESS']);
		const overspend = await sendAfter(recorder, published.chains, recorder.user(0), { to: recorder.user(1), amount: 401n });
		await recorder.vote(0, [overspend, await ownerChange(recorder, published, [setOwner(recorder.user(1))])]);
	}),
	scenario('EO15', 'an overspend and an ACL for a certificate nobody holds are refused for the certificate before the balance', {}, async function(recorder) {
		const authorityKey = recorder.user(2);
		const published = await heldToken(recorder, [0], []);
		const overspend = await sendAfter(recorder, published.chains, recorder.user(0), { to: recorder.user(1), amount: 401n });
		await recorder.vote(0, [overspend, await certificateGrant(recorder, published, await certificate(authorityKey, authorityKey, 1, 3650))]);
	}),
	/*
	 * The token's own effect, which carries the supply, exists from the
	 * start of its block; the ACL's effect is the certificate's, created by
	 * the operation, so the supply is checked first whatever the operation
	 * order.
	 * [Keeta TS] index.js:67425-67460, 68718-68724
	 */
	scenario('EO18', 'a token block that grants an ACL for a certificate nobody holds and mints past the maximum supply is refused for the supply', {}, async function(recorder) {
		await recorder.addGenesis(0);
		const chains = chainsOf(recorder);
		const owner = recorder.user(0);
		const authorityKey = recorder.user(2);
		const { token, blocks } = await issueToken(recorder, chains, owner, { supply: MAXIMUM_SUPPLY, defaultPermission: [] });
		await recorder.add(0, await confirmed(recorder, blocks));
		const authority = await certificate(authorityKey, authorityKey, 1, 3650);
		await recorder.vote(0, [await operationsBlock({
			account: token,
			signer: owner,
			previous: chains.previous(token),
			network: recorder.network.network,
			operations: [
				{ type: lib.Block.OperationType.MODIFY_PERMISSIONS, principal: { usingCertificate: true, certificateHash: authority.hash(), certificateAccount: authorityKey }, method: lib.Block.AdjustMethod.ADD, permissions: new lib.Permissions(['ACCESS']) },
				{ type: lib.Block.OperationType.TOKEN_ADMIN_SUPPLY, method: lib.Block.AdjustMethod.ADD, amount: 1n }
			]
		})]);
	})
];
