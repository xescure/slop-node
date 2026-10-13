import { describe, expect } from 'vitest';
import type { Account } from '@keetanetwork/keetanet-client/lib/account.js';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { FAUCET, perRepresentative, publishedStaple, REPRESENTATIVE_INDEXES, representativeOf, userOf } from './genesis.js';
import type { PerRepresentative, RepresentativeIndex, UserClient } from './genesis.js';
import { holding, until } from './harness.js';
import type { Devnet, DevnetNode } from './harness.js';
import { expectConvergedDumps, useDevnet } from './use-devnet.js';
import type { Timeout } from './use-devnet.js';

/*
 * A fault test funds its traffic, runs it through the fault and its repair,
 * and then waits for every staple on four nodes. While a representative is
 * unreachable, each publish of a client that knows it takes about 13 s, as
 * the client retries it; a node cut off catches up within the bootstrap
 * period of a minute.
 */
const FAULT: Timeout = { milliseconds: 300_000, reason: 'traffic through a fault and its repair, then every staple awaited on four nodes and four dumps' };

/** The accounts one run of traffic may use: a sender whose publish fails is not used again. */
const SENDERS = 32;

/** Each sender's funds: many sends of one unit and their fees. */
const SENDER_FUNDS = 100_000n;

/** Senders publishing at once, so that a fault lands between and during publishes. */
const LANES = 2;

const RECEIVER = userOf(999);

/*
 * A vote's issue time may be up to a minute ahead of the clock that checks
 * it [Keeta TS] index.js:81525, 81805, and a representative votes on a block
 * dated within five minutes of its clock [Keeta TS] index.js:71221-71233.
 * Half a minute ahead is inside both, and far from either edge.
 */
const CLOCK_OFFSET_MILLISECONDS = 30_000;

/** How far a vote's issue time may stray from the others of its staple for the clock it was issued by. */
const VOTE_TIME_TOLERANCE_MILLISECONDS = 5_000;

/** As long as the harness waits for a staple: a node that missed it catches up within the bootstrap period of a minute. */
const SETTLE_MILLISECONDS = 90_000;

/** A node that is starting, or one cut off that is restarted, dials its peers within this. */
const ATTEMPT_MILLISECONDS = 30_000;

const devnet = useDevnet();

function keyOf(account: { readonly publicKeyString: { get(): string } }): string {
	return(account.publicKeyString.get());
}

function votedBy(staple: VoteStaple, index: RepresentativeIndex): boolean {
	const representative = keyOf(representativeOf(index));
	return(staple.votes.some(function(vote): boolean {
		return(keyOf(vote.issuer) === representative);
	}));
}

function lastBlockOf(staple: VoteStaple): string {
	const last = staple.blocks.at(-1);
	if (last === undefined) {
		throw(new Error(`staple ${staple.blocksHash.toString()} has no blocks`));
	}
	return(last.hash.toString());
}

/** What a run of traffic saw: every staple a publish reported confirmed, and why the others failed. */
type TrafficOutcome = {
	readonly confirmed: readonly VoteStaple[];
	readonly failures: readonly string[];
	/** What the clients logged, mostly retries of a representative that could not be reached. */
	readonly clientWarnings: number;
};

/**
 * Clients of the official SDK that know every representative, each sending
 * one unit at a time from a funded account of its own until stopped.
 *
 * The client publishes to one representative, and the others learn of the
 * staple over P2P some 15-30 ms later, sooner than the client asks for votes
 * on the account's next block; a representative that has not seen the staple
 * yet refuses to vote, and with a second one out the publish fails. So each
 * sender waits until the nodes the traffic can reach hold its staple before
 * it sends again. A sender whose publish fails may have left votes for a
 * block behind, so the lane goes on with a fresh one.
 */
class Traffic {
	readonly #network: Devnet;
	readonly #senders: Account[];
	readonly #confirmed: VoteStaple[] = [];
	readonly #failures: string[] = [];
	readonly #waiting = new Set<() => void>();
	readonly #unreached = new Set<RepresentativeIndex>();
	#lanes: Promise<void>[] = [];
	#clientWarnings = 0;
	#running = 0;
	#stopping = false;

	private constructor(network: Devnet, senders: Account[]) {
		this.#network = network;
		this.#senders = senders;
	}

	/** Funds the senders, from the first given, from the faucet in one staple, which every node then holds. */
	static async funded(network: Devnet, firstSender: number): Promise<Traffic> {
		const senders = Array.from({ length: SENDERS }, function(_unused, offset): Account {
			return(userOf(firstSender + offset));
		});
		const faucet = network.client(FAUCET);
		const funding = faucet.initBuilder();
		for (const sender of senders) {
			funding.send(sender, SENDER_FUNDS, faucet.baseToken);
		}
		await network.settled(publishedStaple(await faucet.publishBuilder(funding)), network.all);
		return(new Traffic(network, senders));
	}

