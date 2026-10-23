import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import type { LedgerConfig } from '@keetanetwork/keetanet-client/lib/ledger/index.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import type { NetworkSelection } from './config.js';

export type AdmitWithoutQuorum = NonNullable<LedgerConfig['admitWithoutQuorum']>;

/** The staples a network names to add without a quorum, by alias; main can name none. */
type AdmittedStaples = { readonly [network in Exclude<Networks, 'main'>]?: ReadonlySet<string> } & { readonly main?: never };

/**
 * Staples Keeta's representatives added although their votes lacked a
 * quorum, which no 0.18.8 ledger replaying the network adds
 * [Keeta TS] index.js:70433-70436, 70776-70795, each by its hash, which
 * covers all its votes and blocks.
 *
 * test: on 2026-10-15 a delegation gave
 * keeta_aabmh4q7ldm7t7npaq62bbsb47dh5pcxp4w5yddf4vn2fd2i2bmb6nnkuqydoba about
 * 270 of about 290 KTA of delegated weight, and its vote alone added a staple.
 * Between 18:10 and 18:22 UTC on 2026-10-16 these five carry only the vote of
 * keeta_aabf7dz5asq2n2lrldct33x2ww65cophxp7egfiixbb7tbyat5r3kcbcez7ftpi,
 * which then held about 20 KTA; the last mints 1e14 KTA delegated to it.
 */
const ADMITTED_WITHOUT_QUORUM: AdmittedStaples = {
	test: new Set([
		'A39716F24444EA7B4DA74E118C43AC70C4F55017110D47954CF9C8782429E23A',
		'720612A8A0FF2EC5593900883401AB0FE644472BAE948E29241D36F5DE90F157',
		'B64351D3AE902D8D09BB88589DEE09272B5EA7947D8169864D35AF9D64843CB6',
		'DF8928EEEB96890CF85F152861B90627B34D72AC8B24A890FF63A91046168EA4',
		'9955A6F61FD43E72A528337D87A7A44E942B91FD09F45C2F67FB9F38A314F714'
	])
};

/** The staples of the network that its ledger adds although their votes lack a quorum, or undefined when there are none. */
export function admittedWithoutQuorum(network: NetworkSelection): AdmitWithoutQuorum | undefined {
	let staples: ReadonlySet<string> | undefined;
	if (network.kind === 'known') {
		staples = ADMITTED_WITHOUT_QUORUM[network.alias];
	}
	if (staples === undefined) {
		return(undefined);
	}
	return(function(staple: VoteStaple): boolean {
		return(staples.has(staple.hash.toString()));
	});
}
