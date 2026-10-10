import { describe, expect, test } from 'vitest';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { confirmedStaple, sendBlock } from '../../../testing/blocks.js';
import { advanceClock } from '../../../testing/network.js';
import type { StagedStaple } from '../stage.js';
import { headOf, requireAt, useFixtures } from './support.js';
import type { NetworkFixture } from './support.js';
import type { DriverUnderTest } from './types.js';

/** The staple as a bootstrap stages it, its earliest and latest votes moved as given, which nothing in the stage checks against its bytes. */
function staged(staple: VoteStaple, firstVote: number, lastVote: number = firstVote): StagedStaple {
	return({ key: staple.blocksHash.toString(), bytes: staple.toBytes(), firstVote: new Date(firstVote), lastVote: new Date(lastVote) });
}

function keysOf(staples: readonly StagedStaple[]): string[] {
	return(staples.map(function(staple): string {
		return(staple.key);
	}));
}

function bytesOf(staples: readonly VoteStaple[]): number {
	let bytes = 0;
	for (const staple of staples) {
		bytes += staple.toBytes().byteLength;
	}
	return(bytes);
}

export function defineStageCases(driver: DriverUnderTest): void {
	describe('bootstrap stage', function() {
		const startNetwork = useFixtures(driver);

		/** Three staples of the network's: genesis and two sends. */
		async function threeStaples({ network }: NetworkFixture): Promise<readonly [VoteStaple, VoteStaple, VoteStaple]> {
			const user = requireAt(network.users, 0);
			const other = requireAt(network.users, 1);
			advanceClock(1000);
			const first = await confirmedStaple([await sendBlock({ from: user, previous: headOf(network.genesis, user), to: other, amount: 1n, token: network.baseToken, network: network.network })], network.representatives);
			const second = await confirmedStaple([await sendBlock({ from: other, previous: headOf(network.genesis, other), to: user, amount: 1n, token: network.baseToken, network: network.network })], network.representatives);
			return([network.genesis, first, second]);
		}

		test('keeps each staple once, as the bytes it was given, and counts them and their bytes', async function() {
			const fixture = await startNetwork();
			const stage = fixture.storage.bootstrapStage();
			const [genesis, first, second] = await threeStaples(fixture);

			expect(await stage.put([staged(genesis, 1000), staged(first, 2000)])).toEqual({ staples: 2, bytes: bytesOf([genesis, first]) });
			expect(await stage.put([staged(first, 2000), staged(second, 3000)])).toEqual({ staples: 1, bytes: bytesOf([second]) });

			expect(await stage.counts()).toEqual({ staples: 3, bytes: bytesOf([genesis, first, second]) });
			expect(await stage.holds(first.blocksHash.toString())).toBe(true);
			const [kept] = await stage.firstBefore(new Date(2500), 1);
			expect(kept).toEqual(staged(genesis, 1000));
			expect(Buffer.from(kept?.bytes ?? new ArrayBuffer(0))).toEqual(Buffer.from(genesis.toBytes()));
		});

		test('lists the staples whose first vote was made before a moment by their first votes, then their keys, as many as asked for, but those left out', async function() {
			const fixture = await startNetwork();
			const stage = fixture.storage.bootstrapStage();
			const [genesis, first, second] = await threeStaples(fixture);
			await stage.put([staged(second, 1000), staged(genesis, 3000), staged(first, 1000)]);
			const tied = keysOf([staged(first, 1000), staged(second, 1000)]).sort();

			expect(keysOf(await stage.firstBefore(new Date(3001), 10))).toEqual([...tied, genesis.blocksHash.toString()]);
			expect(keysOf(await stage.firstBefore(new Date(3000), 10))).toEqual(tied);
			expect(keysOf(await stage.firstBefore(new Date(3001), 1))).toEqual(tied.slice(0, 1));
			expect(await stage.firstBefore(new Date(1000), 10)).toEqual([]);
			expect(keysOf(await stage.firstBefore(new Date(3001), 2, tied.slice(0, 1)))).toEqual([...tied.slice(1), genesis.blocksHash.toString()]);
			expect(keysOf(await stage.firstBefore(new Date(3001), 10, [genesis.blocksHash.toString(), ...tied]))).toEqual([]);
		});

		test('lists the staples with a vote made at or after a moment by their last votes, for a filter to name', async function() {
			const fixture = await startNetwork();
			const stage = fixture.storage.bootstrapStage();
			const [genesis, first, second] = await threeStaples(fixture);
			await stage.put([staged(genesis, 1000, 5000), staged(first, 2000, 2500), staged(second, 3000, 4000)]);

			expect(keysOf(await stage.lastFrom(new Date(2500), 10))).toEqual(keysOf([staged(first, 0), staged(second, 0), staged(genesis, 0)]));
			expect(keysOf(await stage.lastFrom(new Date(4001), 10))).toEqual([genesis.blocksHash.toString()]);
			expect(keysOf(await stage.lastFrom(new Date(0), 2))).toEqual(keysOf([staged(first, 0), staged(second, 0)]));
		});

		test('drops the staples it is told, and counts what it dropped', async function() {
			const fixture = await startNetwork();
			const stage = fixture.storage.bootstrapStage();
			const [genesis, first, second] = await threeStaples(fixture);
			await stage.put([staged(genesis, 1000), staged(first, 2000)]);

			expect(await stage.remove([first.blocksHash.toString(), second.blocksHash.toString()])).toEqual({ staples: 1, bytes: bytesOf([first]) });

			expect(await stage.counts()).toEqual({ staples: 1, bytes: bytesOf([genesis]) });
			expect(await stage.holds(first.blocksHash.toString())).toBe(false);
			expect(await stage.remove([])).toEqual({ staples: 0, bytes: 0 });
		});

		test('keeps what it staged apart from the ledger, which adds none of it', async function() {
			const fixture = await startNetwork();
			const [genesis] = await threeStaples(fixture);
			await fixture.storage.bootstrapStage().put([staged(genesis, 1000)]);

			expect(await fixture.ledger.getVoteStaplesAfter(new Date(0), 10)).toEqual([]);
		});

		test('orders staples of one moment by their keys, whatever order they were put in, and drops exactly the one it is told', async function() {
			const fixture = await startNetwork();
			const { network } = fixture;
			const stage = fixture.storage.bootstrapStage();
			const user = requireAt(network.users, 0);
			const staples = [network.genesis];
			for (const amount of [1n, 2n, 3n, 4n]) {
				staples.push(await confirmedStaple([await sendBlock({ from: user, previous: headOf(network.genesis, user), to: requireAt(network.users, 1), amount, token: network.baseToken, network: network.network })], network.representatives));
			}
			const sorted = keysOf(staples.map(function(staple): StagedStaple {
				return(staged(staple, 0));
			})).sort();
			// Neither in key order nor against it.
			const order = [2, 0, 4, 1, 3].map(function(rank): VoteStaple {
				const staple = staples.find(function(candidate): boolean {
					return(candidate.blocksHash.toString() === sorted[rank]);
				});
				if (staple === undefined) {
					throw(new Error(`no staple of rank ${String(rank)}`));
				}
				return(staple);
			});
			for (const staple of order) {
				await stage.put([staged(staple, 1000)]);
			}
			const listed = async function(): Promise<{ readonly first: string[]; readonly last: string[] }> {
				return({ first: keysOf(await stage.firstBefore(new Date(1001), 10)), last: keysOf(await stage.lastFrom(new Date(1000), 10)) });
			};

			expect(await listed()).toEqual({ first: sorted, last: sorted });

			const middle = sorted[2] ?? '';
			expect((await stage.remove([middle])).staples).toBe(1);
			const kept = sorted.filter(function(key): boolean {
				return(key !== middle);
			});
			expect(await listed()).toEqual({ first: kept, last: kept });

			// Staged again, it is listed once.
			await stage.put(order.filter(function(staple): boolean {
				return(staple.blocksHash.toString() === middle);
			}).map(function(staple): StagedStaple {
				return(staged(staple, 1000));
			}));
			expect(await listed()).toEqual({ first: sorted, last: sorted });
			expect((await stage.counts()).staples).toBe(sorted.length);
		});
	});
}
