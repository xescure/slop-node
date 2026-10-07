import { expect } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Account, GenericAccount, MultisigAddress, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { certificateFor, certificateIssuedBy, ChainCursor, requireAt } from '../ledger/storage/suite/support.js';
import { confirmedStaple, createMultisigBlock, createTokenBlock, manageCertificateBlock, sendBlock, tokenSupplyBlock } from './blocks.js';
import { postJSON } from './local-node.js';
import type { RunningLocalNode } from './local-node.js';
import { TEST_NETWORK_SEEDS } from './network.js';

const lib = KeetaNet.lib;

/** What the network holds once it is populated, for naming in requests. */
export type PopulatedNode = RunningLocalNode & {
	readonly representative: Account;
	/** Funded at genesis; it owns the token and the multisig, holds the certificate and has a block pending. */
	readonly user: Account;
	/** First touched by the user's sends, and a signer of the multisig. */
	readonly other: Account;
	/** No block names it. */
	readonly stranger: Account;
	readonly token: TokenAddress;
	readonly multisig: MultisigAddress;
	/** The user's certificate, which has intermediates. */
	readonly certificateHash: string;
	/** The idempotent key of the user's send, base64 encoded. */
	readonly idempotentKey: string;
	/** The block the user sent with the idempotent key. */
	readonly keyedSend: Block;
	/** Every staple published after genesis, oldest first. */
	readonly published: readonly VoteStaple[];
	/** The user's next block, which the node voted for but nobody published. */
	readonly pending: Block;
};

/** The client sends every block, vote, quote and staple as the base64 of its bytes. */
export function base64(bytes: ArrayBuffer): string {
	return(Buffer.from(bytes).toString('base64'));
}

/** Accounts that only sign certificates or receive tokens, derived past the network's own. */
function extraAccount(index: number): Account {
	return(lib.Account.fromSeed(TEST_NETWORK_SEEDS.user, index));
}

async function publish(running: RunningLocalNode, staple: VoteStaple): Promise<void> {
	const answer = await postJSON(running, '/node/publish', { votesAndBlocks: base64(staple.toBytes()) });
	expect(answer.body).toEqual({ publish: true });
}

/**
 * Publishes, through the API, staples that give the network a token with a
 * supply and a holder, sends with an idempotent key, a certificate with
 * intermediates and a multisig with its signers' permissions, and then asks
 * the node for a vote on one more block, which leaves that block pending.
 */
export async function populate(running: RunningLocalNode): Promise<PopulatedNode> {
	const { network } = running;
	const representative = requireAt(network.representatives, 0);
	const user = requireAt(network.users, 0);
	const other = extraAccount(1);
	const middle = extraAccount(2);
	const root = extraAccount(3);
	const stranger = extraAccount(4);
	const cursor = new ChainCursor(network.genesis);
	const context = { network: network.network };

	const created = await createTokenBlock({ owner: user, previous: cursor.previous(user), ...context });
	const { token } = created;
	cursor.append(created.block);
	const minted = cursor.append(await tokenSupplyBlock({ owner: user, token, amount: 500n, previous: cursor.previous(token), ...context }));
	const distributed = cursor.append(await sendBlock({ from: token, signer: user, to: other, amount: 100n, token, previous: cursor.previous(token), ...context }));
	const tokenStaple = await confirmedStaple([created.block, minted, distributed], [representative]);

	const idempotent = btoa('contract-send');
	const keyedSend = cursor.append(await sendBlock({ from: user, to: other, amount: 5n, token: network.baseToken, previous: cursor.previous(user), idempotent, ...context }));
	const sendStaple = await confirmedStaple([keyedSend], [representative]);

	// Upstream accepts intermediates only when each one leads to the certificate.
	const certificate = await certificateIssuedBy(middle, user, 3, false);
	const intermediates = new lib.Utils.Certificate.CertificateBundle([await certificateIssuedBy(root, middle, 4, true), await certificateFor(root, 5)]);
	const certified = cursor.append(await manageCertificateBlock({ account: user, method: lib.Block.AdjustMethod.ADD, certificateOrHash: certificate, intermediateCertificates: intermediates, previous: cursor.previous(user), ...context }));
	const certificateStaple = await confirmedStaple([certified], [representative]);

	const multisigCreated = await createMultisigBlock({ owner: user, signers: [user, other], quorum: 2n, previous: cursor.previous(user), ...context });
	cursor.append(multisigCreated.block);
	const multisigStaple = await confirmedStaple([multisigCreated.block], [representative]);

	const published = [tokenStaple, sendStaple, certificateStaple, multisigStaple];
	for (const staple of published) {
		await publish(running, staple);
	}

	const pending = await sendBlock({ from: user, to: other, amount: 1n, token: network.baseToken, previous: cursor.previous(user), ...context });
	const voted = await postJSON(running, '/vote', { blocks: [base64(pending.toBytes())] });
	expect(voted.status).toBe(200);

	return({
		...running,
		representative,
		user,
		other,
		stranger,
		token,
		multisig: multisigCreated.multisig,
		certificateHash: certificate.hash().toString(),
		idempotentKey: idempotent,
		keyedSend,
		published,
		pending
	});
}

/** The account's public key string, as a path names it. */
export function keyOf(account: GenericAccount): string {
	return(account.publicKeyString.get());
}