	run(): this {
		this.#running = LANES;
		this.#lanes = Array.from({ length: LANES }, () => {
			return(this.#lane());
		});
		return(this);
	}

	/** The staples confirmed so far, oldest first. */
	get confirmed(): readonly VoteStaple[] {
		return(this.#confirmed);
	}

	/** Senders no longer wait for the node to hold their staples, while it cannot. */
	unreached(index: RepresentativeIndex): void {
		this.#unreached.add(index);
	}

	/** Resolves once the count of staples confirmed reaches the count given, and refuses if every lane has run out of senders. */
	confirmedCount(count: number): Promise<void> {
		return(new Promise<void>((resolve, reject) => {
			const check = (): void => {
				if (this.#confirmed.length >= count) {
					this.#waiting.delete(check);
					resolve();
					return;
				}
				if (this.#running === 0) {
					this.#waiting.delete(check);
					reject(new Error(`the traffic stopped at ${String(this.#confirmed.length)} confirmed staples, short of ${String(count)}; failures: ${this.#failures.join('; ')}`));
				}
			};
			this.#waiting.add(check);
			check();
		}));
	}

	/** Resolves once the count given more staples are confirmed than now. */
	confirmedMore(count: number): Promise<void> {
		return(this.confirmedCount(this.#confirmed.length + count));
	}

	async stop(): Promise<TrafficOutcome> {
		this.#stopping = true;
		await Promise.all(this.#lanes);
		return({ confirmed: [...this.#confirmed], failures: [...this.#failures], clientWarnings: this.#clientWarnings });
	}

	/*
	 * The client warns of every request it has retried for over 5 s
	 * [Keeta TS] index.js:60681-60685, which a representative that is down
	 * makes it do twice a second; the outcome of each publish is what is
	 * checked, so the warnings are only counted.
	 */
	readonly #countingLogger: UserClient['client']['logger'] = {
		warn: () => {
			this.#clientWarnings++;
		},
		error: () => {
			this.#clientWarnings++;
		},
		log: () => {
			this.#clientWarnings++;
		}
	};

	/** Read anew each time, as a lane stops at the next send after it is told to. */
	#stopped(): boolean {
		return(this.#stopping);
	}

	#notify(): void {
		for (const check of [...this.#waiting]) {
			check();
		}
	}

	/*
	 * Which nodes can be reached is read again on each poll, as a fault may
	 * take one down or bring one back while a sender waits.
	 */
	async #reachedHold(staple: VoteStaple): Promise<void> {
		const last = lastBlockOf(staple);
		await until({ milliseconds: SETTLE_MILLISECONDS, reason: `the nodes the traffic reaches to hold staple ${staple.blocksHash.toString()}` }, async () => {
			const held = await Promise.all(this.#reached().map(function(node): Promise<boolean> {
				return(node.holdsBlock(last));
			}));
			return(holding(!held.includes(false)));
		});
	}

	#reached(): DevnetNode[] {
		return(this.#network.running().filter((node): boolean => {
			return(!this.#unreached.has(node.index) && !this.#network.partitioned(node.index));
		}));
	}

	async #lane(): Promise<void> {
		try {
			for (;;) {
				const sender = this.#senders.shift();
				if (sender === undefined || this.#stopped()) {
					return;
				}
				const client: UserClient = this.#network.client(sender);
				client.client.logger = this.#countingLogger;
				try {
					while (!this.#stopped()) {
						const staple = publishedStaple(await client.send(RECEIVER, 1n, client.baseToken));
						this.#confirmed.push(staple);
						this.#notify();
						await this.#reachedHold(staple);
					}
				} catch (error: unknown) {
					this.#failures.push(String(error));
				}
			}
		} finally {
			this.#running--;
			this.#notify();
		}
	}
}

/**
 * The votes among the staples whose representative gave the same serial to
 * another vote: a representative never gives one twice.
 */
function repeatedSerials(staples: readonly VoteStaple[]): string[] {
	const seen = new Map<string, string>();
	const repeated: string[] = [];
	for (const staple of staples) {
		for (const vote of staple.votes) {
			const key = `${keyOf(vote.issuer)} ${vote.serial.toString()}`;
			const hash = vote.hash.toString();
			const earlier = seen.get(key);
			if (earlier !== undefined && earlier !== hash) {
				repeated.push(`${key}: ${earlier} and ${hash}`);
			}
			seen.set(key, hash);
		}
	}
	return(repeated);
}

/**
 * After a fault: every staple the traffic was told is confirmed is on every
 * node, the nodes' canonical states are equal, no representative gave one
 * serial to two votes, and every representative votes on the next staple.
 */
async function expectConverged(network: Devnet, outcome: TrafficOutcome): Promise<void> {
	for (const staple of outcome.confirmed) {
		await network.settled(staple, network.all);
	}
	await expectConvergedDumps(network);
	const confirmed = outcome.confirmed.map(function(staple): string {
		return(staple.blocksHash.toString());
	});
	for (const node of network.all) {
		const staples = await node.confirmedStaples();
		const held = new Set(staples.map(function(staple): string {
			return(staple.blocksHash.toString());
		}));
		const lost = confirmed.filter(function(hash): boolean {
			return(!held.has(hash));
		});
		expect({ node: node.index, lost, repeated: repeatedSerials(staples) }).toEqual({ node: node.index, lost: [], repeated: [] });
	}

	const faucet = network.client(FAUCET);
	const next = publishedStaple(await faucet.send(RECEIVER, 1n, faucet.baseToken));
	expect(REPRESENTATIVE_INDEXES.filter(function(index): boolean {
		return(votedBy(next, index));
	})).toEqual(REPRESENTATIVE_INDEXES);
	await network.settled(next, network.all);
	await expectConvergedDumps(network);
}

/** The staples confirmed after the count given, but those whose votes may have been asked for before it. */
function confirmedAfter(traffic: Traffic, count: number): readonly VoteStaple[] {
	return(traffic.confirmed.slice(count + LANES));
}

/** How far the representative's vote on the staple is dated after the latest of the others' votes. */
function voteLead(staple: VoteStaple, index: RepresentativeIndex): number {
	const representative = keyOf(representativeOf(index));
	let own: number | undefined;
	let others = Number.NEGATIVE_INFINITY;
	for (const vote of staple.votes) {
		const issued = vote.validityFrom.valueOf();
		if (keyOf(vote.issuer) === representative) {
			own = issued;
		} else {
			others = Math.max(others, issued);
		}
	}
	if (own === undefined) {
		throw(new Error(`representative ${String(index)} did not vote on ${staple.blocksHash.toString()}`));
	}
	return(own - others);
}

function refusalsOf(network: Devnet): PerRepresentative<number> {
	return(perRepresentative(function(index): number {
		return(network.nodes[index].proxy.refusals);
	}));
}

function report(fault: string, outcome: TrafficOutcome, detail: string): void {
	process.stderr.write(`fault ${fault}: ${String(outcome.confirmed.length)} staples confirmed, ${detail}, ${String(outcome.clientWarnings)} client warnings, ${String(outcome.failures.length)} publishes failed: ${JSON.stringify(outcome.failures)}\n`);
	expect(outcome.failures).toEqual([]);
}

describe('faults injected into the devnet under SDK traffic', function() {
	devnet.test('(a) a representative killed: the other three confirm, and it catches up once restarted', FAULT, async function(network) {
		const traffic = (await Traffic.funded(network, 1000)).run();
		await traffic.confirmedCount(2);

		await network.kill(3);
		const killedAt = traffic.confirmed.length;
		await traffic.confirmedMore(LANES + 2);
		const whileDown = confirmedAfter(traffic, killedAt);
		expect(whileDown.filter(function(staple): boolean {
			return(votedBy(staple, 3));
		})).toEqual([]);

		await network.restart(3);
		const restartedAt = traffic.confirmed.length;
		await traffic.confirmedMore(LANES + 2);
		expect(confirmedAfter(traffic, restartedAt).some(function(staple): boolean {
			return(votedBy(staple, 3));
		})).toBe(true);

		const outcome = await traffic.stop();
		await expectConverged(network, outcome);
		report('(a)', outcome, `${String(whileDown.length)} of them without the killed representative's vote`);
	});

	devnet.test('(b) every representative stopped and restarted in turn', FAULT, async function(network) {
		const traffic = (await Traffic.funded(network, 2000)).run();
		await traffic.confirmedCount(2);

		for (const index of REPRESENTATIVE_INDEXES) {
			await network.nodes[index].stop('SIGTERM');
			await network.restart(index);
			const restartedAt = traffic.confirmed.length;
			await traffic.confirmedMore(LANES + 1);
			expect({ index, voted: confirmedAfter(traffic, restartedAt).some(function(staple): boolean {
				return(votedBy(staple, index));
			}) }).toEqual({ index, voted: true });
		}

		const outcome = await traffic.stop();
		await expectConverged(network, outcome);
		report('(b)', outcome, 'through four restarts');
	});

	devnet.test('(d) a representative whose clock runs half a minute ahead', FAULT, async function(network) {
		const traffic = (await Traffic.funded(network, 3000)).run();
		await traffic.confirmedCount(2);

		const skewed = network.nodes[2];
		await skewed.stop('SIGTERM');
		skewed.setClock({ kind: 'offset', milliseconds: CLOCK_OFFSET_MILLISECONDS });
		await network.restart(2);
		const skewedAt = traffic.confirmed.length;
		await traffic.confirmedMore(LANES + 3);
		const voted = confirmedAfter(traffic, skewedAt).filter(function(staple): boolean {
			return(votedBy(staple, 2));
		});
		expect(voted.length).toBeGreaterThan(0);
		// Its votes are dated by its own clock, which the others accept.
		for (const staple of voted) {
			expect(Math.abs(voteLead(staple, 2) - CLOCK_OFFSET_MILLISECONDS)).toBeLessThan(VOTE_TIME_TOLERANCE_MILLISECONDS);
		}

		await skewed.stop('SIGTERM');
		skewed.setClock({ kind: 'host' });
		await network.restart(2);
		await traffic.confirmedMore(LANES);

		const outcome = await traffic.stop();
		await expectConverged(network, outcome);
		report('(d)', outcome, `${String(voted.length)} of them voted on by the representative ahead`);
	});

	devnet.test('(e) a representative\'s Postgres stopped and started again', FAULT, async function(network) {
		const traffic = (await Traffic.funded(network, 4000)).run();
		await traffic.confirmedCount(2);

		const node = network.nodes[1];
		traffic.unreached(1);
		await node.stopDatabase();
		const stoppedAt = traffic.confirmed.length;
		await traffic.confirmedMore(LANES + 2);
		const withoutDatabase = confirmedAfter(traffic, stoppedAt);
		expect(withoutDatabase.filter(function(staple): boolean {
			return(votedBy(staple, 1));
		})).toEqual([]);

		await node.startDatabase();
		expect(node.exit).toBeUndefined();
		// The node reads its ledger again once its Postgres is back.
		await until({ milliseconds: ATTEMPT_MILLISECONDS, reason: 'node 1 to read its ledger again' }, async function() {
			return(holding(await node.holdsGenesis()));
		});
		const restoredAt = traffic.confirmed.length;
		await traffic.confirmedMore(LANES + 2);
		expect(confirmedAfter(traffic, restoredAt).some(function(staple): boolean {
			return(votedBy(staple, 1));
		})).toBe(true);

		const outcome = await traffic.stop();
		await expectConverged(network, outcome);
		report('(e)', outcome, `${String(withoutDatabase.length)} of them while the representative's Postgres was down`);
	});

	devnet.test('(c) a representative cut off in both directions sees nothing until healed, then converges', FAULT, async function(network) {
		const traffic = await Traffic.funded(network, 5000);
		const cut = network.nodes[3];
		const others = network.all.filter(function(node): boolean {
			return(node.index !== cut.index);
		});

		await network.partition(3);
		const refusedBefore = refusalsOf(network);
		const before = await cut.dump();
		traffic.run();
		await traffic.confirmedCount(LANES + 2);

		/*
		 * A node dials its manual peers and bootstraps from them as it starts,
		 * so starting it again while it is cut off has it try both, through
		 * the other nodes' proxies, which refuse its process.
		 */
		await cut.stop('SIGTERM');
		await network.restart(3);
		await until({ milliseconds: ATTEMPT_MILLISECONDS, reason: 'the cut-off node to try to reach every other node' }, function() {
			const refused = refusalsOf(network);
			return(Promise.resolve(holding(others.every(function(node): boolean {
				return(refused[node.index] > refusedBefore[node.index]);
			}))));
		});
		await traffic.confirmedMore(LANES);
		const outcome = await traffic.stop();

		// The others and the clients tried to reach it, and its proxy refused them.
		expect(cut.proxy.refusals).toBeGreaterThan(refusedBefore[3]);
		expect(outcome.confirmed.filter(function(staple): boolean {
			return(votedBy(staple, 3));
		})).toEqual([]);
		for (const staple of outcome.confirmed) {
			expect(await cut.holdsBlock(lastBlockOf(staple))).toBe(false);
		}
		expect(await cut.dump()).toBe(before);

		await network.heal(3);
		await expectConverged(network, outcome);
		report('(c)', outcome, `none of them held by the cut-off node until healed; refusals ${JSON.stringify(refusedBefore)} before, ${JSON.stringify(refusalsOf(network))} after`);
	});
});
